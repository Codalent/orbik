import { applyCrawlSchedule, toObjectId } from "@orbik/core";

/** Crawl configuration fields the API is allowed to expose or accept. */
const SITE_PROJECTION = Object.freeze({
  workspaceId: 1,
  seedUrl: 1,
  sitemapUrls: 1,
  enabled: 1,
  crawlIntervalHours: 1,
  maxDepth: 1,
  crawlSchedule: 1,
  crawlScheduleOverrides: 1,
  nextCrawlAt: 1,
  lastScheduledAt: 1,
  crawlRequestedAt: 1,
  crawlRequestedBy: 1,
  frequenciesSetAt: 1,
  createdAt: 1,
  updatedAt: 1,
});

/**
 * The pipeline expression that keeps a site's waiting requester, or names this one when nobody is
 * waiting; with nobody to name it leaves the field as it was.
 */
function firstRequester(startedBy) {
  return { $ifNull: ["$crawlRequestedBy", startedBy ? toObjectId(startedBy) : "$$REMOVE"] };
}

/** Converts a crawl site record to its public summary. */
export function toSiteSummary(site) {
  return {
    id: site._id.toHexString(),
    workspaceId: site.workspaceId.toHexString(),
    seedUrl: site.seedUrl,
    // Absent and empty mean the same thing here — nobody named a sitemap — and the form that
    // reads this needs one shape rather than two.
    sitemapUrls: site.sitemapUrls ?? [],
    enabled: site.enabled !== false,
    crawlIntervalHours: site.crawlIntervalHours ?? 168,
    maxDepth: site.maxDepth ?? 10,
    crawlSchedule: site.crawlSchedule ?? null,
    crawlScheduleOverrides: site.crawlScheduleOverrides ?? [],
    nextCrawlAt: site.nextCrawlAt ? site.nextCrawlAt.toISOString() : null,
    // A press of "Crawl now" that the scheduler has not yet turned into a run. Persisted, so the
    // button still says "queued" after a reload rather than offering to queue it again.
    crawlRequestedAt: site.crawlRequestedAt ? site.crawlRequestedAt.toISOString() : null,
    // When a person first chose frequencies, or null. The crawl page uses this to know whether to
    // put the frequency picker in front of them after a crawl finishes.
    frequenciesSetAt: site.frequenciesSetAt ? site.frequenciesSetAt.toISOString() : null,
    createdAt: site.createdAt.toISOString(),
  };
}

/** Converts an agent run record to its public summary. */
export function toRunSummary(run) {
  return {
    id: run._id.toHexString(),
    status: run.status,
    phase: run.phase ?? (run.status === "running" ? "queued" : "idle"),
    trigger: run.trigger,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    durationMs: run.durationMs ?? null,
    counters: run.counters ?? {},
    error: run.error ? { code: run.error.code, message: run.error.message } : null,
  };
}

/**
 * Converts a page snapshot to its public summary.
 *
 * The stored snapshot carries far more than a list needs — every heading, the full link set, the
 * text hash. Projecting here rather than in the caller keeps a page listing from shipping
 * kilobytes per row to a browser that renders one line of it.
 */
export function toPageSummary(snapshot) {
  return {
    url: snapshot.url,
    urlHash: snapshot.urlHash,
    status: snapshot.status,
    depth: snapshot.depth ?? null,
    indexable: snapshot.indexable === true,
    indexabilityReasons: snapshot.indexabilityReasons ?? [],
    title: snapshot.extracted?.title ?? null,
    titleLength: snapshot.extracted?.titleLength ?? 0,
    metaDescription: snapshot.extracted?.metaDescription ?? null,
    wordCount: snapshot.extracted?.wordCount ?? 0,
    h1Count: snapshot.extracted?.headings?.h1?.length ?? 0,
    canonicalUrl: snapshot.canonicalUrl ?? null,
    selfCanonical: snapshot.selfCanonical,
    redirectCount: snapshot.redirects?.length ?? 0,
    elapsedMs: snapshot.elapsedMs ?? null,
    fetchedAt: snapshot.fetchedAt.toISOString(),
  };
}

/**
 * Creates read access to the crawl dataset the agents produce, plus the one document the API owns.
 *
 * The API writes exactly one thing here — a workspace's crawl configuration — and reads everything
 * else. Runs, snapshots, and the URL registry belong to the agents; the API rendering them does
 * not make it their author, and it must never write into them or the two processes would race
 * over the same rows.
 *
 * @param {object} collections agent-owned collections from `@orbik/core`
 */
export function createCrawlRepository(collections) {
  const { sites, runs, snapshots, urls, links, jobs, markdown, robots, events } = collections;

  /**
   * Re-derives every row's frequency from the site's configuration, and brings the next visit
   * forward when the resulting cadence is shorter than the one already planned.
   */
  async function rescheduleSite(site, now) {
    const interval = await applyCrawlSchedule({ sites, urls, site });
    const due = new Date(now.getTime() + interval * 3_600_000);
    await sites.updateOne({ _id: site._id, nextCrawlAt: { $gt: due } }, { $set: { nextCrawlAt: due } });
  }

  return {
    /** Finds the crawl configuration for one workspace, or null when none exists yet. */
    findSiteByWorkspace(workspaceId) {
      return sites.findOne({ workspaceId: toObjectId(workspaceId) }, { projection: SITE_PROJECTION });
    },

    /**
     * Creates or updates a workspace's crawl configuration.
     *
     * `nextCrawlAt` is written only on insert. Overwriting it on every edit would let a user reset
     * their own schedule by touching an unrelated field, and repeated edits could hold a site
     * permanently just-about-to-crawl.
     */
    async upsertSite({ workspaceId, seedUrl, settings, now, startedBy = null }) {
      const filter = { workspaceId: toObjectId(workspaceId) };
      await sites.updateOne(
        filter,
        {
          $set: { seedUrl, ...settings, updatedAt: now },
          // Setting a site up is also asking for its first crawl: it is due at once, and the mark
          // is what lets the page say "queued" for the minute before the scheduler starts it.
          $setOnInsert: {
            workspaceId: toObjectId(workspaceId),
            nextCrawlAt: now,
            crawlRequestedAt: now,
            crawlRequestedBy: startedBy ? toObjectId(startedBy) : null,
            createdAt: now,
          },
        },
        { upsert: true },
      );
      // A frequency change is applied to the registry rows immediately, and the next visit is
      // pulled forward if the new cadence asks for it — never pushed back, so an edit cannot be
      // used to postpone a crawl that was already due.
      if (settings.crawlScheduleOverrides || settings.crawlIntervalHours) {
        const saved = await sites.findOne(filter, { projection: SITE_PROJECTION });
        await rescheduleSite(saved, now);
      }
      return sites.findOne(filter, { projection: SITE_PROJECTION });
    },

    /**
     * Lists every route pattern the registry knows, with how many pages each covers.
     *
     * Read from the rows rather than from the AI's list, because the AI's list is only the
     * patterns it managed to decide about. A pattern it never saw — planning failed, or the
     * pages are new — is exactly the one a person most needs to be shown, since nothing will
     * recrawl it until they choose.
     */
    listPatterns(siteId) {
      return urls.aggregate([
        { $match: { siteId: toObjectId(siteId), eligible: true, routePattern: { $type: "string" }, $or: [{ variantOf: null }, { variantOf: { $exists: false } }] } },
        { $group: { _id: "$routePattern", pages: { $sum: 1 }, pinned: { $sum: { $cond: [{ $ifNull: ["$crawlOverride", false] }, 1, 0] } } } },
        { $sort: { pages: -1, _id: 1 } },
        { $limit: 500 },
      ]).toArray();
    },

    /**
     * Pins one page to its own frequency, or returns it to its pattern's.
     *
     * The effective interval is written alongside the override because the crawler reads only
     * `crawlIntervalHours`; the override is what tells the next schedule application to leave the
     * row alone (or, once removed, to derive it again).
     */
    async setUrlOverride({ site, urlHash, override, now }) {
      const filter = { siteId: site._id, urlHash };
      if (override) {
        await urls.updateOne(filter, { $set: { crawlOverride: { intervalHours: override.intervalHours, setAt: now }, crawlIntervalHours: override.intervalHours } });
      } else {
        await urls.updateOne(filter, { $unset: { crawlOverride: "" } });
      }
      await rescheduleSite(site, now);
      return urls.findOne(filter);
    },

    /**
     * Marks one page, or every page of one pattern, as wanted on the next crawl, and makes the
     * site due so that crawl starts on the scheduler's next pass.
     *
     * The request is a timestamp rather than a flag. The crawler compares it with the page's last
     * fetch, so it needs no clearing and survives a run that ran out of budget before reaching
     * the page.
     */
    async requestRecrawl({ siteId, target, now, startedBy = null }) {
      const filter = { siteId: toObjectId(siteId), ...(target.urlHash ? { urlHash: target.urlHash } : { routePattern: target.pattern }) };
      const result = await urls.updateMany(filter, { $set: { recrawlRequestedAt: now } });
      if (result.matchedCount > 0) {
        // Who asked is kept on the site until the scheduler claims it and hands it to the run.
        // The first request waiting keeps its name: a page asked for after a "Crawl now" joins
        // that crawl rather than taking it over.
        await sites.updateOne(
          { _id: toObjectId(siteId) },
          [{ $set: { nextCrawlAt: now, enabled: true, crawlRequestedBy: firstRequester(startedBy) } }],
        );
      }
      return result.matchedCount;
    },

    /**
     * Marks a site due so the scheduler starts a crawl on its next pass.
     *
     * The API deliberately does not queue the crawl itself. Starting a run means checking for an
     * overlapping one, opening the ledger entry, and enqueueing the first job — logic that already
     * exists in the scheduler, and that would race with it if two processes both did it. Making a
     * site due is a single idempotent write with no such hazard.
     */
    /**
     * Sets one crawl frequency on every page a selection names, and makes the site's cadence
     * follow.
     *
     * A selection is pages by hash and folders by path, and a folder means everything under it
     * as the crawl knows it today. The choice is written per page, as the same per-URL override
     * the detail panel writes, so there is one place the crawler reads a page's frequency from
     * and a folder-wide choice and a single-page choice cannot disagree about a page.
     *
     * Duplicates are skipped: a trailing-slash twin follows the page it duplicates, and writing
     * to it would count one page twice in the answer.
     *
     * @param {object} options
     * @param {object} options.site the crawl site
     * @param {{urlHashes: string[], paths: string[]}} options.targets the selection
     * @param {number | null} options.intervalHours hours between crawls; null for manual trigger
     * @param {Date} options.now
     * @returns {Promise<number>} how many pages the choice now applies to
     */
    async setFrequencyForTargets({ site, targets, intervalHours, now }) {
      const clauses = [];
      if (targets.urlHashes.length) clauses.push({ urlHash: { $in: targets.urlHashes } });
      for (const path of targets.paths) {
        const segments = path.split("/").filter(Boolean);
        const clause = { pathDepth: { $gte: segments.length } };
        segments.forEach((segment, index) => { clause[`pathSegments.${index}`] = segment; });
        clauses.push(clause);
      }
      if (!clauses.length) return 0;

      const result = await urls.updateMany(
        {
          siteId: site._id,
          eligible: true,
          $and: [
            { $or: [{ variantOf: null }, { variantOf: { $exists: false } }] },
            { $or: clauses },
          ],
        },
        { $set: { crawlOverride: { intervalHours, setAt: now }, crawlIntervalHours: intervalHours } },
      );
      if (result.matchedCount > 0) {
        await sites.updateOne({ _id: site._id, frequenciesSetAt: { $exists: false } }, { $set: { frequenciesSetAt: now } });
        await rescheduleSite(site, now);
      }
      return result.matchedCount;
    },

    async requestCrawlNow(siteId, now, startedBy = null) {
      const result = await sites.updateOne(
        { _id: toObjectId(siteId) },
        // `crawlRequestedBy` is who asked first: the scheduler copies it onto the run as
        // `startedBy` when it claims the site, and clears both marks in the same write. A second
        // request before then joins the first rather than renaming it.
        [{ $set: { nextCrawlAt: now, enabled: true, crawlRequestedAt: now, crawlRequestedBy: firstRequester(startedBy) } }],
      );
      return result.matchedCount === 1;
    },

    /**
     * Asks for every page of a site on the next crawl, fetched in full.
     *
     * Two marks on every eligible row: the same "wanted" timestamp a hand-picked recrawl leaves,
     * and no stored validators, so the crawler sends no `If-None-Match` and the server cannot
     * answer 304. Rows that are not eligible — out of scope, disallowed by robots — stay as they
     * are; a fresh crawl is thorough, not a way around the site's own rules.
     *
     * @returns {Promise<number>} pages asked for
     */
    async requestFreshCrawl(siteId, now) {
      const result = await urls.updateMany(
        { siteId: toObjectId(siteId), eligible: true },
        { $set: { recrawlRequestedAt: now }, $unset: { etag: "", lastModified: "" } },
      );
      return result.matchedCount;
    },

    /**
     * Deletes everything the crawler has stored for a site, and keeps the site's settings.
     *
     * The page registry goes first: it is what every listing reads, so a clear interrupted
     * halfway shows an empty site rather than pages whose content has already gone.
     *
     * @returns {Promise<number>} pages removed
     */
    async clearSiteData(siteId) {
      const scope = { siteId: toObjectId(siteId) };
      const removed = await urls.deleteMany(scope);
      await Promise.all([
        links.deleteMany(scope),
        snapshots.deleteMany(scope),
        markdown.deleteMany(scope),
        robots.deleteMany(scope),
        events.deleteMany(scope),
        jobs.deleteMany({ ...scope, agent: "crawler" }),
        runs.deleteMany({ ...scope, agent: "crawler" }),
      ]);
      // The planned frequencies described pages that no longer exist, and a queued request would
      // be answered by the scheduler's own next visit anyway.
      await sites.updateOne({ _id: scope.siteId }, { $unset: { crawlSchedule: "", crawlRequestedAt: "", crawlRequestedBy: "", frequenciesSetAt: "" } });
      return removed.deletedCount;
    },

    /**
     * Points a site's crawl at a new start address, for a change of the workspace's website.
     *
     * With `newSite` — the address is on another hostname, so it is another site — the sitemaps
     * named for the old host are dropped as well: the crawler refuses a sitemap off the seed's
     * host, so keeping them would stop every crawl. Otherwise only the start address moves.
     */
    async moveSeed(siteId, { seedUrl, newSite, now }) {
      await sites.updateOne(
        { _id: toObjectId(siteId) },
        { $set: { seedUrl, updatedAt: now, ...(newSite ? { sitemapUrls: [] } : {}) } },
      );
      return sites.findOne({ _id: toObjectId(siteId) }, { projection: SITE_PROJECTION });
    },

    /** The crawl configurations of several workspaces at once, for the activity monitor. */
    listSitesByWorkspaces(workspaceIds) {
      if (!workspaceIds.length) return [];
      return sites.find({ workspaceId: { $in: workspaceIds } }, { projection: SITE_PROJECTION }).toArray();
    },

    /** Every crawl currently running across several sites. */
    listActiveRuns(siteIds) {
      if (!siteIds.length) return [];
      return runs.find({ siteId: { $in: siteIds }, agent: "crawler", status: "running" }).toArray();
    },

    /**
     * Pages still to fetch, per running crawl.
     *
     * @param {ObjectId[]} runIds
     * @returns {Promise<Map<string, number>>} run id to outstanding fetch jobs
     */
    async countOutstandingJobsFor(runIds) {
      if (!runIds.length) return new Map();
      const rows = await jobs.aggregate([
        { $match: { runId: { $in: runIds }, type: "crawler.fetch", status: { $in: ["pending", "running"] } } },
        { $group: { _id: "$runId", count: { $sum: 1 } } },
      ]).toArray();
      return new Map(rows.map((row) => [row._id.toHexString(), row.count]));
    },

    /** Returns a site's most recent runs, newest first. */
    listRuns(siteId, limit) {
      return runs
        .find({ siteId: toObjectId(siteId), agent: "crawler" })
        .sort({ startedAt: -1, _id: -1 })
        .limit(limit)
        .toArray();
    },

    /** Returns a site's current run, or null when no crawl is in progress. */
    findActiveRun(siteId) {
      return runs.findOne(
        { siteId: toObjectId(siteId), agent: "crawler", status: "running" },
        { sort: { startedAt: -1 } },
      );
    },

    /** Returns the most recently started run, whatever its status. */
    findLatestRun(siteId) {
      return runs.findOne({ siteId: toObjectId(siteId), agent: "crawler" }, { sort: { startedAt: -1 } });
    },

    /**
     * The site's first crawl that finished, or null when none has yet.
     *
     * The Home page's first step is done once one crawl has gone all the way through — whatever
     * the newest one did since — and says when, and who asked for it.
     */
    findFirstSucceededRun(siteId) {
      return runs.findOne(
        { siteId: toObjectId(siteId), agent: "crawler", status: "succeeded" },
        { sort: { startedAt: 1 }, projection: { startedAt: 1, finishedAt: 1, startedBy: 1 } },
      );
    },

    /**
     * Lists pages from one run, newest crawl first within the requested filter.
     *
     * Reading a single run rather than "the latest snapshot per URL" is deliberate: a run is a
     * coherent picture of the site at one moment, while a mix of snapshots from different runs
     * would let a page that was fixed and a page that was never recrawled sit side by side as if
     * they were observed together.
     */
    async listPages({ runId, filter, limit, skip }) {
      const query = { runId: toObjectId(runId), ...filter };
      const [items, total] = await Promise.all([
        snapshots.find(query).sort({ depth: 1, url: 1 }).skip(skip).limit(limit).toArray(),
        snapshots.countDocuments(query),
      ]);
      return { items, total };
    },

    /**
     * Returns the children of one node in a site's route tree, with each child's health rolled up.
     *
     * Aggregated in the database and read one branch at a time, which is the whole design: the
     * alternative is shipping 50,000 rows to a browser so it can draw twelve of them. A folder's
     * counts are computed over its entire subtree, so a collapsed branch still says how many pages
     * are under it and how many are broken — a tree whose closed nodes carry no signal just makes
     * a person open all of them.
     *
     * Built over `crawl_urls` rather than over one run's snapshots, because the registry is the
     * only place that knows about URLs a crawl discovered but has not fetched yet. Those are
     * exactly the ones worth seeing, and a snapshot-based tree cannot show them at all.
     *
     * @param {object} options
     * @param {string|ObjectId} options.siteId site to read
     * @param {string[]} options.prefix path segments of the node whose children are wanted
     * @param {number} options.limit how many children to return
     * @param {number} options.skip children already shown, for "show more"
     */
    async listTreeChildren({ siteId, prefix, limit, skip }) {
      const site = toObjectId(siteId);
      const depth = prefix.length;
      const match = { siteId: site, pathDepth: { $gt: depth } };
      prefix.forEach((segment, index) => { match[`pathSegments.${index}`] = segment; });

      // Variants are folded away here rather than in the caller: a trailing-slash duplicate must
      // not appear as its own branch, and must not be counted twice in its parent's totals.
      match.$or = [{ variantOf: null }, { variantOf: { $exists: false } }];

      const pipeline = [
        { $match: match },
        {
          $group: {
            _id: { $arrayElemAt: ["$pathSegments", depth] },
            pages: { $sum: 1 },
            // A child is a leaf page rather than a folder when nothing sits below it.
            leaves: { $sum: { $cond: [{ $eq: ["$pathDepth", depth + 1] }, 1, 0] } },
            broken: { $sum: { $cond: [{ $gte: ["$lastStatus", 400] }, 1, 0] } },
            notIndexable: { $sum: { $cond: [{ $eq: ["$indexable", false] }, 1, 0] } },
            orphans: { $sum: { $cond: [{ $eq: ["$orphan", true] }, 1, 0] } },
            uncrawled: { $sum: { $cond: [{ $eq: ["$state", "discovered"] }, 1, 0] } },
            worstStatus: { $max: "$lastStatus" },
            patterns: { $addToSet: "$routePattern" },
            sampleUrl: { $first: "$url" },
            sampleHash: { $first: "$urlHash" },
            // Only meaningful for a leaf, where the one row's own override decides its frequency.
            sampleOverride: { $first: "$crawlOverride" },
          },
        },
        { $sort: { pages: -1, _id: 1 } },
        {
          $facet: {
            items: [{ $skip: skip }, { $limit: limit }],
            total: [{ $count: "count" }],
          },
        },
      ];

      const [result] = await urls.aggregate(pipeline).toArray();
      return {
        items: result?.items ?? [],
        total: result?.total?.[0]?.count ?? 0,
      };
    },

    /**
     * Returns the page sitting exactly at one path, when the path is itself a page.
     *
     * Variants are excluded for the same reason they are in the children: `/blog/` must resolve
     * to the `/blog` it duplicates, not stand in for it.
     */
    pageAtPath({ siteId, segments }) {
      const match = {
        siteId: toObjectId(siteId),
        pathDepth: segments.length,
        $or: [{ variantOf: null }, { variantOf: { $exists: false } }],
      };
      segments.forEach((segment, index) => { match[`pathSegments.${index}`] = segment; });
      return urls.findOne(match);
    },

    /**
     * Every page of a site that has Markdown, by path, without the text.
     *
     * Sorted by URL so the list reads like the site's structure; paged because a site can have
     * tens of thousands of pages and a library view opens one at a time.
     */
    async listMarkdown({ siteId, limit, skip }) {
      const filter = { siteId: toObjectId(siteId) };
      const [items, total] = await Promise.all([
        markdown.find(filter, { projection: { markdown: 0 } }).sort({ url: 1 }).skip(skip).limit(limit).toArray(),
        markdown.countDocuments(filter),
      ]);
      return { items, total };
    },

    /** How many pages have Markdown, which is what the knowledge agents read. */
    countMarkdown({ siteId }) {
      return markdown.countDocuments({ siteId: toObjectId(siteId) });
    },

    /** What is known about a page's Markdown without the text itself, for the detail panel. */
    markdownSummary({ siteId, urlHash }) {
      return markdown.findOne({ siteId: toObjectId(siteId), urlHash }, { projection: { markdown: 0 } });
    },

    /** A page's Markdown in full, or null when none has been rendered yet. */
    findMarkdown({ siteId, urlHash }) {
      return markdown.findOne({ siteId: toObjectId(siteId), urlHash });
    },

    /** Returns one registry row by hash, which is where a detail panel starts. */
    findUrl({ siteId, urlHash }) {
      return urls.findOne({ siteId: toObjectId(siteId), urlHash });
    },

    /** Returns every URL that is really the same page as this one, the representative included. */
    listVariants({ siteId, groupKey }) {
      return urls
        .find({ siteId: toObjectId(siteId), groupKey })
        .project({ url: 1, urlHash: 1, variantOf: 1, variantReason: 1, lastStatus: 1 })
        .limit(50)
        .toArray();
    },

    /** Returns the newest snapshot of one URL, whichever run produced it. */
    latestSnapshot({ siteId, urlHash }) {
      return snapshots.findOne({ siteId: toObjectId(siteId), urlHash }, { sort: { fetchedAt: -1 } });
    },

    /**
     * The title each of a batch of URLs was last crawled with, keyed by URL hash.
     *
     * Read from the newest snapshot of each page rather than stored on the URL registry, because
     * the registry is what the crawler writes on every discovery and a title is only known once a
     * page has been fetched. One query for the batch, never one per row.
     */
    async latestTitles({ siteId, urlHashes }) {
      if (!urlHashes.length) return new Map();
      const titles = await snapshots.aggregate([
        { $match: { siteId: toObjectId(siteId), urlHash: { $in: urlHashes } } },
        { $sort: { fetchedAt: -1 } },
        { $group: { _id: "$urlHash", title: { $first: "$extracted.title" } } },
      ]).toArray();
      return new Map(titles.map((row) => [row._id, typeof row.title === "string" ? row.title : null]));
    },

    /** Returns one URL's recent snapshots, oldest last, for a history strip. */
    snapshotHistory({ siteId, urlHash, limit = 10 }) {
      return snapshots
        .find({ siteId: toObjectId(siteId), urlHash })
        .project({ status: 1, fetchedAt: 1, indexable: 1, "extracted.wordCount": 1, "extracted.textHash": 1 })
        .sort({ fetchedAt: -1 })
        .limit(limit)
        .toArray();
    },

    /**
     * Returns the pages linking to one URL, with the anchor text they use.
     *
     * The `crawl_links_to` index has existed for this query since the link graph was built; until
     * now nothing asked it. "Which pages link here, and what do they call it" is the single most
     * useful thing a page detail view can say, and it is already on record.
     */
    listInboundLinks({ siteId, urlHash, limit = 25 }) {
      return links
        .find({ siteId: toObjectId(siteId), toUrlHash: urlHash, internal: true })
        .project({ fromUrlHash: 1, anchor: 1, nofollow: 1 })
        .limit(limit)
        .toArray();
    },

    /** Returns the links going out of one page. */
    listOutboundLinks({ siteId, urlHash, limit = 25 }) {
      return links
        .find({ siteId: toObjectId(siteId), fromUrlHash: urlHash })
        .project({ toUrl: 1, toUrlHash: 1, anchor: 1, nofollow: 1, internal: 1 })
        .limit(limit)
        .toArray();
    },

    /** Resolves URLs for a set of hashes, so inbound links can be shown as addresses. */
    async resolveUrls({ siteId, hashes }) {
      if (!hashes.length) return new Map();
      const rows = await urls
        .find({ siteId: toObjectId(siteId), urlHash: { $in: hashes } })
        .project({ url: 1, urlHash: 1 })
        .toArray();
      return new Map(rows.map((row) => [row.urlHash, row.url]));
    },

    /**
     * Returns the pages a run has fetched most recently, newest first.
     *
     * This is the crawl log, and it is a read of rows the crawler already writes rather than a
     * second event stream. A per-page event log would double the writes of every crawl and would
     * still have to be capped, at which point a large crawl goes quiet exactly when somebody is
     * watching it. Snapshots cannot go quiet: there is one per page, always.
     *
     * @param {object} options
     * @param {string|ObjectId} options.runId run being watched
     * @param {Date} [options.before] fetch time to page back from, for older entries
     * @param {number} options.limit how many entries to return
     */
    listActivity({ siteId, runId, before, limit }) {
      const query = { siteId: toObjectId(siteId), runId: toObjectId(runId) };
      if (before) query.fetchedAt = { $lt: before };
      return snapshots
        .find(query)
        .project({
          url: 1, urlHash: 1, status: 1, indexable: 1, elapsedMs: 1, bytes: 1,
          fetchedAt: 1, discovered: 1, "extracted.title": 1,
        })
        .sort({ fetchedAt: -1 })
        .limit(limit)
        .toArray();
    },

    async liveDetails(run) {
      const [recent, ahead] = await Promise.all([
        jobs.find({ runId: run._id, attempts: { $gt: 0 } }).sort({ updatedAt: -1 }).limit(40).toArray(),
        run.status === "running" && !run.phase
          ? runs.countDocuments({ agent: "crawler", status: "running", startedAt: { $lt: run.startedAt } }) : 0,
      ]);
      const hashes = recent.map((row) => row.payload?.urlHash).filter(Boolean);
      const pages = await urls.find({ siteId: run.siteId, urlHash: { $in: hashes } }).project({ urlHash: 1, url: 1 }).toArray();
      const addresses = new Map(pages.map((row) => [row.urlHash, row.url]));
      return { queuePosition: run.status === "running" && !run.phase ? ahead + 1 : null,
        logs: recent.map((row) => ({ id: String(row._id), type: row.type, status: row.status,
          url: addresses.get(row.payload?.urlHash) ?? null, attempts: row.attempts,
          message: row.lastError?.message ?? null, at: row.updatedAt.toISOString() })) };
    },

    /** Counts fetch jobs still queued or running for one run, which is a crawl's denominator. */
    countOutstandingJobs(runId) {
      return jobs.countDocuments({
        runId: toObjectId(runId),
        type: "crawler.fetch",
        status: { $in: ["pending", "running"] },
      });
    },

    /** Counts a site's registered URLs by the dimensions the dashboard reports. */
    async summarizeUrls(siteId) {
      const site = toObjectId(siteId);
      const [total, eligible, orphans, duplicates] = await Promise.all([
        urls.countDocuments({ siteId: site }),
        urls.countDocuments({ siteId: site, eligible: true }),
        urls.countDocuments({ siteId: site, orphan: true }),
        // Counted rather than derived, because "1,240 URLs, 254 of them duplicates" is a
        // different and more honest headline than "1,240 URLs".
        urls.countDocuments({ siteId: site, variantOf: { $ne: null, $exists: true } }),
      ]);
      return { total, eligible, orphans, duplicates, pages: total - duplicates };
    },

    /**
     * How many of a site's fetched pages will be fetched again without anybody asking.
     *
     * A page is refetched on a timer only when a crawl frequency was chosen for it; the resolved
     * frequency is written onto the row, so this is a count of rows rather than a walk through
     * the three places a frequency can come from. It is what tells a reader of anything built on
     * *change* — a page that is never refetched cannot be seen to change — how much of the site
     * is actually being watched.
     *
     * @returns {Promise<{pages: number, onFrequency: number}>}
     */
    async countRefetched(siteId) {
      const fetched = { siteId: toObjectId(siteId), state: "crawled" };
      const [pages, onFrequency] = await Promise.all([
        urls.countDocuments(fetched),
        urls.countDocuments({ ...fetched, crawlIntervalHours: { $type: "number" } }),
      ]);
      return { pages, onFrequency };
    },
  };
}
