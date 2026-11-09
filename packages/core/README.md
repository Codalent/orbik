# @orbik/core

Runtime primitives shared by every Orbik process: the API (`backend/`), the agent worker and
scheduler (`agents/`), and the CLIs. Nothing here is HTTP-specific, and nothing here imports from
another Orbik package; the domain packages depend on this one, never the other way round.

## What belongs here

A module earns a place in this package only when **more than one process depends on agreeing about
it** and no domain package owns it. That is two kinds of thing.

The primitives every process stands on:

- **Environment primitives** (`src/env.js`) — validation for the inputs every process shares
  (`NODE_ENV`, `MONGODB_URI`), and the bounded-integer and URL parsers each process builds its
  own inputs from. Each process composes these in its own `config/env.js` rather than inheriting an
  environment shape it does not use: the API adds HTTP, CORS, and session values; the agents
  process adds worker tuning and its model key. This is why a crawler worker is not forced to
  supply a `SESSION_SECRET` it will never read.
- **MongoDB access** (`src/db/mongo.js`, `src/db/objectId.js`) — one connection per process,
  Stable API v1.
- **Physical collection names** (`src/db/collections.js`) — the cross-process schema contract:
  `COLLECTIONS` for authentication and workspaces, `AGENT_COLLECTIONS` for everything the agents
  write and the API reads (and the reverse). The names cannot be allowed to drift between
  processes.
- **The redacting logger** (`src/logger.js`) and `escapeRegExp` (`src/escapeRegExp.js`).
- **The public-address rule** (`src/net/publicAddress.js`, `classifyAddress`) — the one answer to
  "is this address on the public internet", used by the crawler, the OAuth client check and the
  workspace URL validator, so the three cannot disagree about what is private.
- **The robots.txt rules** (`src/robots/robots.js`, `createRobotsRules`) — the one reading of a
  robots.txt, by RFC 9309. The crawler asks it what its own crawler may fetch; a report may ask
  it the same question under other crawlers' names, from the same stored text, so a verdict about
  GPTBot is by construction what Orbik's crawler would have concluded as GPTBot. `allows` is what a crawl obeys; `explain` gives the same answer with the lines of the
  file that decided it. It is pure: text and a status code in, a decision out, no request made.
- **The URL normaliser** (`src/url/url.js`, `normalizeUrl`, `hashUrl`) — the one canonical form of
  a URL and the SHA-256 every crawl collection keys on. It lived in the crawler until something
  else had to key its rows by the same hash: a row about a page from another system joins to a
  crawled page only when its address is normalised by the very rules the crawler applied. The crawler's
  own module calls this one and reports a refusal as an `AgentError`.

The records both processes read or write that no domain package owns:

- **Agent setups** (`src/agentSetups/store.js`) — which agents a workspace has switched on, their
  schedule profiles, and the bounds on a page list a person chooses.
- **The AI call log** (`src/ai/callLog.js`) — the writer every model call reports to, used by
  whichever process made the call: the agents worker for runs and indexing, the API for the
  embedding an MCP `content_search` needs.
- **The crawl schedule** (`src/crawl/schedule.js`) — how a site's per-pattern crawl intervals are
  stored and resolved.
- **The knowledge agents' constants** (`src/knowledge/knowledge.js`) — the Business Knowledge Base
  and llms.txt agent slugs, the llms.txt limits, and the source statuses.

## What does not belong here

- **A domain with a package of its own lives there**, and depends on this one: the Library in
  `@orbik/library`, the retrieval index and its environment in `@orbik/retrieval`, crawl budget in
  `@orbik/crawl-budget`, the tools agents and MCP clients call in `@orbik/tools`, and the
  definition and run contracts in `@orbik/protocol`.
- **Code with a single consumer lives with that consumer**, even when it looks generic. `AppError`
  and the HTTP error envelope live in `backend/`, because they encode HTTP status and exposure
  rules that agents have no use for. The crawler, the queue and the model runtime live in
  `agents/`. The API's own queries over agent collections live in its repositories.
- **Index definitions live with the process that owns the queries**: `backend/src/db/indexes.js`
  for authentication, workspaces and the API's own records, `agents/src/db/indexes.js` for the
  agent collections. Only the names are shared.

A name is exported from `src/index.js` only when something outside this package imports it.

## Validation contract

The environment primitives never throw on a single bad value. They append a safe message to a
caller-owned `errors` array and return, so a process can report *every* misconfiguration in one
startup error instead of forcing an operator to fix inputs one restart at a time. The caller ends
with `assertValidEnvironment(errors)`. Rejected values are never echoed back, because `MONGODB_URI`
can carry credentials.

## Commands

```sh
pnpm --dir packages/core lint
```
