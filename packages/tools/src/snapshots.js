/**
 * Reading the site as the crawler last saw it.
 *
 * A snapshot is written per page per run, and a run no longer covers the whole site: a later crawl
 * fetches only the pages that are due, and a page that answers 304 writes no snapshot at all. So
 * "the newest run's snapshots" is whatever that run happened to fetch — after a quiet week,
 * nothing — and a tool that reads only those reports a site that shrinks every time it is crawled.
 *
 * The site is one snapshot per page: the newest, whichever run wrote it. Every tool that answers a
 * question about the whole site starts from these stages, so "how many pages are broken" is
 * counted over the same set whichever tool is asked.
 */

import { AGENT_COLLECTIONS } from "@orbik/core";

/**
 * The newest crawl of a site that finished, or null when none has.
 *
 * It does not choose which snapshots are read. It answers whether the site has been crawled at
 * all — a first crawl still in flight is a partial picture, and reporting it as the site would be
 * a count that changes on the next call — and it tells the caller which crawl the data is as of.
 *
 * @param {import("mongodb").Db} database connected database
 * @param {import("mongodb").ObjectId} siteId the site, from the run's scope
 * @returns {Promise<import("mongodb").ObjectId|null>}
 */
export async function latestFinishedCrawlId(database, siteId) {
  const [run] = await database
    .collection(AGENT_COLLECTIONS.runs)
    .find({ siteId, agent: "crawler", status: "succeeded" })
    .sort({ startedAt: -1 })
    .limit(1)
    .project({ _id: 1 })
    .toArray();
  return run?._id ?? null;
}

/**
 * The aggregation stages that reduce a site's snapshots to the newest one of every page.
 *
 * The sort is the one `crawl_page_snapshots_url_history` already serves, so the newest snapshot of
 * each page arrives first in its group without a sort in memory. `fields` trims every snapshot
 * before the grouping holds it: `extracted` carries a page's headings, links and images, and
 * grouping whole documents for a fifty-thousand-page site would hold all of that to answer a
 * question about status codes.
 *
 * @param {import("mongodb").ObjectId} siteId the site, from the run's scope
 * @param {Record<string, 1>} [fields] the snapshot fields the caller reads; every field when omitted
 * @returns {object[]} stages yielding one document per page, shaped like a snapshot
 */
export function latestSnapshotStages(siteId, fields) {
  return [
    { $match: { siteId } },
    { $sort: { urlHash: 1, fetchedAt: -1 } },
    ...(fields ? [{ $project: { urlHash: 1, fetchedAt: 1, ...fields } }] : []),
    { $group: { _id: "$urlHash", snapshot: { $first: "$$ROOT" } } },
    { $replaceRoot: { newRoot: "$snapshot" } },
  ];
}
