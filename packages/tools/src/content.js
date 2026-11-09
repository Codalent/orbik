import { AGENT_COLLECTIONS, SOURCE_STATUS, SOURCE_STATUS_VALUES, escapeRegExp } from "@orbik/core";
import { CHUNK_SOURCE_KINDS, LIBRARY_LIMITS, LIBRARY_NODE_KINDS, LIBRARY_SOURCE_KINDS } from "@orbik/library";

import { MAX_URL, boundedInteger, rejectUnknown, requireString, requireStringArray, requiredBoolean } from "./args.js";
import { ToolError, defineTool } from "./registry.js";
import { requireAgentSlug, requireSite, requireWorkspace } from "./scope.js";
import { excludedRoutes, reviewRoutes, reviewSourceUrls } from "./sources.js";

/**
 * Tools that read the site's own words — the Markdown the crawler rendered from every page — and
 * say which of them this agent has already accounted for.
 *
 * The second part is what makes an agent that runs every week affordable. A Library built from a
 * hundred pages must not be rebuilt from a hundred pages every Monday: the useful question on the
 * second run is "which pages are new, and which have actually changed", and that is answered here
 * from stored content hashes rather than from a crawl timestamp. A crawl that re-fetched a page
 * without changing a word leaves the status at `current`, and an agent that trusted `updatedAt`
 * would have rewritten its whole Library for nothing.
 *
 * Selection used to be page by page, and it did not scale. On a fifty-page marketing site judging
 * every row is merely wasteful; on a two-thousand-page site it is the entire run, and the verdicts
 * expire the moment somebody publishes another post. So the unit of judgement here is the
 * **route** — `/blog/[slug]` is one decision that stands for every post published under it,
 * forever, with a per-page verdict still able to pull one back in by name. A site is ten to thirty
 * routes; it is never two thousand independent questions.
 *
 * Every query is scoped by `siteId`, `workspaceId` and `agentSlug` from the run's scope, never
 * from arguments.
 */

/** How many pages one `readPages` call may open. More than this is a plan, not a question. */
const MAX_PAGES_PER_READ = 4;

/**
 * Characters of Markdown one call may return in total, across every page it opened.
 *
 * A page or two of an ordinary marketing site. A tool result is a message in the model's
 * conversation, not a file handed back and forgotten: every later turn of the run carries it, and
 * a runtime that compacts a full context has to be able to make progress afterwards. Keeping one
 * result to a few thousand tokens is what makes "read the site" a sequence of small complete reads
 * rather than a few large ones a long run cannot carry.
 */
const MAX_READ_CHARACTERS = 15_000;

/** Characters any single page may contribute, so one enormous page cannot spend the whole budget. */
const MAX_PAGE_CHARACTERS = 12_000;

/**
 * The pipeline stages that attach this agent's verdict to every rendered page.
 *
 * Expressed as a lookup rather than as two queries joined in memory because a large site has tens
 * of thousands of pages and the status filter has to be applied before paging — "show me what is
 * new" must return the first page of what is new, not the new rows that happen to fall inside the
 * first fifty pages of the alphabet.
 *
 * The crawler's own signals are joined in beside the verdict. It already knows which pages are
 * shallow, which are linked to from everywhere, and which the sitemap names; none of that used to
 * reach the model, which was left to judge a page from its URL and a word count.
 */
function withStatusAndSignals({ scope, excluded }) {
  return [
    { $match: { siteId: scope.siteId } },
    {
      $lookup: {
        from: AGENT_COLLECTIONS.knowledgeSources,
        let: { pageKey: "$urlHash" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$workspaceId", scope.workspaceId] },
                  { $eq: ["$agentSlug", scope.agentSlug] },
                  { $eq: ["$sourceKind", LIBRARY_SOURCE_KINDS.page] },
                  { $eq: ["$sourceKey", "$$pageKey"] },
                ],
              },
            },
          },
          { $project: { relevant: 1, reason: 1, reviewedHash: 1, reviewedAt: 1 } },
        ],
        as: "review",
      },
    },
    { $set: { review: { $first: "$review" } } },
    {
      $lookup: {
        from: AGENT_COLLECTIONS.urls,
        let: { pageHash: "$urlHash" },
        pipeline: [
          {
            $match: {
              $expr: { $and: [{ $eq: ["$siteId", scope.siteId] }, { $eq: ["$urlHash", "$$pageHash"] }] },
            },
          },
          { $project: { routePattern: 1, depth: 1, pathDepth: 1, inboundCount: 1, sitemap: 1 } },
        ],
        as: "registry",
      },
    },
    { $set: { registry: { $first: "$registry" } } },
    {
      $set: {
        routePattern: "$registry.routePattern",
        depth: { $ifNull: ["$registry.depth", "$registry.pathDepth"] },
        inboundCount: { $ifNull: ["$registry.inboundCount", 0] },
        inSitemap: { $ne: [{ $type: "$registry.sitemap" }, "missing"] },
        status: {
          $switch: {
            branches: [
              // A per-page verdict always wins over its route, so a pillar guide under an excluded
              // route can be pulled back in by name and stays in.
              { case: { $eq: ["$review.relevant", false] }, then: SOURCE_STATUS.excluded },
              {
                case: {
                  $and: [
                    { $eq: [{ $type: "$review" }, "missing"] },
                    { $in: [{ $ifNull: ["$registry.routePattern", ""] }, excluded] },
                  ],
                },
                then: SOURCE_STATUS.excludedByRoute,
              },
              { case: { $eq: [{ $type: "$review" }, "missing"] }, then: SOURCE_STATUS.new },
              // On the ledger and never read: chosen for this agent by code, with nothing written
              // from it yet. A review always records the hash it was made at, so a row without
              // one is a page still waiting, not one that changed.
              { case: { $eq: [{ $ifNull: ["$review.reviewedHash", null] }, null] }, then: SOURCE_STATUS.new },
              { case: { $ne: ["$review.reviewedHash", "$hash"] }, then: SOURCE_STATUS.changed },
            ],
            default: SOURCE_STATUS.current,
          },
        },
      },
    },
  ];
}

/**
 * Lists the shapes of page a site has, with what this agent has decided about each.
 *
 * This is the first call of a first run on anything larger than a brochure. A two-thousand-page
 * site is twenty routes; reading twenty rows and excluding three of them is a minute's work whose
 * answer keeps holding as the site grows, where judging two thousand pages is the whole run and
 * has to be redone every week.
 */
const listContentRoutes = defineTool({
  name: "content.listRoutes",
  description:
    "List the site's route patterns — the shapes of page it has, such as /[slug] or " +
    "/blog/[slug] — with how many pages each holds, how deep they sit, how many the sitemap " +
    "names, the dominant kind of content, the median length, and a few sample titles. Start here " +
    "on any site with more than a few dozen pages: decide which shapes of page explain the " +
    "business, exclude the ones that do not with content.review, and only then look at pages.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  parseInput(input, errors) {
    rejectUnknown(input, [], errors);
    return {};
  },
  async handler(_input, { database, scope }) {
    const siteId = requireSite(scope);
    const agentSlug = requireAgentSlug(scope);
    const workspaceId = requireWorkspace(scope);

    const verdicts = await database
      .collection(AGENT_COLLECTIONS.knowledgeSources)
      .find({ workspaceId, agentSlug, sourceKind: LIBRARY_SOURCE_KINDS.route })
      .project({ sourceKey: 1, relevant: 1, reason: 1 })
      .toArray();
    const byRoute = new Map(verdicts.map((row) => [row.sourceKey, row]));

    const rows = await database
      .collection(AGENT_COLLECTIONS.urls)
      .aggregate([
        {
          $match: {
            siteId,
            routePattern: { $type: "string" },
            // A trailing-slash twin is the same page; counting it would double every route.
            $or: [{ variantOf: null }, { variantOf: { $exists: false } }],
          },
        },
        {
          $lookup: {
            from: AGENT_COLLECTIONS.markdown,
            let: { pageHash: "$urlHash" },
            pipeline: [
              { $match: { $expr: { $and: [{ $eq: ["$siteId", siteId] }, { $eq: ["$urlHash", "$$pageHash"] }] } } },
              // The H1 stands in when the served HTML carried no <title>, which is common on
              // sites that set their metadata in the browser. A row labelled by its heading is
              // useful; a row labelled `null` is a row the model has to open to identify.
              { $project: { words: 1, title: { $ifNull: ["$title", "$heading"] }, contentType: 1, structuredDataTypes: 1 } },
            ],
            as: "content",
          },
        },
        { $set: { content: { $first: "$content" } } },
        {
          $group: {
            _id: "$routePattern",
            pages: { $sum: 1 },
            rendered: { $sum: { $cond: [{ $eq: [{ $type: "$content" }, "missing"] }, 0, 1] } },
            minDepth: { $min: { $ifNull: ["$pathDepth", 0] } },
            maxDepth: { $max: { $ifNull: ["$pathDepth", 0] } },
            inSitemap: { $sum: { $cond: [{ $ne: [{ $type: "$sitemap" }, "missing"] }, 1, 0] } },
            words: { $push: "$content.words" },
            contentTypes: { $push: "$content.contentType" },
            samples: { $topN: { n: 3, sortBy: { pathDepth: 1, url: 1 }, output: { url: "$url", title: "$content.title" } } },
          },
        },
        { $sort: { pages: -1, _id: 1 } },
        { $limit: 60 },
      ])
      .toArray();

    return {
      total: rows.length,
      routes: rows.map((row) => {
        const verdict = byRoute.get(row._id);
        return {
          pattern: row._id,
          pages: row.pages,
          rendered: row.rendered,
          depth: { min: row.minDepth, max: row.maxDepth },
          inSitemap: row.inSitemap,
          contentType: dominant(row.contentTypes),
          medianWords: median(row.words),
          samples: (row.samples ?? []).map((sample) => ({ url: sample.url, title: sample.title ?? null })),
          verdict: verdict ? (verdict.relevant ? "included" : "excluded") : null,
          reason: verdict?.reason ?? null,
        };
      }),
    };
  },
});

/**
 * Lists every page of the site that has Markdown, with what this agent has made of it.
 *
 * Ordered by how much the page is likely to matter — shallow first, then by how many other pages
 * link to it — rather than alphabetically by URL. The crawler knows which pages a visitor lands
 * on; sorting by URL threw that away and put `/about-cookies` above the home page.
 */
const listContentPages = defineTool({
  name: "content.listPages",
  description:
    "List the site's pages that have Markdown content, most important first, with the title, word " +
    "count, how deep the page sits, how many pages link to it, whether the sitemap names it, its " +
    "route pattern, and this agent's status for each: new (never reviewed), changed (reviewed " +
    "before and the content has changed since), current (reviewed and unchanged), excluded " +
    "(judged not relevant), or excluded-by-route (its whole route was excluded). Pages excluded " +
    "by their route are left out unless you ask for them. The counts in the reply tell you how " +
    "much there is to do before you read anything.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: SOURCE_STATUS_VALUES,
        description: "Only pages with this status. Omit for everything except pages excluded by their route.",
      },
      route: { type: "string", description: "Only pages of this route pattern, exactly as content.listRoutes wrote it." },
      search: { type: "string", description: "Only pages whose URL or title contains this text." },
      limit: { type: "integer", description: "How many pages to return (1-500). Defaults to 100." },
      offset: { type: "integer", description: "How many pages to skip, for paging." },
    },
    additionalProperties: false,
  },
  parseInput(input, errors) {
    const source = rejectUnknown(input, ["status", "route", "search", "limit", "offset"], errors);
    const status = requireString(source.status, "status", { max: 32, required: false }, errors);
    if (status && !SOURCE_STATUS_VALUES.includes(status)) {
      errors.push(`status must be one of ${SOURCE_STATUS_VALUES.join(", ")}.`);
    }
    return {
      status: status || undefined,
      route: requireString(source.route, "route", { max: 300, required: false }, errors) || undefined,
      search: requireString(source.search, "search", { max: 200, required: false }, errors) || undefined,
      limit: boundedInteger(source.limit, "limit", { min: 1, max: 500, fallback: 100 }, errors),
      offset: boundedInteger(source.offset, "offset", { min: 0, max: 100_000, fallback: 0 }, errors),
    };
  },
  async handler(input, { database, scope }) {
    requireSite(scope);
    requireAgentSlug(scope);
    requireWorkspace(scope);
    const excluded = await excludedRoutes({ database, scope });

    const filters = [];
    if (input.status) filters.push({ $match: { status: input.status } });
    // Pages hidden by a route verdict are the point of having route verdicts: they must not
    // arrive as rows to judge. They are still counted, so the reply says how many were set aside
    // and by which decision.
    else filters.push({ $match: { status: { $ne: SOURCE_STATUS.excludedByRoute } } });
    if (input.route) filters.push({ $match: { routePattern: input.route } });
    if (input.search) {
      // Escaped and anchored to nothing: a search is a substring of a URL or a title, and a model
      // that wrote a regular expression by accident must not get one.
      const pattern = new RegExp(escapeRegExp(input.search), "i");
      filters.push({ $match: { $or: [{ url: pattern }, { title: pattern }] } });
    }

    const [result] = await database
      .collection(AGENT_COLLECTIONS.markdown)
      .aggregate([
        ...withStatusAndSignals({ scope, excluded }),
        {
          $facet: {
            counts: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
            total: [...filters, { $count: "count" }],
            page: [
              ...filters,
              // Importance, not the alphabet: the pages a visitor lands on and the pages the rest
              // of the site points at are the ones that explain the business.
              { $sort: { depth: 1, inboundCount: -1, url: 1 } },
              { $skip: input.offset },
              { $limit: input.limit },
              {
                $project: {
                  _id: 0,
                  url: 1,
                  title: { $ifNull: ["$title", "$heading"] },
                  words: 1,
                  status: 1,
                  depth: 1,
                  inboundCount: 1,
                  inSitemap: 1,
                  routePattern: 1,
                  contentType: 1,
                  changedAt: "$updatedAt",
                  reason: "$review.reason",
                  reviewedAt: "$review.reviewedAt",
                },
              },
            ],
          },
        },
      ])
      .toArray();

    const counts = Object.fromEntries(SOURCE_STATUS_VALUES.map((status) => [status, 0]));
    for (const row of result?.counts ?? []) counts[row._id] = row.count;

    return {
      counts,
      excludedRoutes: excluded,
      total: result?.total?.[0]?.count ?? 0,
      offset: input.offset,
      pages: (result?.page ?? []).map((page) => ({
        url: page.url,
        title: page.title ?? null,
        words: page.words ?? 0,
        status: page.status,
        depth: page.depth ?? null,
        inboundCount: page.inboundCount ?? 0,
        inSitemap: page.inSitemap === true,
        routePattern: page.routePattern ?? null,
        contentType: page.contentType ?? null,
        changedAt: page.changedAt ? new Date(page.changedAt).toISOString() : null,
        reviewedAt: page.reviewedAt ? new Date(page.reviewedAt).toISOString() : null,
        reason: page.reason ?? null,
      })),
    };
  },
});

/**
 * Opens several pages at once, within a ceiling the run cannot talk its way past.
 *
 * A batch rather than one page per call because a run has a limited number of turns, and reading a
 * site one page at a time would spend them all on fetching instead of on thinking.
 *
 * The run-wide ceiling is enforced here rather than written in instructions. "Twenty to twenty-five
 * pages is plenty" was a sentence in a prompt, which is a suggestion to a model: a run that decided
 * it needed sixty read sixty, filled its context, and left nothing behind. A tool that refuses and
 * says why turns that into a decision the model makes with its eyes open — which is also the
 * moment it writes what it has instead of reading more.
 */
const readContentPages = defineTool({
  name: "content.readPages",
  description:
    "Read the Markdown of several pages in one call, given their exact URLs from " +
    "content.listPages. Each page begins with front matter carrying its URL, title, and meta " +
    `description. A call returns at most ${MAX_READ_CHARACTERS.toLocaleString("en-US")} characters ` +
    "in total — usually one or two pages — so ask for two at a time, most important first, and " +
    "call it again for the next two. Pages that did not fit are named in `skipped`. A run has a " +
    "ceiling on how much of a site it may read in total; the reply says how much is left.",
  inputSchema: {
    type: "object",
    properties: {
      urls: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: MAX_PAGES_PER_READ,
        description: "Exact page URLs, as returned by content.listPages. Two is the useful number.",
      },
    },
    required: ["urls"],
    additionalProperties: false,
  },
  parseInput(input, errors) {
    const source = rejectUnknown(input, ["urls"], errors);
    return {
      urls: requireStringArray(source.urls, "urls", { max: MAX_PAGES_PER_READ, itemMax: MAX_URL }, errors),
    };
  },
  async handler(input, { database, scope, readingBudget }) {
    const siteId = requireSite(scope);

    if (readingBudget && readingBudget.remaining() <= 0) {
      throw new ToolError({
        code: "READING_BUDGET_SPENT",
        message:
          `This run has read its whole allowance of ${readingBudget.pages} pages ` +
          `(${readingBudget.characters.toLocaleString("en-US")} characters). That is deliberate: the ` +
          "Library is a briefing, not an archive. Write up what you have read, account for the rest " +
          "with content.review, and finish.",
      });
    }

    const documents = await database
      .collection(AGENT_COLLECTIONS.markdown)
      .find({ siteId, url: { $in: input.urls } })
      .project({ url: 1, title: 1, heading: 1, markdown: 1, words: 1, updatedAt: 1 })
      .toArray();

    const byUrl = new Map(documents.map((document) => [document.url, document]));
    const pages = [];
    const skipped = [];
    const missing = [];
    let budget = MAX_READ_CHARACTERS;

    // In the order the caller asked for, so a model that listed its most important pages first
    // gets those and not an arbitrary twenty.
    for (const url of input.urls) {
      const document = byUrl.get(url);
      if (!document) {
        missing.push(url);
        continue;
      }
      if (budget <= 0 || (readingBudget && readingBudget.remaining() <= 0)) {
        skipped.push(url);
        continue;
      }
      const allowance = Math.min(MAX_PAGE_CHARACTERS, budget);
      const text = document.markdown ?? "";
      const truncated = text.length > allowance;
      const used = Math.min(text.length, allowance);
      budget -= used;
      readingBudget?.spend(used);
      pages.push({
        url: document.url,
        title: document.title ?? document.heading ?? null,
        words: document.words ?? 0,
        changedAt: document.updatedAt ? new Date(document.updatedAt).toISOString() : null,
        truncated,
        markdown: truncated ? `${text.slice(0, allowance)}\n\n<!-- cut off: this page was too long to include whole -->\n` : text,
      });
    }

    return {
      pages,
      skipped,
      missing,
      budget: readingBudget
        ? {
          pagesRead: readingBudget.pagesRead,
          pagesLeft: Math.max(0, readingBudget.pages - readingBudget.pagesRead),
          charactersLeft: Math.max(0, readingBudget.characters - readingBudget.charactersRead),
        }
        : null,
    };
  },
});

/** Longest reason a verdict may carry; it is one sentence a person reads, not an essay. */
const MAX_REVIEW_REASON = 400;

/**
 * Records a verdict on pages or whole routes without writing anything from them.
 *
 * This is what closes the loop on a run. Pages an agent decided to ignore, and pages it read and
 * found nothing new in, have to be recorded as reviewed or they arrive as "new" or "changed" again
 * next week, forever. Saying so explicitly — with the reason — is also what lets a person read
 * back *why* the blog was left out.
 *
 * Routes are the version of that which keeps working. A verdict on `/blog/[slug]` covers every
 * post published after it, so the answer to "why is next week's post not in here" is a decision
 * somebody can read rather than an omission nobody noticed.
 */
const reviewContentPages = defineTool({
  name: "content.review",
  description:
    "Record what you made of source material you are not writing anything from. Give `routes` to " +
    "judge whole shapes of page at once — excluding /blog/[slug] covers every post published " +
    "after today, which judging posts one at a time never does — and `urls` for individual pages: " +
    "ones you are ignoring (relevant false, with the reason), and ones you read and found nothing " +
    "worth changing in (relevant true). A verdict on a page overrides its route. Call this before " +
    "you finish, for everything you looked at and did not use.",
  inputSchema: {
    type: "object",
    properties: {
      urls: {
        type: "array",
        items: { type: "string" },
        maxItems: 500,
        description: "Exact page URLs from content.listPages.",
      },
      routes: {
        type: "array",
        items: { type: "string" },
        maxItems: 60,
        description: "Route patterns exactly as content.listRoutes wrote them, e.g. /blog/[slug].",
      },
      relevant: {
        type: "boolean",
        description: "True when this material belongs in this agent's output, false when it does not.",
      },
      reason: { type: "string", description: "Why, in one short sentence. It is shown to the person." },
    },
    required: ["relevant", "reason"],
    additionalProperties: false,
  },
  parseInput(input, errors) {
    const source = rejectUnknown(input, ["urls", "routes", "relevant", "reason"], errors);
    const urls = requireStringArray(source.urls, "urls", { max: 500, itemMax: MAX_URL, required: false }, errors);
    const routes = requireStringArray(source.routes, "routes", { max: 60, itemMax: 300, required: false }, errors);
    if (!urls.length && !routes.length) errors.push("Give at least one of urls or routes.");
    return {
      urls,
      routes,
      relevant: requiredBoolean(source.relevant, "relevant", errors),
      reason: requireString(source.reason, "reason", { max: MAX_REVIEW_REASON }, errors),
    };
  },
  async handler(input, { database, scope }) {
    requireSite(scope);
    requireAgentSlug(scope);
    requireWorkspace(scope);

    const pages = await reviewSourceUrls({
      database,
      scope,
      urls: input.urls,
      relevant: input.relevant,
      reason: input.reason,
    });
    const routes = await reviewRoutes({
      database,
      scope,
      routes: input.routes,
      relevant: input.relevant,
      reason: input.reason,
    });

    return {
      recordedPages: pages.reviewed.length,
      recordedRoutes: routes.reviewed.length,
      unknownPages: pages.unknown,
      unknownRoutes: routes.unknown,
    };
  },
});

/** Listings one site map names. A site has a handful that matter; past this it is a link dump. */
const MAX_MAP_LISTINGS = 30;

/** Groups of stored-only pages one site map describes before the rest are counted together. */
const MAX_MAP_GROUPS = 20;

/** Titles given as a sample of a group. Enough to say what kind of page it holds. */
const MAP_SAMPLE_TITLES = 5;

/** Characters of a page's summary a site map carries. A line, not the page. */
const MAP_SUMMARY_CHARACTERS = 180;

/**
 * The whole site in one call, sized to be read rather than to be complete.
 *
 * This is what the Library agent decides from: what the business is made of, how the Library
 * should be arranged, and which pages to open. It is built by code from what the crawler already
 * stored — titles, descriptions, who links to what — and it fits one tool result on a site of
 * any size, because only the pages chosen for the knowledge base are listed one by one. The
 * rest are counted and sampled by the page that lists them: seven hundred posts are a row that
 * says "700 pages, 2019 to 2026" and five of their titles.
 *
 * The choice it reports is not this tool's and not the model's. Which pages the knowledge base
 * is written from is decided by rule when the site is mirrored, and recorded on each page's
 * state row; this reads it back.
 */
const mapContentSite = defineTool({
  name: "content.siteMap",
  description:
    "The whole site in one reply. `chosen` lists the pages the knowledge base is written from, " +
    "most linked-to first: each with its title, a one-line summary, where its copy is stored " +
    "under /sources, how many pages link to it, and whether you have written from it yet (new), " +
    "it has changed since you did (changed), or neither (current). `listings` are pages of the " +
    "site that list a set of others — the case-studies page, the blog's index — with how many " +
    "they list, a few titles and the dates they span. `stored` describes every other page: " +
    "stored and searchable, not chosen, grouped by the listing they are on. Call it once, early: " +
    "it is how you learn what the site is made of without opening a page.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  parseInput(input, errors) {
    rejectUnknown(input, [], errors);
    return {};
  },
  async handler(_input, { database, scope }) {
    const siteId = requireSite(scope);
    const agentSlug = requireAgentSlug(scope);
    const workspaceId = requireWorkspace(scope);

    const [pages, registry, states, ledger, folders] = await Promise.all([
      database
        .collection(AGENT_COLLECTIONS.markdown)
        .find({ siteId })
        .project({ urlHash: 1, url: 1, title: 1, heading: 1, words: 1, hash: 1, publishedAt: 1 })
        .toArray(),
      database
        .collection(AGENT_COLLECTIONS.urls)
        .find({ siteId })
        .project({ urlHash: 1, inboundCount: 1, depth: 1 })
        .toArray(),
      database
        .collection(AGENT_COLLECTIONS.sourceNotes)
        .find({ workspaceId })
        .project({ sourceKey: 1, path: 1, title: 1, chosen: 1, chosenReason: 1, listedBy: 1, lists: 1, skipped: 1, removed: 1, mirroredAt: 1 })
        .toArray(),
      database
        .collection(AGENT_COLLECTIONS.knowledgeSources)
        .find({ workspaceId, agentSlug, sourceKind: LIBRARY_SOURCE_KINDS.page })
        .project({ sourceKey: 1, reviewedHash: 1 })
        .toArray(),
      database
        .collection(AGENT_COLLECTIONS.libraryNodes)
        .find({ workspaceId, kind: LIBRARY_NODE_KINDS.folder, "listing.key": { $type: "string" } })
        .project({ path: 1, "listing.key": 1 })
        .toArray(),
    ]);

    const pageOf = new Map(pages.map((page) => [page.urlHash, page]));
    const signalOf = new Map(registry.map((row) => [row.urlHash, row]));
    const reviewedAt = new Map(ledger.map((row) => [row.sourceKey, row.reviewedHash ?? null]));
    const folderOf = new Map(folders.map((folder) => [folder.listing.key, folder.path]));
    // Only pages the crawl still has and the source layer holds: a page that left the site is in
    // neither list, and one that is not stored has nothing to open.
    const stored = states.filter((row) => pageOf.has(row.sourceKey) && row.removed !== true && !row.skipped && row.path);
    const stateOf = new Map(stored.map((row) => [row.sourceKey, row]));

    const titleOf = (row) => row.title ?? pageOf.get(row.sourceKey)?.title ?? pageOf.get(row.sourceKey)?.heading ?? null;
    const inboundOf = (row) => signalOf.get(row.sourceKey)?.inboundCount ?? 0;
    const byLinks = (left, right) => inboundOf(right) - inboundOf(left)
      || String(pageOf.get(left.sourceKey).url).localeCompare(String(pageOf.get(right.sourceKey).url));

    const chosenRows = stored.filter((row) => row.chosen === true).sort(byLinks);
    const summaries = chosenRows.length
      ? await database
        .collection(AGENT_COLLECTIONS.libraryNodes)
        .find({ workspaceId, path: { $in: chosenRows.map((row) => row.path) } })
        .project({ path: 1, summary: 1 })
        .toArray()
      : [];
    const summaryOf = new Map(summaries.map((node) => [node.path, node.summary ?? null]));

    const chosen = chosenRows.map((row) => {
      const page = pageOf.get(row.sourceKey);
      const reviewed = reviewedAt.get(row.sourceKey) ?? null;
      const listing = (row.listedBy ?? []).map((key) => pageOf.get(key)).find(Boolean) ?? null;
      const summary = summaryOf.get(row.path) ?? null;
      return {
        url: page.url,
        source: row.mirroredAt ? row.path : null,
        title: titleOf(row),
        summary: summary && summary.length > MAP_SUMMARY_CHARACTERS ? `${summary.slice(0, MAP_SUMMARY_CHARACTERS).trimEnd()}…` : summary,
        words: page.words ?? 0,
        linkedFrom: inboundOf(row),
        depth: signalOf.get(row.sourceKey)?.depth ?? null,
        published: day(page.publishedAt),
        status: !reviewed ? SOURCE_STATUS.new : reviewed !== page.hash ? SOURCE_STATUS.changed : SOURCE_STATUS.current,
        why: row.chosenReason ?? null,
        listedOn: listing?.url ?? null,
      };
    });

    /** A set of pages as a count, the dates they span, and a few of their titles. */
    const describe = (rows) => {
      const dated = rows.map((row) => pageOf.get(row.sourceKey)?.publishedAt).filter(Boolean).map((value) => new Date(value)).sort((a, b) => a - b);
      const newest = [...rows].sort((left, right) => timeOf(pageOf.get(right.sourceKey)?.publishedAt) - timeOf(pageOf.get(left.sourceKey)?.publishedAt) || byLinks(left, right));
      return {
        pages: rows.length,
        published: dated.length ? { from: day(dated[0]), to: day(dated.at(-1)) } : null,
        samples: newest.slice(0, MAP_SAMPLE_TITLES).map((row) => titleOf(row)).filter(Boolean),
      };
    };

    const listingRows = stored.filter((row) => (row.lists ?? 0) > 0).sort((left, right) => right.lists - left.lists);
    const listings = listingRows.slice(0, MAX_MAP_LISTINGS).map((row) => {
      const children = stored.filter((child) => (child.listedBy ?? []).includes(row.sourceKey));
      return {
        url: pageOf.get(row.sourceKey).url,
        title: titleOf(row),
        ...describe(children),
        // The count the source layer made, which is exact; the pages found here are the ones
        // that still name this listing among the few each page remembers.
        pages: row.lists,
        chosen: children.filter((child) => child.chosen === true).length,
        folder: folderOf.get(row.sourceKey) ?? null,
      };
    });

    // Every other page, by the most specific listing it is on. Grouped rather than listed,
    // because this is the part of a site that can be thousands of pages long.
    const rest = stored.filter((row) => row.chosen !== true);
    const groups = new Map();
    for (const row of rest) {
      const key = (row.listedBy ?? []).find((listing) => stateOf.has(listing)) ?? null;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const reasons = {};
    for (const row of rest) reasons[row.chosenReason ?? "pending"] = (reasons[row.chosenReason ?? "pending"] ?? 0) + 1;
    const grouped = [...groups.entries()]
      .sort((left, right) => right[1].length - left[1].length)
      .slice(0, MAX_MAP_GROUPS)
      .map(([key, rows]) => ({ listedOn: key ? pageOf.get(key).url : null, ...describe(rows) }));

    return {
      site: {
        pages: pages.length,
        stored: stored.length,
        chosen: chosen.length,
        notStored: pages.length - stored.length,
      },
      chosen,
      listings,
      listingsOmitted: Math.max(0, listingRows.length - listings.length),
      stored: {
        pages: rest.length,
        why: reasons,
        groups: grouped,
        groupsOmitted: Math.max(0, groups.size - grouped.length),
      },
      note: stored.length
        ? null
        : "The source layer holds nothing yet. The site has not been mirrored since it was crawled; there is nothing to write from in this run.",
    };
  },
});

/** A date as `YYYY-MM-DD`, or null. */
function day(value) {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString().slice(0, 10);
}

/** A date as a number for sorting, with a missing one sorting oldest. */
function timeOf(value) {
  const at = value ? new Date(value).getTime() : 0;
  return Number.isNaN(at) ? 0 : at;
}

/** The value that appears most often, ignoring the gaps. */
function dominant(values) {
  const counts = new Map();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The middle length of a route's pages, ignoring the ones that were never rendered.
 *
 * A median rather than a mean because one three-thousand-word pillar guide in a route of
 * two-hundred-word tag pages would otherwise describe the route as substantial.
 */
function median(values) {
  const numbers = values.filter((value) => typeof value === "number").sort((left, right) => left - right);
  if (!numbers.length) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : Math.round((numbers[middle - 1] + numbers[middle]) / 2);
}

/** Most passages one search may return. Beyond this it is a reading list, not an answer. */
const MAX_SEARCH_RESULTS = 20;

/**
 * Finds the passages of a workspace's documents that answer a question.
 *
 * This is the tool the rest of the retrieval work exists for, and it changes what an agent can
 * know. `content.listPages` can filter titles and URLs by substring and `library.search` scores
 * whole Library files; neither can answer "what does this company say about enterprise pricing"
 * unless somebody put those words in a title. A run that had to find out read pages until it
 * spent its budget, and on a large site never got past the first thirty.
 *
 * Three properties matter more than the ranking:
 *
 * - **The workspace comes from the run's scope.** There is no argument that names one, which is
 *   what makes it impossible for instructions — including instructions a model was talked into by
 *   text it read on a crawled page — to reach another workspace's index.
 * - **Results are passages, not pages.** A section with its heading path, not a whole document, so
 *   a call that found eight relevant things costs a few thousand characters rather than eight
 *   pages of a context the run still has to finish in.
 * - **An unavailable index says so.** Returning nothing would be indistinguishable from "this
 *   site never mentions it", and a model told the second will write that down as a fact.
 */
const searchContent = defineTool({
  name: "content.search",
  description:
    "Search everything this workspace knows — every page of the site and every Library file — by " +
    "meaning rather than by wording, and get back the passages themselves with the heading each " +
    "came from. Use it whenever you need what the company says about a subject and you do not " +
    "already know which page says it: it is far cheaper than reading pages, and it finds the " +
    "paragraph rather than the document. Each result carries a `cite` string you can quote. Open " +
    "a page with content.readPages, or a Library file with library.read, only when the passages " +
    "do not settle the question.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What you want to know, in words — \"how does the company charge for retainers\" works " +
          "better than \"pricing\", because the match is on meaning.",
      },
      kinds: {
        type: "array",
        items: { type: "string", enum: [...CHUNK_SOURCE_KINDS] },
        maxItems: CHUNK_SOURCE_KINDS.length,
        description:
          "Restrict to `page` (the site's own pages), `library` (what has already been written " +
          "up) or `document`. Omit for everything.",
      },
      path: {
        type: "string",
        description: "Only Library results inside this branch, e.g. \"/services\".",
      },
      limit: { type: "integer", description: `How many passages to return (1-${MAX_SEARCH_RESULTS}). Defaults to 8.` },
    },
    required: ["query"],
    additionalProperties: false,
  },
  parseInput(input, errors) {
    const source = rejectUnknown(input, ["query", "kinds", "path", "limit"], errors);
    const kinds = requireStringArray(source.kinds, "kinds", { max: CHUNK_SOURCE_KINDS.length, itemMax: 32, required: false }, errors);
    for (const kind of kinds) {
      if (!CHUNK_SOURCE_KINDS.includes(kind)) {
        errors.push(`kinds must only contain ${CHUNK_SOURCE_KINDS.join(", ")}.`);
        break;
      }
    }
    return {
      query: requireString(source.query, "query", { max: 500 }, errors),
      kinds,
      path: requireString(source.path, "path", { max: LIBRARY_LIMITS.path, required: false }, errors) || null,
      limit: boundedInteger(source.limit, "limit", { min: 1, max: MAX_SEARCH_RESULTS, fallback: 8 }, errors),
    };
  },
  async handler(input, { scope, retrieval }) {
    const workspaceId = requireWorkspace(scope);
    if (!retrieval) {
      throw new ToolError({
        code: "INDEX_UNAVAILABLE",
        message:
          "The search index is not available on this worker, so nothing can be searched. Work " +
          "from content.listRoutes, content.listPages and content.readPages instead, and say in " +
          "your reply that search was unavailable.",
      });
    }

    try {
      const found = await retrieval.search({
        workspaceId,
        query: input.query,
        kinds: input.kinds,
        path: input.path,
        limit: input.limit,
        // So the call log can say which run the query's embedding was made for.
        trace: { runId: scope.runId, siteId: scope.siteId, agentSlug: scope.agentSlug },
      });
      return {
        query: found.query,
        total: found.total,
        results: found.results,
        // Said explicitly rather than left to be inferred from an empty list, because the two
        // possible readings — "the site does not say" and "nothing has been indexed yet" — call
        // for completely different replies.
        note: found.total
          ? null
          : "Nothing indexed in this workspace matches that. It may not be said anywhere on the site, or the index may not have caught up with a recent crawl.",
      };
    } catch (error) {
      // A vector database that is down and an embedding provider that refused are both reported
      // with their own code, so the run log says which to go and look at.
      if (error?.code) {
        throw new ToolError({
          code: error.code,
          message: `${error.message} Work from content.listPages and content.readPages instead, and say so in your reply.`,
        });
      }
      throw error;
    }
  },
});

/** Every content tool, keyed by name. */
export const CONTENT_TOOLS = Object.freeze({
  [mapContentSite.name]: mapContentSite,
  [listContentRoutes.name]: listContentRoutes,
  [listContentPages.name]: listContentPages,
  [readContentPages.name]: readContentPages,
  [reviewContentPages.name]: reviewContentPages,
  [searchContent.name]: searchContent,
});
