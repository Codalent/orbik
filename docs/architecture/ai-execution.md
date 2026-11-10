# How Orbik runs agents

There is exactly **one** way an agent runs: the agents worker executes it, and the reasoning goes
to Anthropic with Orbik's own key, `ORBIK_ANTHROPIC_API_KEY`. The embeddings behind the retrieval
index go to OpenAI with `ORBIK_OPENAI_API_KEY`, because Anthropic has no embeddings endpoint.

A user never picks a provider, a model, or a temperature, and never supplies a key or a login of
their own. Those are Orbik's problem. What a user sees is a **Run** button.

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
   (no model decides)  Anthropic   (OpenAI: an adapter
                                    no route uses today)
```

A run is created by the API (`POST /runs`) or by the scheduler, queued, picked up by the run
dispatcher (`agents/src/ai/runDispatcher.js`) and executed by the one handler in
`agents/src/ai/executeRun.js`. Its status is one of `queued`, `running`, `succeeded`, `failed`,
`cancelled`, and nothing else.

## Packages

| Package | Owns | Depends on Mongo? |
|---|---|---|
| `@orbik/protocol` | Run states, agent definitions, agent events, validation primitives — the contract the API and the agents worker share | **No** — it has no dependencies at all |
| `@orbik/agent-definitions` | Every agent's definition: instructions, tool allow-list, schemas. The only copy; the API reads it for the catalog and the worker to execute a run | Not itself; it imports `@orbik/tools` to check each tool a definition names |
| `@orbik/tools` | The deterministic tool registry, scoped to one workspace; and the MCP naming (`toolAlias`, `ORBIK_MCP_SERVER`) the API's MCP server uses | Yes |
| `@orbik/retrieval` | The retrieval index and the embeddings module | Yes |
| `agents/src/ai/` | The run handler, the model runtime, model router, provider adapter | Yes |

## Four decisions worth knowing

**An agent is a definition, not a program.** A definition holds instructions, a tool allow-list,
and input/output schemas. They live in `packages/agent-definitions/src/` and nowhere else: no
database holds a copy, and nothing has to be published. Improving an agent's instructions is an
edit to its definition; other code changes only when the *runtime or tools* change. The API and
the worker each read the definitions in their own process, so both have to be running the release
a change shipped in.

**A definition says what the executing process must have.** `runtimeRequirements` is part of the
definition, and it is the only thing the worker reads to pick a runtime. A requirement can name a
**plain-code runtime** — code in the worker that executes the definition itself, with no model
deciding what happens. The Design system agent requires `design-system`, so the worker executes it
with the code that renders the site in Chrome and samples what was rendered; it is the one such
runtime today. The table of those runtimes is `PLAIN_CODE_RUNTIMES` in `agents/src/ai/index.js`,
keyed by the requirement, and adding a plain-code agent is one entry in it; the run handler
(`chooseRuntime` in `agents/src/ai/executeRun.js`) has no agent's name in it. Every definition that
names none of them goes to the model runtime (`agents/src/ai/model/modelRuntime.js`), which asks
the model router for a route and calls the provider adapter
(`agents/src/ai/model/providers/anthropic.js`). See [design-system.md](design-system.md).

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

## Two keys

`ORBIK_ANTHROPIC_API_KEY` pays for every reasoning call — agent runs, the Library chat, and the
short texts and structured answers plain-code agents ask for. `ORBIK_OPENAI_API_KEY` pays for the
embeddings behind the retrieval index, and for nothing else while the route table names Anthropic.
Both are read from `agents/.env`. In `backend/.env` only the OpenAI key matters, and it pays for one
thing: the embedding an MCP `content_search` needs. The API never calls a reasoning model. Every
reasoning call goes through the worker.

The route table (`DEFAULT_ROUTES` in `agents/src/ai/model/modelRouter.js`) decides which model
serves which kind of work. It points at `ANTHROPIC_ROUTES`, and every row names Anthropic:

| Capability | Model | Effort | Used for |
|---|---|---|---|
| `fast` | `claude-haiku-5-5` | low | short rewrites: the summaries plain-code agents ask for (none in this release) |
| `reasoning` | `claude-opus-5-5` | high | careful multi-step work with tools: llms.txt, the Library chat, the brand chat; and the Design system agent's two structured answers |
| `long-context` | `claude-opus-5-5` | low | work that needs room more than depth: the Library's write run |

`OPENAI_ROUTES` beside it is the table that served every call until 2026-10-15 — `gpt-6-luna`
for `fast`, `gpt-6.1-sol` for the other two. Going back to OpenAI is pointing `DEFAULT_ROUTES` at
it and restarting the worker and the scheduler; the OpenAI adapter is registered whenever its key
is set, which it is for the embeddings anyway. `synthesisEnabled` (`agents/src/config/env.js`),
which decides whether the Library scheduler starts write runs, follows the provider the
`long-context` row names, so it moves with the table.

A model run is stopped after 30 round trips, and a long-context run after 60
(`agents/src/ai/model/modelRuntime.js`): the Library's write run rewrites the subject tree file by
file, and its first run under the lower cap was stopped with the entry map not yet reached.

The adapter (`agents/src/ai/model/providers/anthropic.js`) calls the Messages API through the
Anthropic SDK, streamed. It thinks adaptively at the route's effort, hands each block of the
model's reply — its thinking included — back to it unchanged on the next turn of a tool loop, and
declares each Orbik tool under its MCP alias (`crawl_listPages` for `crawl.listPages`), because a
tool name there cannot carry a dot. A tool loop asks the provider to cache the conversation, so
each turn reads the previous ones back at a fraction of the input price; a one-shot call does not,
because it would pay the cache-write premium for nothing. A request to Claude Opus 5.5 carries
`fallbacks: "default"`: when the model's safety classifiers decline it, the provider re-runs it on
another model inside the same call, and the call log names the model that answered. A request
still declined fails as `PROVIDER_REFUSED`.

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

The OpenAI adapter (`providers/openai.js`) is still in the tree, unchanged. It calls the Responses
API with `fetch`, stores nothing at the provider, and hands the model's encrypted reasoning back
between turns; with `detail` it is told how closely to look (`low` fits the image into 512 pixels
a side, `high` into at most 2,500 patches of 32 pixels).

Both keys are optional at start-up, on purpose: a worker without them still starts, crawls and
copies every page into the Library. Without the OpenAI key nothing is indexed, and search and chat say the index is
not configured. Without the Anthropic key, what it cannot do, it says —

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
| `agent-run` | `anthropic-api` | an agent run's reasoning, including the Library chat; each turn of the tool loop is one call. Also the short text or structured answer a plain-code run asks for, such as the two structured answers a design-system derivation asks for, whose prompts name each image by its kind and size and never hold its bytes: one call each, carrying the run and the agent |
| `source-note` | `openai-api` | no longer made. Rows from before the Library's source layer copied pages: one per note a model wrote for a page |
| `embedding` | `openai-api` | an index pass (one call per batch of up to 100 passages), a `content.search` query inside a run, or — written by the API — an MCP `content_search` |

`agent-run` rows written between the move to OpenAI and 2026-10-15 say `openai-api`. Rows written
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

The cost is list price worked out from Orbik's own rate table, and the rates are recorded beside
it, so a call's cost can always be re-derived from its tokens. Writing the log can never fail a
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
# agents/.env
ORBIK_ANTHROPIC_API_KEY=sk-ant-...
# agents/.env, and backend/.env for MCP search
ORBIK_OPENAI_API_KEY=sk-...
```

Then, with the three processes running (`pnpm dev`):

```sh
pnpm --dir backend run seed:user -- --email you@example.com
```

Then configure a crawl. Without either key, the crawl still copies every page into the Library's
source layer; with both, the Library's write run builds the knowledge base once its top-level
folders are chosen, and the Ask panel answers from it. The **Design system** agent needs Google
Chrome on the worker's machine, and without the Anthropic key it stores what it observed and
leaves the proposal out.

## What is not finished

- **Routing by configuration.** The model router returns a provider *name* and reads a route
  table, and two adapters exist, but the table is code: sending a capability to another model or
  back to OpenAI is an edit to `DEFAULT_ROUTES`, not an environment variable.
- **Credits and billing.** Runs are not metered or charged for. What each model call cost at list
  price is in the AI call log; a unit a user pays in comes with billing.
