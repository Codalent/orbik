import { AGENT_COLLECTIONS, escapeRegExp } from "@orbik/core";
import { ObjectId } from "mongodb";

/**
 * Groups a site's registered URLs by route pattern, largest group first.
 *
 * This is the sitemap in the shape a person chooses pages in: `/blog/[slug]` is one kind of page,
 * and tracking one or two posts stands for all of them. The crawler derives the pattern and stores
 * it on each URL (`agents/src/crawler/routePattern.js`); only the API reads it back, so the query
 * lives here and the stored field is the one thing the two share.
 *
 * Only non-duplicate URLs count, and the sample is the shallowest of them — the one closest to
 * what a visitor lands on.
 *
 * @param {import("mongodb").Db} database connected database
 * @param {object} options
 * @param {string|ObjectId} options.siteId site to read
 * @param {number} [options.limit]
 */
export async function listRoutePatterns(database, { siteId, limit = 200 }) {
  const urls = database.collection(AGENT_COLLECTIONS.urls);
  const pipeline = [
    {
      $match: {
        siteId: siteId instanceof ObjectId ? siteId : new ObjectId(siteId),
        routePattern: { $type: "string" },
        $or: [{ variantOf: null }, { variantOf: { $exists: false } }],
      },
    },
    { $sort: { pathDepth: 1, url: 1 } },
    {
      $group: {
        _id: "$routePattern",
        pages: { $sum: 1 },
        fetched: { $sum: { $cond: [{ $eq: ["$state", "discovered"] }, 0, 1] } },
        broken: { $sum: { $cond: [{ $gte: ["$lastStatus", 400] }, 1, 0] } },
        notIndexable: { $sum: { $cond: [{ $eq: ["$indexable", false] }, 1, 0] } },
        sampleUrl: { $first: "$url" },
        sampleHash: { $first: "$urlHash" },
      },
    },
    { $sort: { pages: -1, _id: 1 } },
    { $limit: limit },
  ];
  const rows = await urls.aggregate(pipeline).toArray();
  return rows.map((row) => ({
    pattern: row._id,
    pages: row.pages,
    fetched: row.fetched,
    broken: row.broken,
    notIndexable: row.notIndexable,
    sampleUrl: row.sampleUrl,
    sampleHash: row.sampleHash,
  }));
}

/**
 * Lists the pages of one route pattern, shallowest first, optionally narrowed by a search.
 *
 * This is how a person picks *which* blog post stands for `/blog/[slug]`: the pattern says what
 * kind of page, this says which one. Only non-duplicate, in-scope URLs are offered — a variant
 * (a trailing-slash twin) or an excluded page is not something worth measuring.
 *
 * The search is a plain substring on the URL, escaped, and anchored to nothing: a person types
 * "pricing" and expects to find it wherever it sits in the path.
 *
 * @param {import("mongodb").Db} database connected database
 * @param {object} options
 * @param {string|ObjectId} options.siteId site to read
 * @param {string} options.pattern the route pattern as the crawler wrote it
 * @param {string} [options.search] substring of the URL
 * @param {number} [options.limit]
 */
export async function listRoutePages(database, { siteId, pattern, search = "", limit = 50 }) {
  const urls = database.collection(AGENT_COLLECTIONS.urls);
  const filter = {
    siteId: siteId instanceof ObjectId ? siteId : new ObjectId(siteId),
    routePattern: pattern,
    eligible: true,
    $or: [{ variantOf: null }, { variantOf: { $exists: false } }],
  };
  if (search) filter.url = { $regex: escapeRegExp(search), $options: "i" };
  const rows = await urls
    .find(filter, { projection: { url: 1, urlHash: 1, pathDepth: 1, lastStatus: 1, indexable: 1, state: 1 } })
    .sort({ pathDepth: 1, url: 1 })
    .limit(limit)
    .toArray();
  return rows.map((row) => ({
    url: row.url,
    urlHash: row.urlHash,
    status: row.lastStatus ?? null,
    indexable: row.indexable ?? null,
    crawled: row.state !== "discovered",
  }));
}
