# Orbik Agents

The agent runtime and the agents that run on it: the crawler, the agent that executes agent
definitions (the knowledge agents, llms.txt, the Design system agent, the Library and brand
chats), and the Library agent's plain-code stages. Agent processes bind **no port** — the frontend
(3100) and API (4100) remain the only listeners, and run progress is observed by reading MongoDB.

## Two processes

- **The worker** (`src/worker.js`) claims jobs from the queue and runs their handlers. Any number
  can run; each claims work atomically.
- **The scheduler** (`src/scheduler.js`) turns "this is due" into queued work. It runs five loops
  side by side, each a short periodic pass built on `src/runtime/loop.js`:
  - the **crawl scheduler** (`src/crawler/crawlScheduler.js`) starts a crawl for every site whose
    `nextCrawlAt` has come;
  - the **agent scheduler** (`src/ai/agentScheduler.js`) starts runs for agent schedules that are
    due, such as the weekly llms.txt run;
  - the **run dispatcher** (`src/ai/runDispatcher.js`) moves runs the API accepted onto the queue;
  - the **Library scheduler** (`src/library/libraryScheduler.js`) queues Library work no crawl
    produced — a file a person edited, a page asked for by name — and starts the Library's writing
    stage once the source layer has settled and a page it is written from has moved;
  - the **outbox scheduler** (`src/ai/outboxScheduler.js`) starts the agents a recorded event
    gives work to. No agent in this release is started that way, so its list is empty and each
    pass returns at once; see [Change events](#change-events).

The API never enqueues. It writes a due time or a `queued` run row and returns; the scheduler
notices. An HTTP handler therefore cannot race a worker, and accepting a request never depends on
the queue being reachable. The two processes switch together — a scheduler queueing work no worker
will execute looks running while doing nothing.

Both processes build the runtime through `createRuntime` (`src/runtime/index.js`) from the same
list of agents, so they cannot drift in how the queue, ledger, registry and loops are wired.

## Three registered agents

`src/registeredAgents.js` (`createAgents`) is the one list of what this deployment can execute.
The three are different in kind:

- **`crawler`** is deterministic code. It goes to a site, respects its robots.txt, and records what
  it found. No model is involved.
- **`ai`** executes agent *definitions*: instructions and a tool allow-list, kept as code in
  `@orbik/agent-definitions` so the API reads the same ones. Adding an agent adds a definition,
  not an entry in the list. A run executes in the model runtime (`src/ai/model/`, Anthropic's
  Messages API) or in a plain-code runtime the definition names; the one such runtime is the
  Design system agent's (`src/ai/designSystem/`, a real Chrome and two structured model calls).
  See [docs/architecture/ai-execution.md](../docs/architecture/ai-execution.md) and
  [docs/architecture/design-system.md](../docs/architecture/design-system.md).
- **`library`** is the two stages of the Library agent that are plain code: **mirror**
  (`sources.mirror`, a copy of every new or changed page in the Library's source layer, and the
  choice of which pages the knowledge base is written from; no model call) and **embed**
  (`index.embed`, the retrieval index over the pages and the Library's files). Which page moved is
  a hash comparison in both, so neither is a definition. The third stage, rewriting the subject tree, is a
  run of the `business-knowledge-base` definition under `ai`. See [docs/architecture/library.md](../docs/architecture/library.md).

The retrieval index is built once in `createAgents` and shared by the embed stage, which fills it,
and the `ai` agent's tools, which query it — `content.search` by meaning — so both are always
answered from the index the embeddings were written to.

## Layout

```text
src/
  worker.js, scheduler.js   the two long-running entry points
  registeredAgents.js       the agents this deployment executes
  jobs.js                   every agent name and job type, and the Library job builder
  crawler/                  the crawler agent and its scheduler
  ai/                       the ai agent: run execution, definitions, the model runtime and the
                            plain-code one (the Design system agent), the agent scheduler, the
                            outbox scheduler and the run dispatcher
  library/                  the Library agent's note and embed stages, and its scheduler
  runtime/                  the generic machinery: queue, run ledger, registry, worker, loop,
                            run event log, event outbox, and the crawl lock as something other
                            than a crawl may borrow it
  config/env.js             environment parsing
  db/indexes.js             the indexes the agent collections depend on
  cli/                      runAgent.js
```

The rule behind it: **one folder per registered agent**, holding that agent and anything only it
uses, including its scheduler. `runtime/` knows nothing about any particular agent. Agents never
import each other, so the names they share — the crawler hands a finished site to the Library by
queueing the Library's job types — live in `jobs.js`, which every agent and the runtime may import
and which imports nothing of theirs. Those names are persisted on every job and run row, so changing
one strands the rows already written under the old spelling.

## How the agents fit together

Agents never call each other. They communicate through two things only:

1. **Shared collections.** The crawler writes the URL registry, page snapshots, Markdown and link
   graph; later agents read them.
2. **The job queue.** An agent queues follow-up work — its own or another agent's — and the
   runtime executes it.

That indirection is the point: any agent can be restarted, retried, rolled back, or rewritten
without the others knowing.

One rule keeps the dataset trustworthy: **derived verdicts are computed once, by the agent that
owns them, and stored.** The crawler decides whether a URL is indexable and records the reason
codes; no downstream agent re-derives that judgement. Tools that recompute the same verdict in
several places end up contradicting themselves.

## Runs and jobs

A **run** is the unit a human reasons about — "last night's crawl of example.com". A **job** is
the unit a worker executes. One run of a 50,000-URL site is thousands of independently retryable
jobs that still report as one status, one duration, and one set of counters. Runs live in
`agent_runs` (`src/runtime/runLedger.js`); a run that wants to show its progress to a person also
writes an ordered event log (`src/runtime/runEventLog.js`).

Each run stores the **configuration snapshot** it used. Without it, a comparison between two runs
cannot tell "the site changed" from "we changed how we crawled it", and every trend line built on
the data becomes unfalsifiable.

## The queue

MongoDB-backed, because the database is already deployed, backed up, and understood, and a single
`findOneAndUpdate` provides the atomic claim a queue needs. The surface is deliberately
broker-shaped (`claim`, `heartbeat`, `complete`, `fail`, `release`, `reclaimExpired`), so moving
to a dedicated broker later replaces `src/runtime/queue.js` rather than the agents above it.

Correctness rests on four decisions:

- **Leases, not acknowledgements.** A claimed job carries a deadline its worker must extend. A
  worker that dies simply lets the lease lapse, and any other worker recovers the job — no
  leader, no heartbeat protocol, no broker state.
- **Terminal transitions are scoped to the lease owner.** A worker that stalled past its lease
  has had its job reclaimed and possibly re-executed; letting its late result land would
  overwrite the current owner's outcome with stale data.
- **Idempotency keys constrain in-flight work, not all work.** The same key can be enqueued again
  once the previous job finished, which is what a recurring crawl needs. A plain unique index
  would burn every key permanently after its first use.
- **Unknown failures are not retryable.** A `TypeError` from a parser is a bug; retrying it five
  times reproduces the crash while hiding it behind attempt counters. Only failures an agent
  explicitly marks retryable are retried, with capped exponential backoff and ±20% jitter — the
  jitter is what stops 200 jobs that failed against one host from retrying in lockstep and
  reproducing the overload.
- **Being told to wait is not an attempt.** A retryable failure may say it consumed none
  (`consumesAttempt: false` on the `AgentError`): the job was put off before it did what it exists
  to do. The crawler uses it for a page whose host is inside a "slow down" hold. One hold puts off
  every queued page of the site, and if each wait cost an attempt, five holds anywhere in a long
  crawl would dead-letter whatever was still queued behind them. Such a job goes back with its
  attempts as they were and is counted under `jobsHeld`, not `jobsRetried`.

The worker claims until its slots are full or the queue has nothing for it, then waits for
whichever comes first: one of its jobs finishing, a job that is waiting out a delay becoming
ready, or the poll interval. A finished job is the usual reason there is something new to claim —
it frees a slot, and it has just queued its follow-ups — so nothing waits out an interval between
one page of a crawl and the next. A worker told to stop while a claim is on its way puts the job
straight back rather than start something shutdown is no longer waiting for.

Dead-lettered jobs are kept, not deleted: "which URLs did we give up on, and why" is itself a
reportable finding.

Crawls are serialized across the deployment by a lease in `crawl_queue_locks`, held **per run by
one worker process**, not per job:

- A worker's claim takes the lease when nobody owns it, when it has lapsed, or when that worker
  owns it already. Holding it, the worker is offered the pinned run's jobs and may run several at
  once, up to `AGENT_CONCURRENCY`. A worker that cannot have it is offered the other agents' jobs
  only, which are claimed alongside a crawl as they always were.
- The lease pins a run (`runId`). No job of another run is claimed until the pinned run has no
  job pending or running — including one waiting out a retry delay or a host's hold — so other
  sites wait in arrival order.
- The worker gives the lease back when the last crawl job it is running completes, fails or is
  released, and leaves the pin on the document. Whether any is still running is counted from
  `agent_jobs`, not kept as a number that a crash could leave wrong.
- A heartbeat of any crawl job the worker is running extends the lease. A worker that dies lets
  it lapse, and the next claim by anyone takes it and carries on with the pinned run.

It is one process because per-host pacing is a map inside that process's HTTP client: two workers
sharing a run would each allow themselves the full request rate. For the same reason a worker's
identity must be unique among live processes (`AGENT_WORKER_ID`; the default is). A worker
restarted under the name it had takes back the lease it held without waiting for it to lapse.

Counting the worker's running crawl jobs and releasing the lease are two operations, and a claim
between them could start a job that the release then leaves running with the lease free. So one
process's dealings with the lease — its claims, and the release after each crawl job — are run one
at a time (`exclusive` in `src/runtime/queue.js`). Other processes cannot interleave that way:
they can only take a lease that is free or has lapsed.

A job that is not a crawl but sends paced requests to a website, and so must never run beside a
crawl, can borrow the same lease (`src/runtime/crawlLock.js`) without the claim above being taught
about it; no job in this release does. It takes it by the rule a worker that does not hold it takes
it by: one `findOneAndUpdate` when nobody holds it or its lease has lapsed. Having it, the borrower
looks for a crawl run with a job still pending or running, and gives the lease straight back when
there is one. So a crawl is never held up behind more than the one site being read, a read never
starts part-way through a crawl, and a borrower that dies lets the lease lapse like any worker.
The owner it writes is never a bare worker id, so nothing the queue does on a worker's behalf can
match a lease it holds.

## The crawler

The crawler's job is twofold: **discover** which URLs a site has, then **fetch** each one and
record what it found. The two are separate handlers because they fail differently — discovery is
a handful of requests that establish the shape of a crawl, fetching is thousands that fill it in,
and merging them would mean one sitemap timeout re-runs everything. Discovery reads robots.txt and
the sitemaps; the pages nothing lists are found by following links, by the fetches themselves or,
when the month's crawl budget might not cover the site, by a free pass over every page first. What
a run costs, when that pass runs, how a run's phases appear in the web app and how crawl
frequencies are chosen are in [docs/architecture/crawler.md](../docs/architecture/crawler.md).

### URL normalization is the load-bearing piece

Every count, diff, and link-graph edge joins on the SHA-256 of a normalized URL. The rules are
deliberately conservative, because merging two URLs the server treats as different silently loses
a page, which is far harder to notice than an over-counted duplicate. Always applied: lowercase
scheme and host, punycode, fragment removed, default port removed, credentials removed, empty
query removed, tracking parameters (`utm_*`, `gclid`, `fbclid`, …) removed. Deliberately *not*
applied by default: query sorting (it changes the URL actually requested) and trailing-slash
folding (`/a` and `/a/` are genuinely different resources; reconciling them is the canonical
tag's job).

The rules themselves are `normalizeUrl` in `@orbik/core` (`packages/core/src/url/url.js`), not the
crawler's own: anything else that keys a row by an address uses the same hash, and one set of
rules means it and a crawled page cannot disagree about whether they are the same address. The
crawler's part is `src/crawler/url.js`, which calls them and reports a refusal as an `AgentError`.

### Discovery sources

The seed, sitemaps declared in robots.txt or configured on the site, and — only when neither names
any — the conventional `/sitemap.xml` and `/sitemap_index.xml` locations. Sitemaps matter most
because they list pages the owner wants crawled, including orphan pages nothing links to that a
link-following crawl would never reach. Sources are combined, not ranked: a URL found in both the
sitemap and as the seed records both, because that combination is a stronger signal than either
half.

### Nothing discovered is thrown away

A URL that is out of scope or disallowed by robots.txt is still written to the registry, with the
reason. "Which URLs did we decline to crawl, and why" is a finding an operator needs; a crawler
that silently drops them cannot answer it. A page the month's crawl budget could not pay for stays
in the registry unfetched, and a later run picks it up.

### robots.txt

Followed per RFC 9309, including longest-match precedence with `Allow` winning ties. The rules
themselves are `createRobotsRules` in `@orbik/core` (`packages/core/src/robots/robots.js`), not
the crawler's own, so anything else that reads a stored robots.txt reads it the same way. The
crawler's part is `src/crawler/robotsStore.js`, which fetches the file, stores it whole in
`crawl_robots` and asks the rules about Orbik's own crawler. The status
handling is asymmetric on purpose: **4xx** means the site has no robots.txt and everything is
allowed, while **5xx or a transport failure** blocks the crawl entirely — the file exists and may
forbid us, and treating an outage as permission would crawl a site whose owner said not to.

Ignoring robots.txt is possible but gated: `respectRobots: false` is rejected unless the site
document also records `robotsOverrideAcknowledgedAt` and `robotsOverrideAcknowledgedBy`. The
override cannot be switched on by a stray config edit, and who accepted responsibility stays
auditable. The file is still fetched and stored either way.

### The fetch half

One job per URL, not one per crawl: a 5,000-page site is 5,000 independently retryable units, so
one slow page cannot fail a whole crawl and a resumed crawl repeats only what it had not finished.

Each fetch stores a page snapshot with everything observable — status, redirect chain, title,
description, headings, canonical, hreflang, JSON-LD types, Open Graph, word count, image alt
coverage, the page's images one by one (`extracted.imageInventory`: each image's address, its alt
state and text, where it links, the heading, caption and text beside it, the size the markup
states and which part of the page it is in, capped at 200 a page with the rest counted), timing,
size — plus the **indexability verdict and its reason codes**, and a
content-only Markdown rendering of the page. Extraction itself records what the markup *says*;
deciding what that means is the verdict's job, which is what lets the verdict change without
re-crawling the site.

Two details do real work. The text hash covers readable text, not HTML, so a rotating build-id
comment is not reported as a content change across every page on the site. And stored `ETag` /
`Last-Modified` validators mean a recrawl asks the server whether anything changed: a 304 carries
the previous verdict forward and downloads nothing.

### Depth is computed after the crawl, not during it

Depth cannot be correct while crawling. Sitemap-discovered pages arrive with no depth at all, and
concurrently fetched pages see whatever their parent's depth happened to be at that instant. The
incremental depth kept during a crawl is a converging lower bound, not an answer.

So `crawler.finalize` runs a breadth-first search over the finished link graph and writes exact
shortest paths, then — when the run saw the whole site — flags pages the seed cannot reach as
**orphans**: pages that exist, perhaps even in the sitemap, that no internal link points at. It
also groups duplicates, assigns route patterns, applies the crawl frequencies on record to the
pages, closes the run, and hands the site to the Library agent by queueing its note and embed
stages.

It schedules itself: it checks whether fetch work remains for its run and re-queues itself a few
seconds later if so. Run completion stays a property of the queue rather than of a separate
coordinator that could disagree with it. The in-memory BFS is what bounds this design to sites of
roughly 50,000 URLs; a larger site would need to change that function.

### The link graph is replaced per page

Each fetch deletes that page's outbound edges and writes the current ones. Storage stays bounded
by the size of the site rather than by the number of crawls, and the graph always reflects the
latest fetch of every page. The trade-off is deliberate: historical link diffs are not available.
Adding them means keeping edges per run and pruning on a schedule.

### Requests are polite by construction

Per-host pacing lives inside the fetcher, so no caller can bypass it: four requests a second to
one host for a crawl by default, and slower whenever the site asks ([docs/architecture/crawler.md](../docs/architecture/crawler.md) § "Pace"). HTTP status is data, not
failure: a 404 or a 500 is what the crawl exists to record, so only transport problems throw.
Redirect chains are followed manually and kept, because hops, loops, and chains ending in errors
are findings in themselves.

The fetcher also refuses any host resolving to a loopback, private, link-local, or otherwise
non-public address (`classifyAddress` in `@orbik/core`). Site URLs are user input, so without that
check a workspace owner could point the crawler at an internal service or a cloud metadata
endpoint and read the response back out of the crawl results.

A caller that is not a crawl of the workspace's own pages, and needs to see each redirect before
it is followed, hands the fetcher a transport wrapped in `withoutRedirects` (exported from `src/crawler/fetcher.js`), which moves a redirect's
target out of `Location` so the fetcher returns the redirect instead of following it. Every hop
is then one of the fetcher's own requests, with the pacing, the timeout, the size cap and the
refusal of non-public addresses applied to each. The fetcher also takes an `accept` option, so a
caller asking for images says so.

## Continuous crawling

The crawl scheduler claims a due site with a single `findOneAndUpdate` that moves `nextCrawlAt`
forward in the same operation that reads it, so running more than one scheduler is safe — the
loser of a race simply finds nothing due. There is no leader election and no lock to expire. How
often a site comes due follows from the crawl frequencies a person chose for its pages, capped by
the site's own cadence (`crawlIntervalHours`, default weekly, 1–8760).

Two details are load-bearing:

- **The schedule moves forward before the crawl is queued.** Setting it afterwards would let a
  crawl that crashed mid-run block its site forever, since nothing would remain to advance it.
- **A site whose previous run is still open is skipped for one cycle.** Overlapping crawls would
  double a site's outbound request rate and have two runs competing to write the same snapshots.
  This is also why `finalize` closes the run: an unclosed run makes that check answer "yes"
  forever, and the site would never be crawled again.

The agent scheduler is a near-twin: the same atomic claim-and-advance, for the same reason.

## Incremental recrawls

A repeat crawl of a stable site should be cheap, not merely repeated. Two mechanisms do that.

Stored `ETag` and `Last-Modified` validators turn most requests into conditional GETs, so an
unchanged page costs a 304 and no body. A 304 still **follows** that page's stored links — they are
current by construction, since edges are replaced whenever a page is fetched — because otherwise
every page reachable only through an unchanged one would be stranded, and an incremental crawl of
a stable site would fetch nothing but the seed.

Queue priority then decides what a budget-limited crawl looks at first: pages never crawled
(ordered by depth), then pages that were broken, then pages the sitemap says changed. `lastmod` is
treated as a hint that can only *raise* priority — plenty of sites stamp it with a build date — so
a badly maintained sitemap can never cause a change to be missed.

### Eligibility and progress are separate fields

`state` records only how far a URL has got (`discovered` → `crawled`) and never moves backwards.
`eligible` is recomputed on every crawl from the current scope rules and robots.txt.

Collapsing the two costs correctness in one direction or the other: rewinding a rediscovered page
to "not yet crawled" makes two pages that link to each other re-queue one another without end,
while never rewinding means a URL excluded once can never become eligible again when the rules
change.

## Change events

The crawler records what it observed to an append-only outbox, `agent_events`
(`src/runtime/eventOutbox.js`): `page.discovered`, `page.status_changed`, `page.content_changed`,
`page.canonical_changed` and `page.indexability_changed` from each fetch, and `crawl.completed`
with the run's counters from `finalize`.

The vocabulary is deliberately about observed change rather than about what to do: "the canonical
tag changed" is a fact the crawler can state, while "re-run the canonicalization audit" is a
decision belonging to whichever agent cares. The outbox offers a cursor read by event `_id`
(`after`, and `until` for a consumer that works one stretch at a time), so a consumer can track
its own position and several can read at different speeds.

**Nothing in this release reads it yet.** The outbox scheduler (`src/ai/outboxScheduler.js`) is
where a reader goes: for each entry in its `OUTBOX_CONSUMERS` table — an agent, the event that
starts it and how to find the last event it covered — it looks, per workspace that has set the
agent to work, for that event beyond the agent's position and starts one run for it. The table is
empty, so each pass returns at once. The Library agent learns about a finished crawl from the jobs
`finalize` queues, not from `crawl.completed`.

The outbox is not the run event log: that one is scoped to a single run and is how a run's
progress reaches a person. Clearing a site's crawl data from the web app deletes that site's
events with it.

## Writing an agent

Most new agents are definitions run by `ai`, not code; see
[docs/architecture/ai-execution.md](../docs/architecture/ai-execution.md). That includes an agent no model decides anything
for: it is still a definition, whose `runtimeRequirements` name a plain-code runtime, and
adding one is a requirement in `@orbik/protocol` and one entry in `PLAIN_CODE_RUNTIMES`
(`src/ai/index.js`). It is then dispatched, leased, retried and recorded like every other run. A
new registered agent is for work that needs no model *and* its own job types, as the crawler does:

```js
export function createExampleAgent() {
  return defineAgent({
    name: "example",
    version: 1,
    handlers: {
      "example.step": async (job, { database, queue, ledger, logger, signal, heartbeat }) => {
        // ...do the work...
        return {
          counters: { pagesSeen: 1 },
          enqueue: [{ agent: "example", type: "example.step", payload: { url }, idempotencyKey: url }],
        };
      },
    },
  });
}
```

Give it a folder under `src/`, put its name and job types in `src/jobs.js`, and add it to
`createAgents` in `src/registeredAgents.js`. The runtime handles claiming, lease renewal, retry
classification, follow-up enqueueing, run counters, recovery, and shutdown; a handler is an
ordinary async function.

Return `enqueue` rather than calling the queue directly. The runtime enqueues follow-ups *before*
completing the job, so a crash in between re-runs the handler and re-enqueues the same
idempotency keys — harmless. The opposite order would silently truncate a crawl.

They are written in one unordered insert (`enqueueMany` in `src/runtime/queue.js`), with the keys
already in flight left out. Unordered means they become visible in no particular order, so a
follow-up that must not start before the others exist — the crawler's `start-fetch` and `finalize`
are two — checks for the job that queued it, which is still running until all of them are written.

## Commands

```sh
pnpm --dir agents dev              # worker and scheduler together, each with --watch
pnpm --dir agents run dev:worker   # only the worker, with --watch
pnpm --dir agents run dev:scheduler
pnpm --dir agents start            # the worker, without a watcher
pnpm --dir agents lint

# Run one agent once, without deploying a worker:
pnpm --dir agents agent:run -- --agent crawler --type crawler.discover --site <objectId> --wait
```

`agent:run` without `--wait` only queues the job, through the same path production uses; with
`--wait` it also runs an embedded worker until the run's jobs drain. Discovery needs a
`crawl_sites` document. The minimum is a `workspaceId` and a `seedUrl`; every other setting takes a
documented default from `src/crawler/siteConfig.js`.

In production the worker and scheduler run under PM2 from `ecosystem.config.cjs`;
`scripts/agents.sh dev|prod` switches both between modes, deleting the opposite mode so both can
never run at once.

## Configuration

Copy `.env.example` to the untracked `.env`; every variable is described there. Every value is
validated before the worker claims its first job (`src/config/env.js`), and every invalid value is
reported at once rather than one restart at a time. MongoDB must be the same database the API
uses: agents read workspaces and write their own collections. `ORBIK_ANTHROPIC_API_KEY` is needed
for model runs, and `ORBIK_OPENAI_API_KEY` for embeddings, with a running Qdrant beside it for the
retrieval index; without them the worker still starts, crawls, mirrors each site into its Library,
and says what it skipped.
