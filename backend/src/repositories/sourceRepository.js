import { AGENT_COLLECTIONS, toObjectId } from "@orbik/core";
import { BRAND_ROOT_PATH, LIBRARY_NODE_KINDS, SOURCE_ROOT_PATH, sourceFolderPath } from "@orbik/library";

/**
 * What the Sources page reads about each source beyond its crawl: how much of it is in the
 * Library, which files quote it, and what was left out and why — and what removing one takes away.
 *
 * Reads only, but for {@link removeLibraryBranch}: the copies are the mirror's, the index is the
 * worker's, and the API removes them only when the person removes the source they came from, the
 * way deleting a workspace removes everything of it.
 *
 * @param {import("mongodb").Db} database
 */
export function createSourceRepository(database) {
  const state = database.collection(AGENT_COLLECTIONS.sourceNotes);
  const nodes = database.collection(AGENT_COLLECTIONS.libraryNodes);
  const markdown = database.collection(AGENT_COLLECTIONS.markdown);
  const urls = database.collection(AGENT_COLLECTIONS.urls);
  const links = database.collection(AGENT_COLLECTIONS.links);
  const robots = database.collection(AGENT_COLLECTIONS.robots);
  const snapshots = database.collection(AGENT_COLLECTIONS.snapshots);
  const ledger = database.collection(AGENT_COLLECTIONS.knowledgeSources);
  const indexState = database.collection(AGENT_COLLECTIONS.indexState);
  const chunks = database.collection(AGENT_COLLECTIONS.knowledgeChunks);
  const jobs = database.collection(AGENT_COLLECTIONS.jobs);

  return {
    /**
     * Per source: pages copied into the Library and pages the knowledge base is written from.
     *
     * @returns {Promise<Map<string, {copied: number, chosen: number}>>} by site id
     */
    async libraryCounts(workspaceId, siteIds) {
      if (!siteIds.length) return new Map();
      const rows = await state.aggregate([
        {
          $match: {
            workspaceId: toObjectId(workspaceId),
            siteId: { $in: siteIds },
            mirroredAt: { $exists: true },
            removed: { $ne: true },
            skipped: { $exists: false },
          },
        },
        { $group: { _id: "$siteId", copied: { $sum: 1 }, chosen: { $sum: { $cond: [{ $eq: ["$chosen", true] }, 1, 0] } } } },
      ]).toArray();
      return new Map(rows.map((row) => [row._id.toHexString(), { copied: row.copied, chosen: row.chosen }]));
    },

    /**
     * Per source: the pages its crawl knows and may read — duplicates folded, nothing left out.
     *
     * @returns {Promise<Map<string, number>>} by site id
     */
    async knownCounts(siteIds) {
      if (!siteIds.length) return new Map();
      const rows = await urls.aggregate([
        { $match: { siteId: { $in: siteIds }, eligible: true, $or: [{ variantOf: null }, { variantOf: { $exists: false } }] } },
        { $group: { _id: "$siteId", pages: { $sum: 1 } } },
      ]).toArray();
      return new Map(rows.map((row) => [row._id.toHexString(), row.pages]));
    },

    /** The last moment a page of any of these sources was read with new words, or null. */
    async latestChange(siteIds) {
      if (!siteIds.length) return null;
      const row = await markdown.find({ siteId: { $in: siteIds } }).project({ updatedAt: 1 }).sort({ updatedAt: -1 }).limit(1).next();
      return row?.updatedAt ?? null;
    },

    /** The first files of a source's branch of the Library, and how many there are. */
    async libraryFiles(workspaceId, folder, limit = 8) {
      const root = sourceFolderPath(folder);
      const filter = { workspaceId: toObjectId(workspaceId), kind: LIBRARY_NODE_KINDS.file, path: { $regex: `^${root}/` } };
      const [items, total] = await Promise.all([
        nodes.find(filter).project({ path: 1, title: 1 }).sort({ path: 1 }).limit(limit).toArray(),
        nodes.countDocuments(filter),
      ]);
      return { root, items: items.map((node) => ({ path: node.path, title: node.title ?? null })), total };
    },

    /**
     * The knowledge base's files that cite pages of one source, with how many of its pages each
     * cites, most first.
     */
    async quotedIn(workspaceId, siteId, limit = 6) {
      const owner = toObjectId(workspaceId);
      const keys = (await state.find({ workspaceId: owner, siteId }).project({ sourceKey: 1 }).toArray()).map((row) => row.sourceKey);
      if (!keys.length) return { items: [], total: 0 };
      const rows = await nodes.aggregate([
        {
          $match: {
            workspaceId: owner,
            kind: LIBRARY_NODE_KINDS.file,
            path: { $not: new RegExp(`^(${SOURCE_ROOT_PATH}|${BRAND_ROOT_PATH})(/|$)`) },
            "sources.key": { $in: keys },
          },
        },
        { $project: { path: 1, title: 1, sources: 1 } },
        { $unwind: "$sources" },
        { $match: { "sources.key": { $in: keys } } },
        { $group: { _id: "$path", title: { $first: "$title" }, pages: { $sum: 1 } } },
        { $sort: { pages: -1, _id: 1 } },
      ]).toArray();
      return { items: rows.slice(0, limit).map((row) => ({ path: row._id, title: row.title ?? null, pages: row.pages })), total: rows.length };
    },

    /**
     * The pages a source's crawl knows, for a list of pages: each with its title, how it was
     * found and how it last answered. Bounded: a list is at most a few dozen pages and their
     * listings' next pages.
     */
    async pagesOf(siteId, limit = 100) {
      const rows = await urls
        .find({ siteId, inScope: true, $or: [{ variantOf: null }, { variantOf: { $exists: false } }] })
        .project({ url: 1, urlHash: 1, depth: 1, lastStatus: 1, lastCrawledAt: 1, discoveredBy: 1 })
        .sort({ depth: 1, url: 1 })
        .limit(limit)
        .toArray();
      const titles = rows.length
        ? await markdown.find({ siteId, urlHash: { $in: rows.map((row) => row.urlHash) } }).project({ urlHash: 1, title: 1, heading: 1, updatedAt: 1 }).toArray()
        : [];
      const byHash = new Map(titles.map((row) => [row.urlHash, row]));
      return rows.map((row) => ({
        url: row.url,
        urlHash: row.urlHash,
        depth: row.depth ?? null,
        title: byHash.get(row.urlHash)?.title ?? byHash.get(row.urlHash)?.heading ?? null,
        status: row.lastStatus ?? null,
        crawledAt: row.lastCrawledAt ?? null,
        changedAt: byHash.get(row.urlHash)?.updatedAt ?? null,
      }));
    },

    /**
     * Pages found and not read: left out by one of the source's rules, or by its robots.txt.
     * Newest first, so what a crawl just passed over is what is shown.
     */
    async leftOut(siteId, limit = 4) {
      const filter = {
        siteId,
        $or: [{ inScope: false, scopeReason: { $in: ["EXCLUDED_PATH", "NOT_INCLUDED"] } }, { inScope: true, robotsAllowed: false }],
      };
      const [items, total] = await Promise.all([
        urls.find(filter).project({ url: 1, inScope: 1, scopeReason: 1, robotsAllowed: 1, lastSeenAt: 1 }).sort({ lastSeenAt: -1, url: 1 }).limit(limit).toArray(),
        urls.countDocuments(filter),
      ]);
      return {
        total,
        items: items.map((row) => ({
          url: row.url,
          reason: row.inScope === false ? (row.scopeReason === "NOT_INCLUDED" ? "outside-section" : "excluded") : "robots",
        })),
      };
    },

    /** The pages a run has just read, newest first. */
    async latestRead(siteId, runId, limit = 5) {
      if (!runId) return [];
      const rows = await snapshots
        .find({ siteId, runId })
        .project({ url: 1, status: 1, fetchedAt: 1 })
        .sort({ fetchedAt: -1 })
        .limit(limit)
        .toArray();
      return rows.map((row) => ({ url: row.url, status: row.status ?? null, fetchedAt: row.fetchedAt }));
    },

    /** The sitemaps the source's robots.txt names, from the last time it was read. */
    async sitemapsOf(siteId) {
      const row = await robots.find({ siteId }).project({ sitemaps: 1 }).sort({ fetchedAt: -1 }).limit(1).next();
      return row?.sitemaps ?? [];
    },

    /** How many of the website's pages link to a host: a source "next to" the website. */
    async websitePagesLinkingTo(websiteId, host) {
      if (!websiteId || !host) return 0;
      const pattern = new RegExp(`^https?://${host.replace(/\./g, "\\.")}(?:[:/?#]|$)`, "i");
      const rows = await links.aggregate([
        { $match: { siteId: websiteId, internal: false, toUrl: pattern } },
        { $group: { _id: "$fromUrlHash" } },
        { $count: "pages" },
      ]).toArray();
      return rows[0]?.pages ?? 0;
    },

    /** Pages of one site by hash, with their depth: where "Found on your website" says a link is. */
    async urlsOf(siteId, hashes) {
      if (!hashes.length) return new Map();
      const rows = await urls.find({ siteId, urlHash: { $in: hashes } }).project({ urlHash: 1, url: 1, depth: 1 }).toArray();
      return new Map(rows.map((row) => [row.urlHash, { url: row.url, depth: row.depth ?? null }]));
    },

    /** The keys of every page of a source the Library holds a row for. */
    async pageKeysOf(workspaceId, siteId) {
      const rows = await state.find({ workspaceId: toObjectId(workspaceId), siteId }).project({ sourceKey: 1 }).toArray();
      return rows.map((row) => row.sourceKey);
    },

    /**
     * Takes a removed source out of the Library: its branch of `/sources`, its pages' state and
     * ledger rows, and its queued Library work. Its pages' index rows go only when the caller
     * says their points are gone (`indexErased`); otherwise they stay for the worker's next index
     * pass, which forgets every row whose page no source still has.
     *
     * The knowledge base's own files are not touched: what it wrote from the source stays, and
     * each file still names the pages it cited.
     */
    async removeLibraryBranch({ workspaceId, siteId, folder, keys, indexErased }) {
      const owner = toObjectId(workspaceId);
      const root = sourceFolderPath(folder);
      const branch = { workspaceId: owner, $or: [{ path: root }, { path: { $regex: `^${root}/` } }] };
      const [files] = await Promise.all([
        nodes.deleteMany(branch),
        state.deleteMany({ workspaceId: owner, siteId }),
        ledger.deleteMany({ workspaceId: owner, siteId }),
        jobs.deleteMany({ agent: "library", siteId, status: "pending" }),
      ]);
      if (indexErased && keys.length) {
        await Promise.all([
          indexState.deleteMany({ workspaceId: owner, sourceKind: "page", sourceKey: { $in: keys } }),
          chunks.deleteMany({ workspaceId: owner, sourceKind: "page", sourceKey: { $in: keys } }),
        ]);
      }
      return { files: files.deletedCount };
    },

    /** Whether a Library pass of this source is being worked on right now. */
    async mirrorRunning(siteId) {
      return Boolean(await jobs.findOne({ agent: "library", siteId, status: "running" }, { projection: { _id: 1 } }));
    },
  };
}
