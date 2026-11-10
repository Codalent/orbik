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
- The account's plan limits set its monthly page allowance (`monthlyCrawlPages`), as an extension answers them (docs/architecture/extensions.md). Without one — the open-source edition — every month is unlimited: `allowance` and `remaining` are null, `unlimited` is true, and `consumed` still counts every page fetched.
- The allowance is fixed when a UTC calendar month's budget is first opened. Plan allowance changes apply to the next month; the existing `grant:crawl-budget` command can top up the current month. Extra grants do not carry into the following month.

## Feedback

A run's phase is one of: **queued** (waiting for the sites ahead of it), **discovering**, **fetching** (shown as "Crawling"), and **finalizing** (shown as "Working out the site's structure" on the crawl page and "Finishing" in the sidebar, which also says "Starting" for a run that has begun but counted nothing yet). Discovery is a few seconds of robots.txt and sitemaps when there is no discovery pass, and indeterminate until its frontier drains when there is one. Crawl progress is "fetched of about N", where N is the pages fetched plus the fetches still queued: it grows while a crawl is finding pages by their links, which is why it is a count and not a percentage. It includes unchanged pages; deferred pages remain incomplete.

Three reads keep the web app current, each at its own pace:

- **Crawl status** (`GET /crawl`), shared by the sidebar and the crawl page, is re-read every four seconds while a crawl is running or queued and every thirty seconds otherwise, which is how a crawl the scheduler started gets noticed.
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
