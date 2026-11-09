import { toObjectId } from "@orbik/core";

/** Where a URL was first learned about, kept as a set because most URLs have several sources. */
export const DISCOVERY_SOURCES = Object.freeze({
  seed: "seed",
  sitemap: "sitemap",
  link: "link",
  robots: "robots",
});

/**
 * How far one URL has got, and nothing else.
 *
 * Progress and eligibility are kept apart deliberately. `state` only ever moves forward, while
 * `eligible` is recomputed on every crawl from the current scope rules, robots.txt, and page
 * budget. Collapsing the two into one field means either a rediscovered page gets rewound to
 * "not yet crawled" — and two pages linking to each other re-queue one another forever — or a
 * page excluded once can never become eligible again when the rules change.
 */
export const URL_STATE = Object.freeze({
  /** Known but not yet fetched. */
  discovered: "discovered",
  /** Fetched at least once; a snapshot exists. */
  crawled: "crawled",
});

/** Documents written per bulk operation, bounding memory on a large sitemap. */
const BATCH_SIZE = 500;

/**
 * Creates the durable URL registry for a site.
 *
 * The registry outlives any single crawl. That is what makes incremental crawling possible — the
 * next run can ask "what did we know last time, and what changed" instead of rediscovering the
 * whole site — and it is what lets a URL that has disappeared from a sitemap still be recognised
 * as a URL we used to know about rather than as something new.
 *
 * @param {object} options collaborators
 * @param {import("mongodb").Collection} options.urls the `crawl_urls` collection
 * @param {() => Date} [options.now] clock; defaults to the system clock
 */
export function createUrlRegistry({ urls, now = () => new Date() }) {
  return {
    /**
     * Records discovered URLs, merging each into what is already known.
     *
     * Merge semantics are the point of this method:
     * - `firstSeenAt` and the URL string are written **only on insert**, so a URL keeps the date
     *   it entered the registry however many times it is rediscovered.
     * - `discoveredBy` accumulates, because "this page is in the sitemap *and* linked from the
     *   homepage" is a different fact from either half alone.
     * - `depth` takes the **minimum**, so a page found at depth 5 and later at depth 2 records
     *   the shortest known path from the seed rather than whichever run happened to be last.
     * - `eligible` is overwritten every time, because whether a URL should be fetched depends on
     *   rules that change between crawls; `state` is written only on insert, because how far a
     *   URL has got does not.
     *
     * @param {object} input discovery batch
     * @param {string|ObjectId} input.siteId site the URLs belong to
     * @param {string|ObjectId} [input.workspaceId] owning workspace, carried for authorization
     * @param {string|ObjectId} [input.runId] run that made the discovery
     * @param {Array<object>} input.entries normalized URLs with their discovery metadata
     * @returns {Promise<{inserted: number, updated: number, insertedHashes: string[]}>}
     *   `insertedHashes` names the URLs this call was the first to register. It is read from the
     *   write itself, so two pages that find the same new URL at the same moment cannot both
     *   count it
     */
    async record({ siteId, workspaceId, runId, entries }) {
      const site = toObjectId(siteId);
      const current = now();
      let inserted = 0;
      let updated = 0;
      const insertedHashes = [];

      for (let offset = 0; offset < entries.length; offset += BATCH_SIZE) {
        const batch = entries.slice(offset, offset + BATCH_SIZE);
        const operations = batch.map((entry) => ({
          updateOne: {
            filter: { siteId: site, urlHash: entry.hash },
            update: {
              $setOnInsert: {
                siteId: site,
                ...(workspaceId ? { workspaceId: toObjectId(workspaceId) } : {}),
                urlHash: entry.hash,
                url: entry.url,
                host: entry.host ?? null,
                state: URL_STATE.discovered,
                firstSeenAt: current,
              },
              $set: {
                lastSeenAt: current,
                inScope: entry.inScope !== false,
                scopeReason: entry.scopeReason ?? null,
                robotsAllowed: entry.robotsAllowed !== false,
                // Recomputed on every crawl: scope rules and robots.txt both change between runs,
                // and a URL excluded last time may belong this time.
                //
                // Eligibility answers a *policy* question — may we crawl this at all — and
                // nothing else. The monthly crawl budget deliberately does not appear here: it
                // answers a scheduling question, whether we will fetch this page right now, and
                // folding the two together would make running out of allowance a permanent
                // property of a URL. A site larger than one month's budget would then crawl the
                // same pages every month and never reach the rest.
                eligible: entry.inScope !== false && entry.robotsAllowed !== false,
                ...(runId ? { lastDiscoveredRunId: toObjectId(runId) } : {}),
                ...(entry.sitemap ? { sitemap: entry.sitemap } : {}),
              },
              $addToSet: { discoveredBy: { $each: sourcesOf(entry) } },
              // $min leaves the field alone when the stored value is already smaller, and sets it
              // when the field is absent, so no read-before-write is needed.
              ...(Number.isInteger(entry.depth) ? { $min: { depth: entry.depth } } : {}),
            },
            upsert: true,
          },
        }));

        const result = await urls.bulkWrite(operations, { ordered: false });
        inserted += result.upsertedCount ?? 0;
        updated += result.modifiedCount ?? 0;
        for (const index of Object.keys(result.upsertedIds ?? {})) insertedHashes.push(batch[Number(index)].hash);
      }

      return { inserted, updated, insertedHashes };
    },

    /**
     * Returns the shallowest in-scope URLs still awaiting a fetch.
     *
     * Shallowest first is what makes a crawl that stops at its page budget stop on the least
     * important pages: depth from the home page is the cheapest available proxy for importance
     * before anything has been fetched.
     *
     * @param {string|ObjectId} siteId site to read
     * @param {number} [limit=1000] maximum URLs returned
     */
    frontier(siteId, limit = 1000) {
      return urls
        .find({ siteId: toObjectId(siteId), eligible: true, state: URL_STATE.discovered })
        .sort({ depth: 1, firstSeenAt: 1 })
        .limit(limit)
        .toArray();
    },

    /**
     * Filters a set of URL hashes down to those still needing a fetch in one run.
     *
     * "Needs fetching" is per run, not per URL: a page crawled last week must be crawled again
     * this week, while a page already crawled *in this run* must not be queued a second time
     * because a later page linked to it. `lastRunId` is what separates the two, and it is set
     * only when a fetch actually completes — never at discovery, which would make a crawl skip
     * every page it had merely heard about.
     *
     * A URL queued but not yet fetched is still returned here; the queue's idempotency key is
     * what prevents a duplicate job for work already in flight.
     *
     * With `discovery`, the question is whether a page still needs reading for its links, free of
     * charge. A fetch reads them too, so a page fetched in this run needs no exploring, and a
     * page's links were last read at its last exploration or its last fetch, whichever is later.
     * Without the second rule, the first crawl with a discovery pass after crawls that had none
     * would explore the whole site again to learn what its last fetch already recorded.
     *
     * @param {object} input
     * @param {string|ObjectId} input.siteId site to read
     * @param {string|ObjectId} [input.runId] run being executed
     * @param {string[]} input.hashes candidate URL hashes
     * @param {boolean} [input.discovery] ask what needs exploring rather than fetching
     * @returns {Promise<Array<object>>} registry rows that should be fetched, carrying the crawl
     *   history a caller needs to decide their order
     */
    async pendingForRun({ siteId, runId, hashes, discovery = false }) {
      if (!hashes.length) return [];
      const run = runId ? toObjectId(runId) : null;
      const rows = await urls
        .find({
          siteId: toObjectId(siteId),
          urlHash: { $in: hashes },
          eligible: true,
          // A missing `lastRunId` does not match `$ne`, so a never-crawled URL is included.
          ...(run ? { lastRunId: { $ne: run } } : {}),
          ...(run && discovery ? { lastExploredRunId: { $ne: run } } : {}),
        })
        .project({ urlHash: 1, depth: 1, lastStatus: 1, lastCrawledAt: 1, sitemap: 1, crawlIntervalHours: 1, lastExploredAt: 1, recrawlRequestedAt: 1 })
        .toArray();
      return rows.filter((row) => {
        const previous = discovery ? later(row.lastExploredAt, row.lastCrawledAt) : row.lastCrawledAt;
        // A URL nobody has seen yet is always fetched: that is how new pages enter the dataset.
        if (!previous) return true;
        // A crawl somebody asked for by hand is due until the next fetch satisfies it. Comparing
        // against the last fetch rather than clearing a flag means a request survives a run that
        // ran out of budget before reaching the page.
        if (row.recrawlRequestedAt && new Date(row.recrawlRequestedAt).getTime() > new Date(previous).getTime()) return true;
        // No interval means never: a page without a frequency waits for a person, not a timer.
        if (!row.crawlIntervalHours) return false;
        return new Date(previous).getTime() + row.crawlIntervalHours * 3_600_000 <= now().getTime();
      });
    },

    /** Counts a site's registered URLs, optionally narrowed by any registry field. */
    count(siteId, filter = {}) {
      return urls.countDocuments({ siteId: toObjectId(siteId), ...filter });
    },

    /** Returns one registered URL by its hash, or null when the site has never seen it. */
    find(siteId, urlHash) {
      return urls.findOne({ siteId: toObjectId(siteId), urlHash });
    },
  };
}

/** The later of two times either of which may be missing, or null when both are. */
function later(first, second) {
  if (!first || !second) return first ?? second ?? null;
  return new Date(first).getTime() >= new Date(second).getTime() ? first : second;
}

/**
 * Reads the discovery sources for one entry.
 *
 * A URL is routinely found by more than one source in a single pass — it is in the sitemap *and*
 * linked from the home page — and that combination is a more useful fact than either half, so the
 * caller may pass `sources` for the set or `source` for the common single-source case.
 */
function sourcesOf(entry) {
  if (Array.isArray(entry.sources)) return entry.sources.filter(Boolean);
  return entry.source ? [entry.source] : [];
}
