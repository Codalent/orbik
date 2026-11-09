import { AGENT_COLLECTIONS } from "@orbik/core";

import { DEFAULT_LIMIT, MAX_LIMIT, boundedInteger, optionalBoolean, rejectUnknown } from "./args.js";
import { defineTool } from "./registry.js";
import { requireSite } from "./scope.js";
import { latestFinishedCrawlId, latestSnapshotStages } from "./snapshots.js";

/**
 * Tools that read the dataset the crawler already produced.
 *
 * Nothing here fetches anything. The crawler has been to the site, respected its robots.txt, paced
 * its requests, and recorded what it found; these tools read that record. An agent that re-fetched
 * pages to answer "how many are non-indexable" would be slower, would hit a client's server again
 * for no reason, and would give a different answer than the report next to it.
 *
 * They read the site as last seen — each page's newest snapshot, whichever crawl wrote it
 * (`latestSnapshotStages`) — and never one run's snapshots: a crawl fetches only the pages that are
 * due, so the newest run holds a fraction of the site and often none of it.
 *
 * Every query is scoped by `siteId` from the run's scope, never from the model's arguments.
 */

/** The snapshot fields `crawl.listPages` returns or filters on. */
const LISTED_FIELDS = Object.freeze({
  url: 1,
  status: 1,
  depth: 1,
  indexable: 1,
  indexabilityReasons: 1,
  canonicalUrl: 1,
  selfCanonical: 1,
  redirects: 1,
  "extracted.title": 1,
  "extracted.titleLength": 1,
  "extracted.metaDescription": 1,
  "extracted.wordCount": 1,
  "extracted.headings.h1": 1,
});

/** The snapshot fields `crawl.summarize` counts over. */
const SUMMARIZED_FIELDS = Object.freeze({ status: 1, depth: 1, indexable: 1, indexabilityReasons: 1 });

/** Lists crawled pages with the fields an SEO judgement actually needs. */
const listPages = defineTool({
  name: "crawl.listPages",
  description:
    "List this site's pages as the crawler last saw each one, with title, meta description, " +
    "word count, HTTP status, click depth, and indexability. Every crawled page is covered, " +
    "whichever crawl last fetched it; fetchedAt says when. Use the filters to narrow the set " +
    "before reading detail.",
  inputSchema: {
    type: "object",
    properties: {
      indexable: { type: "boolean", description: "Only pages that are, or are not, indexable." },
      status: { type: "integer", description: "Only pages with this HTTP status code." },
      maxDepth: { type: "integer", description: "Only pages at or above this click depth." },
      limit: { type: "integer", description: `How many pages to return (1-${MAX_LIMIT}).` },
      offset: { type: "integer", description: "How many pages to skip, for paging." },
    },
    additionalProperties: false,
  },
  parseInput(input, errors) {
    const source = rejectUnknown(input, ["indexable", "status", "maxDepth", "limit", "offset"], errors);
    return {
      indexable: optionalBoolean(source.indexable, "indexable", errors),
      status: boundedInteger(source.status, "status", { min: 100, max: 599, fallback: undefined }, errors),
      maxDepth: boundedInteger(source.maxDepth, "maxDepth", { min: 0, max: 50, fallback: undefined }, errors),
      limit: boundedInteger(source.limit, "limit", { min: 1, max: MAX_LIMIT, fallback: DEFAULT_LIMIT }, errors),
      offset: boundedInteger(source.offset, "offset", { min: 0, max: 100_000, fallback: 0 }, errors),
    };
  },
  async handler(input, { database, scope }) {
    const siteId = requireSite(scope);
    const runId = await latestFinishedCrawlId(database, siteId);
    if (!runId) return { pages: [], total: 0, runId: null };

    // The filters apply to each page's newest snapshot, so they come after the reduction: a page
    // that was a 404 last month and is a 200 now is not a 404.
    const filter = {};
    if (input.indexable !== undefined) filter.indexable = input.indexable;
    if (input.status !== undefined) filter.status = input.status;
    if (input.maxDepth !== undefined) filter.depth = { $lte: input.maxDepth };

    const [result] = await database
      .collection(AGENT_COLLECTIONS.snapshots)
      .aggregate([
        ...latestSnapshotStages(siteId, LISTED_FIELDS),
        { $match: filter },
        // Sorted before the facet rather than inside it: a stage of the main pipeline may spill to
        // disk on a large site, and a facet's own stages may not.
        { $sort: { depth: 1, url: 1 } },
        {
          $facet: {
            pages: [{ $skip: input.offset }, { $limit: input.limit }],
            total: [{ $count: "count" }],
          },
        },
      ])
      .toArray();

    return {
      runId: runId.toHexString(),
      total: result.total[0]?.count ?? 0,
      pages: result.pages.map((page) => ({
        url: page.url,
        fetchedAt: page.fetchedAt ?? null,
        status: page.status,
        depth: page.depth ?? null,
        indexable: page.indexable === true,
        indexabilityReasons: page.indexabilityReasons ?? [],
        title: page.extracted?.title ?? null,
        titleLength: page.extracted?.titleLength ?? 0,
        metaDescription: page.extracted?.metaDescription ?? null,
        wordCount: page.extracted?.wordCount ?? 0,
        h1Count: page.extracted?.headings?.h1?.length ?? 0,
        canonicalUrl: page.canonicalUrl ?? null,
        selfCanonical: page.selfCanonical === true,
        redirectCount: page.redirects?.length ?? 0,
      })),
    };
  },
});

/**
 * Summarizes a crawl in one call.
 *
 * Exists because the alternative — a model paging through 1,284 pages to work out how many are
 * broken — costs a fortune, fills its context with rows it will not cite, and produces a count it
 * may get wrong. An aggregation answers it exactly, in one query, for nothing.
 */
const summarizeCrawl = defineTool({
  name: "crawl.summarize",
  description:
    "Summarize this site as the crawler last saw it: page count, status-code breakdown, indexable " +
    "and non-indexable counts with reasons, depth distribution, and how many pages nothing links " +
    "to. Every crawled page is counted once, whichever crawl last fetched it. Start here before " +
    "listing individual pages.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  parseInput(input, errors) {
    rejectUnknown(input, [], errors);
    return {};
  },
  async handler(_input, { database, scope }) {
    const siteId = requireSite(scope);
    const runId = await latestFinishedCrawlId(database, siteId);
    if (!runId) return { runId: null, pages: 0 };

    // One pass over the reduced set, so every count is of the same pages: five separate
    // aggregations would each rebuild "the newest snapshot of every page" and could disagree if a
    // fetch landed between them.
    const [[counts], orphans] = await Promise.all([
      database
        .collection(AGENT_COLLECTIONS.snapshots)
        .aggregate([
          ...latestSnapshotStages(siteId, SUMMARIZED_FIELDS),
          {
            $facet: {
              byStatus: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
              byIndexable: [{ $group: { _id: "$indexable", count: { $sum: 1 } } }],
              byReason: [
                { $match: { indexable: false } },
                { $unwind: "$indexabilityReasons" },
                { $group: { _id: "$indexabilityReasons", count: { $sum: 1 } } },
                { $sort: { count: -1 } },
              ],
              byDepth: [{ $group: { _id: "$depth", count: { $sum: 1 } } }, { $sort: { _id: 1 } }],
              total: [{ $count: "count" }],
            },
          },
        ])
        .toArray(),
      database.collection(AGENT_COLLECTIONS.urls).countDocuments({ siteId, orphan: true }),
    ]);
    const { byStatus, byIndexable, byReason, byDepth } = counts;

    return {
      runId: runId.toHexString(),
      pages: counts.total[0]?.count ?? 0,
      byStatus: Object.fromEntries(byStatus.map((row) => [String(row._id), row.count])),
      indexable: byIndexable.find((row) => row._id === true)?.count ?? 0,
      nonIndexable: byIndexable.find((row) => row._id === false)?.count ?? 0,
      nonIndexableReasons: Object.fromEntries(byReason.map((row) => [row._id, row.count])),
      byDepth: Object.fromEntries(byDepth.map((row) => [String(row._id ?? "unknown"), row.count])),
      orphanPages: orphans,
    };
  },
});

/**
 * Reports which pages link to a given page.
 *
 * The inbound direction is the one worth a tool: outbound links are visible in the page's own
 * HTML, while "what links here" can only be answered from the whole graph, and it is the question
 * behind most internal-linking advice.
 */
const getInternalLinks = defineTool({
  name: "crawl.getInternalLinks",
  description:
    "For one page URL, list the internal pages that link to it and the pages it links out to. " +
    "Use this to judge whether an important page is reachable and well linked.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The exact page URL, as returned by crawl.listPages." },
      limit: { type: "integer", description: `How many links of each direction to return (1-${MAX_LIMIT}).` },
    },
    required: ["url"],
    additionalProperties: false,
  },
  parseInput(input, errors) {
    const source = rejectUnknown(input, ["url", "limit"], errors);
    if (typeof source.url !== "string" || !source.url || source.url.length > 2048) {
      errors.push("url must be a string of at most 2048 characters.");
    }
    return {
      url: source.url,
      limit: boundedInteger(source.limit, "limit", { min: 1, max: MAX_LIMIT, fallback: DEFAULT_LIMIT }, errors),
    };
  },
  async handler(input, { database, scope }) {
    const siteId = requireSite(scope);
    const snapshots = database.collection(AGENT_COLLECTIONS.snapshots);
    const page = await snapshots.findOne({ siteId, url: input.url }, { projection: { urlHash: 1 } });
    if (!page) return { url: input.url, found: false, inboundCount: 0, inbound: [], outbound: [] };

    const links = database.collection(AGENT_COLLECTIONS.links);
    const [inbound, outbound, inboundCount] = await Promise.all([
      links.find({ siteId, toUrlHash: page.urlHash }).limit(input.limit).project({ fromUrlHash: 1 }).toArray(),
      links.find({ siteId, fromUrlHash: page.urlHash }).limit(input.limit).project({ toUrlHash: 1 }).toArray(),
      links.countDocuments({ siteId, toUrlHash: page.urlHash }),
    ]);

    // Hashes are a storage detail; a model needs the URLs it can quote back to a person.
    const hashes = [...inbound.map((row) => row.fromUrlHash), ...outbound.map((row) => row.toUrlHash)];
    const named = await snapshots
      .find({ siteId, urlHash: { $in: hashes } })
      .project({ urlHash: 1, url: 1 })
      .toArray();
    const urlByHash = new Map(named.map((row) => [row.urlHash, row.url]));

    return {
      url: input.url,
      found: true,
      inboundCount,
      inbound: inbound.map((row) => urlByHash.get(row.fromUrlHash)).filter(Boolean),
      outbound: outbound.map((row) => urlByHash.get(row.toUrlHash)).filter(Boolean),
    };
  },
});

/** Every crawl-dataset tool, keyed by name. */
export const CRAWL_TOOLS = Object.freeze({
  [listPages.name]: listPages,
  [summarizeCrawl.name]: summarizeCrawl,
  [getInternalLinks.name]: getInternalLinks,
});
