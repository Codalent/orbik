/**
 * Every page of a site as last crawled, with what the registry knows about each, and the one test
 * for whether an agent may propose something for it.
 *
 * Shared by the agents that propose a change to a page — a title to paste, a link to add — because
 * they ask the same two questions before anything else: what are this site's pages right now, and
 * which of them is a page of its own that a search engine may index. Answered here once, so the
 * titles agent and the linking agent cannot disagree about whether a URL counts.
 *
 * Two rules hold for both:
 *
 * - **The site is each page's newest snapshot** (`latestSnapshotStages`), never one crawl's.
 * - **Indexability is the crawler's verdict**, quoted with its reason codes and never re-derived.
 *   A URL that duplicates another page (`variantOf` on the registry) is the same page under a
 *   second address, and is reported as that whether or not it is also not indexable.
 */

import { AGENT_COLLECTIONS } from "@orbik/core";

import { latestSnapshotStages } from "./snapshots.js";

/** Why a crawled URL is not one an agent proposes anything for. */
export const EXCLUDED = Object.freeze({ notIndexable: "NOT_INDEXABLE", duplicateVariant: "DUPLICATE_VARIANT" });

/** The registry fields every caller is given. A caller names the extra ones it reads. */
const REGISTRY_FIELDS = Object.freeze({ variantOf: 1, routePattern: 1, depth: 1, inboundCount: 1, sitemap: 1 });

/**
 * Reads every page of the site as last crawled, with its registry row under `registry`.
 *
 * One pass, so everything a caller derives is about the same set of pages: totals, exclusions and
 * findings cannot disagree because a fetch landed between two queries.
 *
 * @param {import("mongodb").Db} database connected database
 * @param {import("mongodb").ObjectId} siteId the crawl site
 * @param {object} fields
 * @param {Record<string, 1>} fields.snapshot the snapshot fields the caller reads. `extracted` is
 *   large; name its parts. `indexable` and `indexabilityReasons` are needed by {@link exclusionOf}
 * @param {Record<string, 1>} [fields.registry] `crawl_urls` fields beyond the variant, the route
 *   pattern and the importance signals, which are always read
 * @returns {Promise<object[]>} one document per page, shaped like a snapshot plus `registry`
 */
export function loadSitePages(database, siteId, { snapshot, registry = {} }) {
  return database
    .collection(AGENT_COLLECTIONS.snapshots)
    .aggregate([
      ...latestSnapshotStages(siteId, snapshot),
      {
        $lookup: {
          from: AGENT_COLLECTIONS.urls,
          let: { pageHash: "$urlHash" },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ["$siteId", siteId] }, { $eq: ["$urlHash", "$$pageHash"] }] } } },
            { $project: { _id: 0, ...REGISTRY_FIELDS, ...registry } },
          ],
          as: "registry",
        },
      },
      { $set: { registry: { $first: "$registry" } } },
    ])
    .toArray();
}

/**
 * Why nothing is proposed for a page, or null when it is a page of its own that may be indexed.
 *
 * A duplicate is named before an indexability verdict: a URL that redirects to another is both,
 * and "this is a second address of that page" is the more useful thing to be told.
 *
 * @param {object} row one page from {@link loadSitePages}
 * @returns {{code: string, of?: string, reasons?: string[]}|null}
 */
export function exclusionOf(row) {
  if (row.registry?.variantOf) return { code: EXCLUDED.duplicateVariant, of: row.registry.variantOf };
  if (row.indexable === true) return null;
  return { code: EXCLUDED.notIndexable, reasons: row.indexabilityReasons ?? [] };
}

/** The crawler's importance signals for a page: how linked-to, how deep, and named by the sitemap. */
export function signalsOf(row) {
  const registry = row.registry ?? {};
  return {
    inboundCount: registry.inboundCount ?? 0,
    depth: registry.depth ?? null,
    inSitemap: Boolean(registry.sitemap),
  };
}
