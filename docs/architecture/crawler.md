# Website crawling

One crawl run is processed at a time across the deployment, by one worker process. That worker reads several of the run's pages at once — up to `AGENT_CONCURRENCY`, four by default — and how fast it asks the site for them is set by the pace below, not by how many are in flight. Other sites wait in MongoDB in arrival order, and none of their jobs is claimed until the run ahead has no job pending or running. Jobs within a run are independently retryable; a delayed retry keeps its site's place. Worker leases recover abandoned work. Agent runs can still go alongside the crawler.

The lease that enforces this is one document in `crawl_queue_locks`, with an `owner`, a `leaseUntil` and the `runId` it pins. A worker takes it when it is free or has lapsed, keeps it while any crawl job of its own is running, and gives it back when the last one stops; the pin stays until the run has drained, so whichever worker takes the lease next carries on with the same run. It is held by one process because a host is paced inside the process that is requesting it: two workers sharing a run would each allow themselves the full rate. A worker that is killed leaves the lease to lapse (`AGENT_LEASE_SECONDS`, five minutes by default) before another worker carries on; one that is stopped gives it back at once.

## First run

1. Read robots.txt and sitemaps and register the URLs they name. This costs no crawl budget and works even with zero allowance.
2. Decide whether the site needs a discovery pass. A page's links can be read by the fetch that is going to request the page anyway, or by a free request of its own beforehand. The second doubles the requests of a first crawl and buys one thing: a site the allowance cannot cover is known in full before the allowance runs out part-way through it. So the crawler compares what is left of the month's allowance with the URLs known for the site — the seed, the sitemaps, and whatever earlier crawls registered (`agents/src/crawler/discover.js`):
   - **The allowance covers them one and a half times over**, which is the usual case: there is no discovery pass. The crawl goes straight to step 3 and **each page is requested once**. Every fetched page queues the pages it links to, so a website without sitemaps is still found through its links.
   - **It does not**: the free discovery pass runs first. Every in-scope page is requested once to read its links; nothing is charged and no page snapshot is written. Step 3 starts only when that has drained, so on such a run a page receives one free discovery request and one paid crawl request.
3. Crawl eligible pages. Each page request consumes one page from the workspace owner's monthly allowance; conditional requests returning 304 also count. Transport failures refund their charge, and so does a 429 or 503 that will be retried, because the retry pays again. Exhausted budgets leave known URLs for a later run. If the allowance runs out during a crawl that had no discovery pass, each page it could not pay for is read for its links instead, free, and so are the pages those lead to: the site is still fully known and partly crawled, never partly known.
4. Finalize: compute depth over the link graph, mark orphans when the run saw the whole site, group duplicates, and give every page its route pattern (`/blog/[slug]`). A group of duplicates is represented by the URL that answers 200, says it is canonical, is in the sitemap and is served over HTTPS, in that order, before the most linked (`agents/src/crawler/duplicateGroup.js`): a site that answers `http://` without redirecting otherwise puts the plain-HTTP copy of an old, much-linked post at the head of its group. The crawl frequencies already on record are applied to the pages the run found, the run is closed, and the site is handed to the Library agent. No model is involved at any step.

A Fresh crawl gets the same decision as a first one. On later runs both the fetches and a discovery pass skip pages that are not due, while never-crawled URLs remain immediately eligible. Sitemaps are checked on the site's visiting cadence to find new content. Unlinked URLs absent from all sitemaps cannot be discovered.

What a run records about this: `discovery` on the run says which way it went and why (`separatePass`, `knownUrls`, `budgetRemaining`). `pagesPlanned` is the number of due pages known at the moment fetching began, so on a crawl with no discovery pass `pagesFetched` is larger than it by the pages found through links. `urlsDiscovered` is the number of crawlable URLs known, kept in step as pages are found. `discoveryPages` counts pages read for free and is absent when none was. `pagesAlreadyFetched` counts jobs that found their page fetched earlier in the same run and so asked for nothing: with several pages read at once, two pages that link to a third can each queue it, a moment apart.

## Pace

At most four requests a second to one host by default (`minHostIntervalMs`, 250 ms, in `agents/src/crawler/siteConfig.js`; a site document may carry its own value, and nothing in the web app sets one). The site can only slow that down:

- A robots.txt `Crawl-delay` widens the interval for as long as the file says so.
- A 429 or a 503 stops every request to that host for as long as its `Retry-After` asks, or thirty seconds without one, to an hour at most. Pages already queued wait the hold out; waiting is not counted as a failed attempt, so a long crawl is not worn down by a site that asks for a pause now and then. The request that was refused is retried and does count.
- Ten refusals in a row stop the run with `RATE_LIMITED`, and the pages left are tried by the next crawl.
- A bot-protection page stops it at once: see "A site that will not let the crawler in" below.

The interval is measured from when the previous request to the host was actually sent, so a busy worker sends fewer than four a second and never two closer together than the interval. Four a second is the ceiling, not the speed: a worker reads `AGENT_CONCURRENCY` pages at a time, in one process, and a site whose pages are large, slow, or each behind a redirect is bound by those slots and by that process's work on each page — extraction and Markdown are a fifth of a second of CPU for a 170 KB page — before it is bound by the pace. On the development machine a site of 2,600 such pages, every one a redirect to another host, is crawled at about two and a half pages a second. The Library's copy and index jobs run in the same worker while a crawl is going, once a minute as pages are rendered, and take a slot while they do.

## Configuration

- **How a scheduled crawl happens.** Each site carries `nextCrawlAt`; the scheduler process claims
  every site whose time has come (checked once a minute) and starts one crawl run for it, which
  discovers new pages from the sitemap and links and fetches the pages that are *due*. A page is
  due when it has never been fetched, when somebody asked for it by hand, or when its own
  frequency has elapsed since its last fetch; a page on manual trigger is never due on a timer.
  The site's visiting cadence is the shortest frequency anyone chose for one of its pages, capped
  by the site's default of a week — so one daily page makes the site visited daily, and that visit
  fetches only what is due. **Crawl now** records a request on the site (`crawlRequestedAt`) and
  makes it due immediately; the page shows "Queued" — through a reload — until the scheduler's
  next pass starts the run, then "Crawling" with live progress. Setting a site up for the first
  time leaves the same mark, so **Start crawling this site** lands on "Queued" as well.
- **A crawl that could fetch nothing is refused, not queued.** When the workspace's month cannot
  pay for a single page, the first setup (`PUT /crawl` on a workspace with no site yet), **Crawl
  now**, **Fresh crawl** (`POST /crawl/runs`) and one page's **Crawl now** (`POST /crawl/recrawl`)
  are answered `403 CRAWL_NOT_INCLUDED` when the month's allowance is zero — the plan includes no
  crawl pages, which is how a deployment pauses a workspace — and `409 CRAWL_BUDGET_SPENT` when it
  had pages and has none left; the message says when crawling resumes only when that is true
  (`resumesAt`, below). Saving the settings of a site that exists is always accepted. The page
  reads the same from `budget.state` and disables those buttons with the reason under them. The
  scheduler's own visits still run, since discovery is free; a run that runs out part-way ends
  `succeeded` with `pagesSkippedNoBudget`, which the page shows as "Stopped: out of crawl pages".
- **Fresh crawl**, beside "Crawl now" and confirmed with a second press, asks for every eligible
  page of the site in full: each page is marked wanted and its cached validators are forgotten, so
  nothing comes back "unchanged" (`POST /crawl/runs` with `{ "fresh": true }`). Frequencies are
  ignored for that one crawl and untouched afterwards; history is kept. It spends crawl budget for
  the whole site.
- **Markdown for every page.** While fetching, the crawler converts each page that came back 2xx to
  content-only Markdown (`agents/src/crawler/markdown.js`), from the HTML in hand and with no model:
  - **What is stripped.** Navigation, sidebars, forms, cookie banners, and the page's own header
    and footer. A `<header>` or `<footer>` inside an article, a section or the main content is kept,
    by the same rule the image inventory uses (`isPageLevel` in `extract.js`), because that is
    where a post's title and a quotation's attribution sit. A block before the first heading that
    is at least 90% link text and holds eight or more links is dropped as a menu that was not
    marked as one.
  - **Which root.** The first of `main`, the largest `article`, and the usual content class names
    that holds at least 60% of the text left once the chrome is gone; otherwise the body. A post
    with three related-post cards is its article; a listing of nine `<article>` cards is the page,
    not its first card.
  - **What is cleaned.** Images with no usable alt — missing, empty, `null`, a file name — are
    dropped unless a `<figure>` caption can stand in for it; `title` attributes go; Next.js and
    Storyblok rendition addresses are unwrapped to the original asset; links are made absolute and
    normalised with the site's own URL rules, as the crawler stores pages, keeping their `#fragment`.
  - **How it is written.** Links and images the layout puts side by side get a line each; blocks
    inside a link or a table cell become inline text; a second H1 and every heading after it drop a
    level; a `<details>` summary becomes a heading and a definition term a bold line; list items are
    `- item`; non-breaking spaces outside code become spaces. A page whose H1 did not survive gets it
    back at the top.

  A front-matter block records the URL, title, description, canonical, language, and fetch time.
  The hash covers all of it but the fetch time, so a page fetched again unchanged is not rewritten;
  `words` counts prose only, with no image and no address. The latest rendering is kept per page in
  `crawl_page_markdown`, written only when its hash changes, capped at 1 MB with a marker. A 304
  leaves it untouched. It is served as text at `GET /crawl/pages/{urlHash}/markdown` and offered on
  the page panel with show, copy, and download. Pages crawled before this shipped get theirs on the
  next fetch; a fresh crawl fills the whole site. The same holds for a change to these rules: a page
  is rendered again only when it is next fetched in full, because the HTML is not kept.
- **A list of every page's images.** While fetching, the crawler also lists the page's `<img>`
  elements one by one (`imageInventory` in `agents/src/crawler/extract.js`), as
  `extracted.imageInventory` on the snapshot: each image's absolute address — read from `data-src`,
  `srcset` or a `<picture>`'s `<source>` when `src` is a placeholder — whether its alt attribute
  is missing, empty or present, the text, where it links, the heading, caption and text beside it,
  the size the markup states, and whether it is in the page's content, header, footer or
  navigation. At most 200 a page; the rest are counted. The counts in `extracted.images`
  (`total`, `missingAlt`) are unchanged and the list always adds up to them. It costs no request:
  it is read from the HTML already in hand. No script is run, so an image a script adds is not in
  it. Pages crawled before this shipped get their list on the next full fetch; a fresh crawl
  fills the whole site. Nothing in this repository reads the list yet; it is kept on the snapshot
  for whatever does.
- **The rest of what a page says about itself.** Beside the images, each snapshot's `extracted`
  holds the title and meta description with their lengths, the robots directives, the canonical
  as written, the language and `hreflang` alternates, the H1–H3 headings, a word count and a hash
  of the readable text, the `@type` of every JSON-LD block (`structuredDataTypes`), the dates the
  page states and its Open Graph tags (`extractPage` in `agents/src/crawler/extract.js`). Values
  are kept as the markup wrote them, not as verdicts, and extraction collects more than the Library
  and the brand read: a field added later costs a fresh crawl of every site to fill.
- **Crawl frequencies are chosen by a person, per page, with no AI involved.** Every page starts on
  manual trigger: it is fetched once when discovered and again only when somebody asks.
  **Set crawl frequencies**, beside "Crawl now", opens the page list with checkboxes. Tick pages or
  whole folders, choose daily, weekly, monthly, or manual trigger, and apply; the choice is written
  to each page as its own override (`PUT /crawl/frequencies`), so a folder-wide choice and a
  single-page choice cannot disagree about a page. A folder means every page under it as the crawl
  knows it today; pages found later start on manual trigger until chosen for.
- A page's frequency is resolved in this order: its own override, then an override saved for its
  route pattern, otherwise never. The web app writes only per-page overrides; per-pattern
  overrides are accepted by the API as `crawlScheduleOverrides` in the site settings
  (`PUT /crawl`), and nothing in the web app sets them. The resolved value is written onto each
  page whenever an input changes, so the crawler only compares two fields per page.
- The route tree shows each page's frequency, and a folder's when everything under it shares one pattern. A page's detail panel lets it be pinned to its own frequency — including never — or returned to its pattern's, and has its own "Crawl now". A hand-triggered crawl marks the pages wanted and makes the site due; the request is satisfied by the next fetch, so it survives a run that ran out of budget before reaching the page.
- The budget is the workspace's: one `crawl_budget_periods` document per workspace and UTC month, whoever in it starts a crawl, with the owner recorded on it (`userId`). The workspace's plan limits set its monthly page allowance (`monthlyCrawlPages`), as an extension answers them (docs/architecture/extensions.md). Without one — the open-source edition — every month is unlimited: `allowance` and `remaining` are null, `unlimited` is true, and `consumed` still counts every page fetched.
- `statusFor` (and so `budget` on `GET /crawl`) names the month's situation in `state`: `unlimited`; `available`; `spent`, an allowance above zero with nothing left; or `not-included`, an allowance of zero — the plan includes no crawling, nothing was spent, and the page never words it as a budget used up. `planAllowance` is what the plan sets today, which is what the next month opens with, and `resumesAt` is the first of next month only when the month is spent or empty *and* the plan still has pages (`planAllowance` not 0); otherwise null, and the page promises no date. An install whose web extensions export `crawlBudgetLink` offers it beside those two states (docs/architecture/extensions.md § "Web extensions"); without it the page offers nothing to press.
- The allowance is fixed when a UTC calendar month's budget is first opened. Plan allowance changes apply to the next month; the `grant:crawl-budget` command (`--workspace <id>`, or `--email` of an account that owns one workspace) can top up the current month. Extra grants do not carry into the following month.
- Budgets were kept per account until the `2026-11-13-crawl-budget-per-workspace` migration. It gave the months of an account that owned one workspace to that workspace; an account that owned several keeps its old months as history, without `workspaceId`, and each of its workspaces opened the month it ran in afresh. A deleted workspace's months are kept as the record of what it spent.

## Sources

A workspace reads its website and any other source a person adds (docs/guides/sources.md), and
each source is a crawl site: one `crawl_sites` document, crawled, scheduled, budgeted and handed to
the Library the way the website always was. `describeSource` (`packages/core/src/crawl/sources.js`)
is the one reading of what a site document says about the source it is, with the defaults for a
missing field; the API, the crawler and the Library all go through it.

- **The website** is the source with `primary: true` — one per workspace, made by its first setup
  (`PUT /crawl`), folder `website`. Sites stored before sources existed are made websites by the
  `2026-11-19-sources` migration, and `websiteFilter` also matches one with no `primary` at all, for
  the moment between a process starting and the migration running.
- **Another source** has `primary: false`, a `relation` — `own` (a site of the workspace's) or
  `elsewhere` (pages about it on somebody else's site) — and a `mode`: `site` (the whole host, as
  the website), `section` (`section: "/guides/"`, applied as the include patterns
  `sectionPatterns` gives) or `pages` (`pageUrls`, at most 50, all on one host; `elsewhere` is
  always `pages`). It also carries `name`, `folder`, `purpose`, `knowledgeUse`,
  `excludePatterns` ("Leave out", which the scope has always compiled), `pageIntervalHours`,
  `followPagination` and `host`.
- **One source per host.** Unique indexes on `{workspaceId, host}` and `{workspaceId, folder}` (and
  `{workspaceId}` where `primary`) keep a page from being crawled, copied and indexed twice, which
  is also what lets the Library key a page by its URL hash across the workspace. A website moved to
  a host another source reads is refused (`409 SOURCE_HOST_TAKEN`).

**A list of pages** (`mode: "pages"`) is a scope of its own in `createScope`: an address is in it
when it is one of the listed pages, or — with `followPagination` — a later page of a listing among
them, recognised from the address alone by `paginationOf`: exactly one of the query parameters
`page`, `p`, `pg`, `paged`, `pagenum`, `page_num`, `offset` or `start` holding a number, or a path
ending `/page/N`, with the rest of the address the listed page's. Decided from the address, not the
link that led there, so discovery and the fetch step give the same answer. Everything else on the
host is refused as `NOT_LISTED` and, like an address on another host (`FOREIGN_REASONS`), recorded
as an edge and never registered. Discovery registers every listed page as a seed and reads no
sitemaps; depth is the next-page chain, capped at 30 (`SOURCE_LIMITS.pagination`); finalize
measures depth from every listed page, and a refusal of any listed page is a refusal of the site.

**How often.** A source's `pageIntervalHours` is the frequency of a page nobody chose for: after a
per-page override and a per-pattern one, before "never" (`effectiveIntervalHours`). A source a
person adds starts weekly — adding it was the choice — and the website with none, as before.

**The budget is the workspace's.** A fetch for a source other than the website passes
`reserveShare: SOURCE_RESERVE_SHARE` (0.2) to `consume`, so the last fifth of the month is left to
the website, which everything else is built on.

**Stopping a crawl.** `POST …/crawl/stop` sets `cancelRequestedAt` on the running run. Every fetch
and discovery job checks it before its request (`isRunStopped`), counts `pagesSkippedStopped`
and asks for nothing; finalize closes the run as `cancelled`, and what was read stays. A crawl that
was asked for and has not started is withdrawn instead, and the site's next visit goes back to its
cadence.

**Routes.** Every crawl route is served twice: at `/v1/workspaces/:id/crawl`, the website's as it
always was, and at `/v1/workspaces/:id/sources/:sourceId/crawl` for any source (`website` names the
website there too). Only the website's crawl is set up with `PUT /crawl`; another source's settings
are `PATCH /v1/workspaces/:id/sources/:sourceId`. The sources themselves are
`backend/src/routes/sourceRoutes.js`:

- `GET /sources` — every source with its state (`queued`, `first-read`, `reading`, `up-to-date`,
  `refused`, `rate-limited`, `failed`, `stopped`, `out-of-budget`, `never-read`), its pages known,
  copied and chosen, and the figures All sources heads with.
- `POST /sources/check` — what an address is before it is added: whose it looks like (under the
  website's domain, `isUnderDomain`, or not), whether a known review, directory or social site
  (`backend/src/services/sourceHosts.js`) says what kind of page it is or that the site cannot be
  read, and what the page answers (`pageProbe.js`: as OrbikBot, robots.txt first, every hop checked
  to be on the public internet, as the crawler's fetcher checks). Nothing is saved.
- `POST /sources` (member) — adds a source and makes it due at once; `GET` / `PATCH` / `DELETE
  /sources/:sourceId` — one source, its settings, and (admin; not the website, not while it is
  read) its removal: its crawl data, its branch of the Library, its state and ledger rows and its
  pages' index points.
- `GET /sources/suggestions`, `POST /sources/suggestions/dismiss` — the website's links to known
  profile pages (`crawl_links` with `internal: false`) that are not sources yet, most linked first.

The activity monitor names the source of each crawl (`sourceId`, `sourceName`, `primary` on a
crawl item), since a workspace can be reading two at once, and reports a crawl once: crawler runs
are not listed as agent runs as well.

## Feedback

A run's phase is one of: **queued** (waiting for the sites ahead of it), **discovering**, **fetching** (shown as "Crawling"), and **finalizing** (shown as "Working out the site's structure" on the crawl page and "Finishing" in the sidebar, which also says "Starting" for a run that has begun but counted nothing yet). Discovery is a few seconds of robots.txt and sitemaps when there is no discovery pass, and indeterminate until its frontier drains when there is one. Crawl progress is "fetched of about N", where N is the pages fetched plus the fetches still queued: it grows while a crawl is finding pages by their links, which is why it is a count and not a percentage. It includes unchanged pages; deferred pages remain incomplete.

Three reads keep the web app current, each at its own pace:

- **Crawl status** (`GET /crawl`), shared by the sidebar and the crawl page, is re-read every four seconds while a crawl is running or queued and every thirty seconds otherwise, which is how a crawl the scheduler started gets noticed. When it sees a crawl get queued, start or end, it has the activity monitor (below) read again at once, so a crawl shorter than the monitor's idle interval is not missed. The page's table of pages (`GET /crawl/tree`) is remounted when the run starts and when it ends, and while it runs its top level is read again in place as the figures grow, keeping open folders open. A notice about an action ("Crawl queued…") is shown only until the crawl moves to its next stage.
- **The figures' lists** (`GET /crawl/findings?kind=broken|orphans|duplicates&limit&skip`): pressing **Broken**, **Nothing links here** or **Duplicate URLs** lists those pages flat, by address, in place of the tree. The figures on `GET /crawl` (`urls.broken`, `urls.orphans`, `urls.duplicates`) are counted from `crawl_urls` by the same filters, so the two agree: broken is a last status of 400 or more on a page that is not a duplicate, as in the tree.
- **The crawl page's activity log** (`GET /crawl/activity`) is re-read every two seconds while a crawl is live. It shows queue position, the phase, a progress bar, recent job outcomes and retry messages, fetched pages, and budget deferrals.
- **The activity monitor** at the foot of the sidebar polls `GET /v1/activity` and shows, across every workspace the account owns: crawls that are queued or running with a progress bar, agent runs that are queued, waiting for a machine, or running with the tool they are on, model calls in flight, and the Library agent copying a site's pages into Sources (a queue job rather than a run, reported under `library`). It asks every three seconds while something is live and every fifteen when not.

Deploy the API, worker, scheduler and frontend together: a worker from before the lease was held per run and one from after do not agree on when it is given back. The shared `crawl_queue_locks` collection uses MongoDB's built-in unique `_id` index; no external queue service is required.

## A site that will not let the crawler in

A site behind bot protection answers the crawler with a refusal or a "prove you are a browser"
page instead of its content. Stored as pages those are worse than nothing — several services send
the challenge with a 200, which would put an empty, `noindex` home page in the Library — so the
crawler recognises them and stops (`agents/src/crawler/siteBlock.js`):

- **What counts.** A *challenge* is a bot-protection service's own page, recognised by a header
  only a challenge carries (`cf-mitigated`, `x-amzn-waf-action`, `x-vercel-mitigated`) or by the
  service's markup on a page with almost no words of its own, whatever the status. Imperva,
  Cloudflare, DataDome, Akamai, AWS WAF, HUMAN, Sucuri and Vercel are known; only Imperva's
  signature has been checked against a live site. A *refusal* is a bare 401 or 403.
- **When the run stops.** At once when the seed is answered with either — discovery asks for it
  first, so this is before any crawl budget is spent — and after five challenges in a row anywhere
  else. A 401 or 403 on any other page is still a finding about that page, recorded as before: a
  site that starts answering every page with a plain 403 mid-crawl is not caught.
- **What is kept.** Nothing is written for a blocked page: no snapshot, no Markdown, and the URL
  stays unfetched, so what was last really read stays in the Library. A charge already made is
  refunded. The rest of the run's jobs drain without a request (`pagesSkippedBlocked`).
- **What a person sees.** The run ends `failed` with `ACCESS_REFUSED` and a message naming the
  host, the service, the status and the fix: allow the user agent `OrbikBot` in that service's bot
  rules. The run's `block` record holds the same facts, and `crawl.completed` carries `blocked`.

The crawler does not disguise itself, run the challenge's script or change address to get past
one. Being allowed in by the site's owner is the only supported route.
