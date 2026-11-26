# How Orbik runs agents

There is exactly **one** way an agent runs: the agents worker executes it, and the reasoning goes
to the install's reasoning provider — Anthropic with `ORBIK_ANTHROPIC_API_KEY`, or OpenAI with
`ORBIK_OPENAI_API_KEY`, as `ORBIK_AI_PROVIDER` chooses. The embeddings behind the retrieval index go
to OpenAI with `ORBIK_OPENAI_API_KEY` either way, because Anthropic has no embeddings endpoint.

A user never picks a provider or a temperature, and never supplies a key or a login of their own.
Those are Orbik's problem. What a user sees is a **Run** button. The one choice a person has is how
capable, and so how dear, a model is: a **tier** of the install's model catalog, picked for an Ask
question or as the knowledge base agent's Model setting ([Models](#models-the-catalog-tiers-and-routes)).

## The shape

```
              ORBIK AGENT  (a definition, not a program)
                     │
                     ▼
               Run Dispatcher
                     │
                     ▼
               agents worker
          ┌──────────┴───────────┐
          ▼                      ▼
  names a plain-code        everything else
  runtime                        │
  (`design-system`)              ▼
          │                Orbik Model Router
          │                      │
          ▼                ┌─────┴─────┐
    plain-code job         ▼           ▼
   (no model decides)  Anthropic     OpenAI
                      (one of the two, as ORBIK_AI_PROVIDER says)
```

A run is created by the API (`POST /runs`) or by the scheduler, queued, picked up by the run
dispatcher (`agents/src/ai/runDispatcher.js`) and executed by the one handler in
`agents/src/ai/executeRun.js`. Its status is one of `queued`, `running`, `succeeded`, `failed`,
`cancelled`, and nothing else.

## Packages

| Package | Owns | Depends on Mongo? |
|---|---|---|
| `@orbik/protocol` | Run states, agent definitions, agent events, validation primitives and the model catalog: the contract the API and the agents worker share | **No**: it has no dependencies at all |
| `@orbik/agent-definitions` | Every agent's definition: instructions, tool allow-list, schemas. The only copy; the API reads it for the catalog and the worker to execute a run. A deployment's extensions may add agents to it at startup (`extendAgentCatalog`; [extensions.md](extensions.md#agents)) | Not itself; it imports `@orbik/tools` to check each tool a definition names |
| `@orbik/tools` | The deterministic tool registry, scoped to one workspace; and the MCP naming (`toolAlias`, `ORBIK_MCP_SERVER`) the API's MCP server uses | Yes |
| `@orbik/retrieval` | The retrieval index and the embeddings module | Yes |
| `agents/src/ai/` | The run handler, the model runtime, model router, provider adapters, price table, the daily catalog check | Yes |

## Four decisions worth knowing

**An agent is a definition, not a program.** A definition holds instructions, a tool allow-list,
and input/output schemas. They live in `packages/agent-definitions/src/` and nowhere else: no
database holds a copy, and nothing has to be published. Improving an agent's instructions is an
edit to its definition; other code changes only when the *runtime or tools* change. The API and
the worker each read the definitions in their own process, so both have to be running the release
a change shipped in. A deployment's extensions can add agents of their own, with their tools and
plain-code runtimes; each process puts them in its catalog at startup and checks them as it checks
these ([extensions.md § "Agents"](extensions.md#agents)).

**A definition says what the executing process must have.** `runtimeRequirements` is part of the
definition, and it is the only thing the worker reads to pick a runtime. A requirement can name a
**plain-code runtime** — code in the worker that executes the definition itself, with no model
deciding what happens. The Design system agent requires `design-system`, so the worker executes it
with the code that renders the site in Chrome and samples what was rendered; it is the one such
runtime today. The table of those runtimes is `PLAIN_CODE_RUNTIMES` in `agents/src/ai/index.js`,
keyed by the requirement, and adding a plain-code agent is one entry in it (an extension adds one
with `host.addRuntime`, beside the table rather than in it); the run handler
(`chooseRuntime` in `agents/src/ai/executeRun.js`) has no agent's name in it. Every definition that
names none of them goes to the model runtime (`agents/src/ai/model/modelRuntime.js`), which asks
the model router for a route and calls the provider adapter
(`agents/src/ai/model/providers/anthropic.js` or `openai.js`). See [design-system.md](design-system.md).

An agent can also be started by an event rather than by a person or a schedule: the scheduler's
outbox loop (`agents/src/ai/outboxScheduler.js`) reads the crawler's event outbox (`agent_events`)
and queues a run for each agent listed in `OUTBOX_CONSUMERS` whose event has arrived. No agent in
this release is started that way, so the list is empty and each pass returns at once; the loop is
where such an agent is added.

**A run records the version it followed; the version selects nothing.** There is one definition
per agent, the one in the running release, and a run executes it. `version` on a definition is a
label copied onto the run and onto each AI call, so a result can be traced to the wording that
produced it: raise it when the instructions change in a way worth telling apart afterwards.

**Deterministic code runs before AI does.** The crawler has already been to the site, respected its
robots.txt, and recorded what it found. `crawl.summarize` answers "how many pages are broken"
exactly, in one query, for nothing. The model's job starts where deterministic code runs out:
deciding which true facts matter, and saying why.

A plain-code agent takes that to its end: everything it reports is counted by code, and the most
it asks of a model is a short piece of prose about what the counts probably mean. It asks through
one helper, `createShortTextWriter` (`agents/src/ai/model/shortText.js`): a single bounded call —
no tools, a fixed output ceiling, a timeout — routed by capability like any other and written to
the AI call log by the provider adapter. The helper never throws. It returns the text, or
`{skipped: true, reason}` when no provider is configured (`PROVIDER_NOT_CONFIGURED`), or
`{failed: true, reason}`, and the agent stores whichever it got beside work that was already
complete. Every plain-code runtime is handed it as `writeText`; the one in this release asks for
structured answers instead, below.

It has a sibling for the plain-code agent whose question is not "say this in two sentences" but
"here is what was measured, and a picture of it: which of these greys is the border colour?".
`createStructuredWriter` (`agents/src/ai/model/structured.js`) is the same bounded call with two
differences: the reply is JSON matching a schema, asked for through the provider's structured
output so the caller gets an object or a stated failure and never prose to dig one out of; and the
question may carry pictures. It returns `{value, model, usage}`, `{skipped: true, reason}` or
`{failed: true, reason}`, and never throws. The Design system agent makes two such calls a
derivation — the visual system from the observed record and screenshots, the graphics language
from a sheet of the site's imagery — and stores what it observed whether or not either answers.

## Two keys, one reasoning provider

`ORBIK_OPENAI_API_KEY` is the one key the docs call required: it pays for the embeddings behind the
retrieval index. Every reasoning call — agent runs, the Library chat, and the short texts and
structured answers plain-code agents ask for — goes to one provider, chosen by `ORBIK_AI_PROVIDER`:

| `ORBIK_AI_PROVIDER` | Reasoning provider |
|---|---|
| `anthropic` | Anthropic, with `ORBIK_ANTHROPIC_API_KEY` |
| `openai` | OpenAI, with `ORBIK_OPENAI_API_KEY` — the embeddings' key pays for everything |
| unset or `auto` | Anthropic when `ORBIK_ANTHROPIC_API_KEY` is set, otherwise OpenAI |

So an install with only the OpenAI key runs every feature on it, and one with both keys keeps
reasoning on Claude unless told otherwise. A provider named without its key is not a start-up
error: the worker starts and says no AI provider is configured, as it does with no key at all. The
worker logs the choice at start (`ai.provider`, with the provider and whether its key is set, never
the key). The keys and the setting are read from `agents/.env`. In `backend/.env` only the OpenAI
key matters, and it pays for one thing: the embedding an MCP `content_search` needs. The API never
calls a reasoning model. Every reasoning call goes through the worker.

The web app cannot see either file, so it asks the API. At start the worker also records the two
answers — whether the reasoning provider's key is set, and whether the embedding key is — in
`system_state` (`_id: "ai"`: `provider`, `reasoning`, `embeddings`, `recordedAt`; never a key), and
`GET /v1/edition` reports them as `ai`:

| Field | Means |
|---|---|
| `ai.reasoning` | The reasoning provider has its key: agent runs, the Ask chat and plain-code agents' short texts can be served. As the worker last recorded it; left out until a worker has started with this release |
| `ai.search` | The embedding key is set both in the worker, which builds the index and searches it for the chat, and in the API, which searches it for the Library page and MCP clients |

The API reads the record at most every 15 seconds, so a worker restarted with a new key shows within
that. A page reads `ai.reasoning === false` to say, before a person presses **Run now**, that the
run would fail, and disables what needs a model.

Changing the provider is changing `ORBIK_AI_PROVIDER` and restarting the worker and the scheduler.
`synthesisEnabled` (`agents/src/config/env.js`), which decides whether the Library scheduler starts
write runs, follows the provider the chosen route table's `long-context` row names, so it moves with
the setting.

A model run is stopped after 30 round trips, and a long-context run after 60
(`agents/src/ai/model/modelRuntime.js`): the Library's write run rewrites the subject tree file by
file, and its first run under the lower cap was stopped with the entry map not yet reached.

The adapter (`agents/src/ai/model/providers/anthropic.js`) calls the Messages API through the
Anthropic SDK, streamed. It thinks adaptively at the route's effort, hands each block of the
model's reply — its thinking included — back to it unchanged on the next turn of a tool loop, and
declares each Orbik tool under its MCP alias (`crawl_listPages` for `crawl.listPages`), because a
tool name there cannot carry a dot. A tool loop asks the provider to cache the conversation, so
each turn reads the previous ones back at a fraction of the input price; a one-shot call does not,
because it would pay the cache-write premium for nothing. A request to Claude Opus 5.5 or Claude
Sonnet 5.5 carries `fallbacks: "default"`: when the model's safety classifiers decline it, the
provider re-runs it on another model inside the same call, and the call log names the model that
answered. Claude Haiku 5.5 has no such fallback. A request still declined fails as
`PROVIDER_REFUSED`.

A turn may also carry pictures and ask for its answer in a fixed shape. A message part
`{type: "image", mimeType, data}` is sent as an image the model sees, and `format: {name, schema}`
asks for JSON matching that schema through structured output. Neither is used by the tool loop.
An image's bytes are kept out of the AI call log: the prompt records what kind of image it was and
how large.

Structured output accepts a subset of JSON Schema. What it cannot enforce — a longest array, a
pattern — the SDK moves into the field's description, and the caller's own check of the reply
enforces it. A schema with more than 16 fields of a union type (a nullable field is one) is not
compiled at all: the Design system agent's visual system has twenty, so for it the adapter puts the
schema in the instructions instead, hands back the outermost object of the reply, and relies on
`parseVisualSystem` to refuse a reply that does not fit.

An image part may also say how closely the provider should look (`detail`) and where it came from
(`reference`: an address, a hash, a size). Neither is sent to Anthropic, which has no `detail`
setting; the reference is what the call log keeps in place of the bytes, so a call that showed a
model an image names which image it was.

The OpenAI adapter (`providers/openai.js`) calls the Responses API with `fetch`, stores nothing at
the provider, and hands the model's encrypted reasoning back between turns; with `detail` it is
told how closely to look (`low` fits the image into 512 pixels a side, `high` into at most 2,500
patches of 32 pixels). A PDF (`{type: "document"}`, the brand guide the brand chat reads) is sent
as an `input_file`, and a tool that hands back a picture or a PDF has it sent in the function's
output as the part it is, so the brand chat reads an uploaded file on either provider.

Both keys are optional at start-up, on purpose: a worker without them still starts, crawls and
copies every page into the Library. Without the OpenAI key nothing is indexed, and search and chat say the index is
not configured. Without the reasoning provider's key, what it cannot do, it says —

- the AI agents still register, and a run fails the first time one is tried, reporting that no AI
  provider is configured;
- every site is still mirrored into its Library's source layer, which calls no model; the write run
  that would build the knowledge base from it is not started, and the Library scheduler's reason
  is `PROVIDER_NOT_CONFIGURED`;
- the Design system agent still renders the site and stores what it observed and every image it
  collected, and records that the proposal was skipped, with the same reason. A system already
  stored is left as it was.

A key the provider rejects is reported the same way, and the message never hints at the key's value
or shape.

## Models: the catalog, tiers and routes

Which models an install offers, what each is called and what it costs are one file, the **model
catalog**: `packages/protocol/src/modelCatalog.js` (`MODEL_CATALOG` in `@orbik/protocol`, a package
with no dependencies that the API and the agents processes both import). The worker's router reads
it for which model serves a call, its price table for what the call cost, and the API for what the
web app offers (`GET /v1/ai/models`), so adding a model is one reviewed edit. A catalog that breaks
its own rules (a tier naming a model it does not price, tiers out of order) stops every process
that imports it, at start.

**A choice is a tier, never a model.** The tier keys are `large`, `medium` and `small`
(`MODEL_TIERS`), most capable first, and they name no provider and no model. Each provider lists its
tiers in the catalog, one model each; what is stored anywhere (an agent's setup, a run, a browser)
is a key, so when a newer model replaces a tier's model in the catalog every stored choice follows
it with no migration. The default is always the top tier. A provider may offer fewer tiers, and a
stored tier the active provider lacks is served by the default:

| Tier | Anthropic | OpenAI |
|---|---|---|
| `large` (the default) | Claude Opus 5.5 (`claude-opus-5-5`) | GPT-6.1 Sol (`gpt-6.1-sol`) |
| `medium` | Claude Sonnet 5.5 (`claude-sonnet-5-5`) | none: served by `large` |
| `small` | Claude Haiku 5.5 (`claude-haiku-5-5`) | GPT-6 Luna (`gpt-6-luna`) |

The catalog also prices models nobody can choose: the ones a declined request is re-run on (Claude
Opus 5, Claude Opus 4.8, Claude Sonnet 5), and ones older call-log rows name (Claude Haiku 4.5, GPT-6
Astra).

**Which tiers an agent may use is on its definition.** `modelTiers` (`parseAgentDefinition`; the
default tier alone when a definition says nothing, and it must include the default) is enforced by
the API where a choice is accepted and again by the worker where it is used, never only by what the
interface hides:

| Agent | `modelTiers` | Chosen |
|---|---|---|
| Ask (`library-chat`, `library-chat-read`, `brand-chat`, `brand-chat-read`) | all three | per question, in the Ask panel's composer; the question's request carries `modelTier` and the run stores it |
| Business Knowledge Base | `large`, `medium` | the Model setting on the agent's page: `PUT /v1/workspaces/:id/agents/business-knowledge-base/model` `{"modelTier": "medium"}`, member and up, stored as `modelTier` on its `agent_setups` row |
| llms.txt, Design system | the default | never: they get no setting |

The run handler (`tierFor` in `agents/src/ai/executeRun.js`) takes the run's own `modelTier` (an
Ask question's), else the one on the agent's setup (read when the run starts, so every write run
follows the Model setting, the ones the Library scheduler starts included), else the default, and
the default whenever that is not a tier the definition allows. The router then makes the tier a
model on the active provider. The knowledge base's change of folders asked for in words
(`structure.revise`) is not a write run and stays on the default.

**Effort and the output ceiling stay the kind of work's.** Each provider's route table in
`agents/src/ai/model/modelRouter.js` (`ANTHROPIC_ROUTES`, `OPENAI_ROUTES`) maps a definition's
capability to how hard the model thinks and how much it may write, whichever tier serves it;
`parseAgentEnvironment` (`agents/src/config/env.js`) puts the chosen table on the config as
`routes`, and every model router the worker builds is handed it:

| Capability | Tier | Effort | Output ceiling | Used for |
|---|---|---|---|---|
| `fast` | `small`, always | low | 8,000 | short rewrites: the summaries plain-code agents ask for (none in this release) |
| `reasoning` | the run's | high | 64,000 | careful multi-step work with tools: llms.txt, the Library chat, the brand chat; and the Design system agent's two structured answers |
| `long-context` | the run's | low | 64,000 | work that needs room more than depth: the Library's write run |

The request a capability makes is valid on every model a tier offers. On Anthropic each of the
three takes adaptive thinking, every effort level and a 64,000-token ceiling; the one difference is
the server-side fallback below, which Claude Opus 5.5 and Claude Sonnet 5.5 take and Claude Haiku 5.5
does not (it accepts no `fallbacks`), so a Haiku request goes without (`WITH_SERVER_FALLBACK` in the
adapter). `OPENAI_ROUTES` is the table that served every call until 2026-10-15.

**A conversation hands one model nothing of another's.** An Ask question is a run of its own; the
earlier turns reach it as text in its input (`history`, `contextFrom` in
`backend/src/services/conversationService.js`), and the run starts a new conversation with the model
(`buildTask` in `modelRuntime.js`). Thinking blocks and other provider blocks are handed back only
between the turns of one run's tool loop, which is on one model. So a person may change the model
between two questions of a conversation: the next run is simply on the new model, reads the thread
as text, and pays for its prompt afresh (a provider's cache is the model's own, and a run's prompt
is cached only within the run anyway).

**Prices.** US dollars per million tokens, as published, checked against the provider's pricing
page (the Anthropic rows on 2026-11-26), five-minute cache writes:

| Model | Input | Output | Cache write | Cache read |
|---|---|---|---|---|
| Claude Opus 5.5 | $4 | $20 | 1.25× input | 0.05× input ($0.20) |
| Claude Sonnet 5.5 | $2 | $10 | 1.25× | 0.05× ($0.10) |
| Claude Haiku 5.5, prompt up to 100,000 tokens | $0.10 | $0.50 | 1.25× | 0.1× |
| Claude Haiku 5.5, longer prompt | $0.50 | $2.50 | 1.25× | 0.1× |
| Claude Opus 5, Claude Opus 4.8 | $5 | $25 | 1.25× | 0.1× |
| Claude Sonnet 5 | $2 | $10 | 1.25× | 0.1× |
| Claude Haiku 4.5 | $1 | $5 | 1.25× | 0.1× |

A second band (`longPrompt` in the catalog) prices a request by the length of its own prompt, every
input token counted, cache reads and writes included; each request is priced on its own, and the
cache multipliers apply to its band's input price. The OpenAI rows are the standard prices for a
request of up to 272,000 input tokens, which no run here is meant to reach. A model not in the
catalog is priced at $5 in and $25 out, so an unknown model never looks free.

**In the web app.** `GET /v1/ai/models` (signed in) answers the active provider (what the worker
recorded in `system_state`, `_id: "ai"`; Anthropic before any worker has), `defaultTier`, its
`tiers` (`{tier, model, name, relativeCost}`, `relativeCost` being the mean of the input and output
price ratios against the top tier: 0.5 for Claude Sonnet 5.5, 0.025 for Claude Haiku 5.5), and
`names`, the display name of every model the catalog knows. The Ask panel's picker lists every tier
by name with the cost said in words ("about half the cost", "a small fraction of the cost"), and
remembers the choice per person and workspace in the browser (`orbik.ask.model.<user>.<workspace>`
in `localStorage`; `frontend/src/lib/ask/modelChoice.js`). Under each finished answer, beside Copy,
is the display name of the model that answered (the turn's `model`, or the id when the catalog does
not know it). An agent's setup (`GET /v1/workspaces/:id/agents/:slug/setup`) carries `models`:
`{provider, settable, defaultTier, tier, tiers}`, the tiers it may use on the active provider and the
one its runs use now; the Knowledge base agent's page draws its Model setting from it.

### Keeping the catalog current

New models never join the catalog on their own: the provider's Models API gives names, dates and
capabilities but no prices, and every cost is worked out from the catalog. Instead the scheduler
compares the two once a day (`agents/src/ai/model/catalogCheck.js`), when Anthropic is the reasoning
provider and `ORBIK_ANTHROPIC_API_KEY` is set. It lists the provider's models through the SDK
(`client.models.list()`, every page) and reports:

- `not-listed`: a tier's model the provider no longer lists;
- `newer`: a listed model in a family a tier offers (an Opus, a Sonnet, a Haiku) newer than the
  tier's model, by the `created_at` the provider gives both, or by the version in the id when it
  gives no real date.

Findings are logged as a warning (`ai.catalog_out_of_date`), recorded in `system_state` (`_id:
"ai-models"`: `provider`, `checkedAt`, `listed`, `findings`, `findingsChangedAt`, `lastFailure`),
and, when they differ from the last check's, told to the server extensions as
`ai.catalog.findings.changed` ([extensions.md](extensions.md#events)), so a deployment can tell
somebody once rather than every day. The day's check is claimed with one conditional update, so
several schedulers make it once; the first look waits five minutes after the scheduler starts. A
check that cannot list the models is logged (`ai.catalog_check_failed`) and recorded, and tried
again the next day; it never fails anything else. `pnpm --dir agents run check:models` makes the
same check by hand, records it, tells the extensions, and prints what it found. Acting on a finding
is an edit to the catalog: add the model with its price and move the tier to it.

## Embeddings

The retrieval index behind `content.search` and the chat turns text into vectors with OpenAI's
`text-embedding-3-small`. It is a different provider and a different key from the reasoning calls,
and a separate path on purpose, bounded by construction rather than by promise:

- **Embeddings only.** No reasoning, no summarising, no rewriting happens in the embedding module.
  Reasoning — including every chat answer — goes through the runtime above.
- **One module can reach it.** `packages/retrieval/src/embeddings.js`, behind an
  `embed(texts) → vectors` interface, so a local model is a second implementation of eight lines
  rather than a change anywhere else.
- **The key is `ORBIK_OPENAI_API_KEY`**, in the agents worker's environment and — because the API
  searches the index for MCP clients — in the API's. It is never written to a run and never echoed
  into an error. A rejected key is quoted back by the provider in masked form; anything shaped like
  a key is cut from the provider's message before it reaches an error, the index state, or the call
  log.
- **Every request is in the AI call log**, below, like every reasoning call. Not everything that
  reads the index makes one: finding a page's neighbours (`neighbours` in `@orbik/retrieval`)
  searches around vectors the index already holds and embeds nothing, and so does comparing pages
  with each other (`closeness`), which reads stored vectors and works out the rest itself.
- **The model's name is stored on every vector**, so changing it is a selective re-index rather
  than a silent corruption of every score.
- **Text can be embedded without being indexed.** `embedTexts` on the retrieval index turns texts
  into vectors through the same module, and `nearestPages` sets such a vector against a
  workspace's pages; nothing of either is written to the vector database. The requests are in the
  AI call log like any other, with the run they were for.

A worker without the key indexes nothing; search and chat report that they are not configured, and
say so on the page rather than returning an empty answer.

## The AI call log

Every model call is written to `ai_calls`, by whichever process made it:

| Purpose | Backend | Made by |
|---|---|---|
| `agent-run` | `anthropic-api` or `openai-api`, the reasoning provider's | an agent run's reasoning, including the Library chat; each turn of the tool loop is one call. Also the short text or structured answer a plain-code run asks for, such as the two structured answers a design-system derivation asks for, whose prompts name each image by its kind and size and never hold its bytes: one call each, carrying the run and the agent |
| `source-note` | `openai-api` | no longer made. Rows from before the Library's source layer copied pages: one per note a model wrote for a page |
| `embedding` | `openai-api` | an index pass (one call per batch of up to 100 passages), a `content.search` query inside a run, or — written by the API — an MCP `content_search` |

`agent-run` rows written between the move to OpenAI and 2026-10-15, or on an install whose
reasoning provider is OpenAI, say `openai-api`. Rows written
before OpenAI served every call may say `claude-agent-sdk` in `backend`, and older rows may carry
the purpose `crawl-schedule`, from a crawl-frequency planner that no longer exists; nothing writes
either value any more.

A reasoning call's usage keeps four counts apart — input, cache write, cache read and output —
because the provider prices them apart: the first time it sees a prompt it charges the cache-write
rate for it, and a later turn of the same tool loop reads that prompt back at a small fraction of
the input price. The output count includes the model's own reasoning.

The document is inserted when the call starts and completed when it ends, so a call still
running, or one that took the worker down, shows up too. It holds the system prompt, the prompt,
the model requested and the model that answered, effort, tokens (input, output, cache write,
cache read), the cost at list price, the per-million-token rates that cost was worked out from
(`pricing`), duration, the Orbik tools called, the final text, and any error, with the run,
workspace, site and agent it was for. Text is kept whole up to 200,000 characters and marked where
it was cut.

The cost is list price worked out from the model catalog's prices, in the band the call's prompt
fell in, and the rates are recorded beside it, so a call's cost can always be re-derived from its
tokens. Writing the log can never fail a
call; a write that fails is logged and the work continues.

An embedding call's prompt is the batch of texts, numbered; `inputs` is how many there were; the
tokens are input only; the cost is OpenAI's list price (`text-embedding-3-small` $0.02 per million
tokens, `text-embedding-3-large` $0.13); and the response is a description — "100 vectors · 1,536
dimensions" — never the vectors, which go to the index. A search query's embedding carries the
run that searched.

The log is read, never written, by the API, scoped to the workspaces the account owns:

- `GET /v1/ai-calls` — rows, newest first, paged by start time (`limit`, `before`).
- `GET /v1/ai-calls/summary` — for the same filters: call, failed and running counts; total cost;
  input, cache-write, cache-read and output tokens; the median output of calls that produced any;
  and cost and calls by model.
- `GET /v1/ai-calls/{callId}` — one call with its full text.

An Ask answer also carries its run's total from these rows, `model` and `costUsd` on the turn,
held to the same readers ([library.md](library.md#ask-a-chat-over-the-index)).

Both lists take the same filters: `period` (`1h`, `24h`, `7d`, `30d`), `source` (`agent-run`,
`chat`, `embedding`, `crawl-schedule` — chat is an agent run of `library-chat`, and `agent-run` is
every other agent), `model` (the model that answered, or the one asked for while running),
`status`, `workspaceId` (a workspace the account does not own matches nothing), and `q`, a
case-insensitive substring search over the prompt, system prompt, response and run id. They are
served by the `workspaceId, startedAt` index; the text search scans what the other filters leave.

It is shown in two places. **AI calls**, a section of a workspace's Settings
(`/workspaces/:id/settings/ai-calls`; the old `/workspaces/:id/ai-calls` redirects there), is the
plain log. **LLM calls**
(`/llm-calls`, linked from the app footer) is the developer page: the filters above,
totals and spend by model, the list, and one call opened with its facts, a cost breakdown — each
kind of token times its recorded rate — and its prompt, system prompt, response and tool calls. The
words are fetched only when a call is opened. Export JSON saves the rows on screen with their
filters and totals.

## Running it locally

```sh
# agents/.env, and backend/.env for MCP search
ORBIK_OPENAI_API_KEY=sk-...
# agents/.env, optional: reasoning on Claude rather than OpenAI
ORBIK_ANTHROPIC_API_KEY=sk-ant-...
# agents/.env, optional: anthropic or openai, when both keys are set
# ORBIK_AI_PROVIDER=
```

Then, with the three processes running (`pnpm dev`):

```sh
pnpm --dir backend run seed:user -- --email you@example.com
```

Then configure a crawl. Without either key, the crawl still copies every page into the Library's
source layer; with both, the Library's write run builds the knowledge base once its top-level
folders are chosen, and the Ask panel answers from it. The **Design system** agent needs Google
Chrome on the worker's machine, and without a reasoning key it stores what it observed and
leaves the proposal out.

## What is not finished

- **Routing per capability.** `ORBIK_AI_PROVIDER` chooses a whole table; mixing providers is still
  an edit to the tables in `modelRouter.js`. A person chooses a tier only where an agent's
  definition allows it, and only for Ask and the knowledge base.
- **Credits and billing.** Runs are not metered or charged for. What each model call cost at list
  price is in the AI call log; a unit a user pays in comes with billing.
