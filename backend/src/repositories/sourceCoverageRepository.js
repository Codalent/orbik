import { AGENT_COLLECTIONS } from "@orbik/core";
import { BRAND_ROOT_PATH, LIBRARY_NODE_KINDS, LIBRARY_SOURCE_KINDS, SOURCE_ROOT_PATH } from "@orbik/library";

/**
 * The deterministic answer to "is the whole site actually in here".
 *
 * Every version of the knowledge agent before the source layer had the same unanswerable question
 * behind it: a Library of nineteen files built from a seventy-two-page site either covered the
 * site or did not, and nothing said which. The agent's own summary could not be the answer — a run
 * that wrote "the individual platform pages are summarised collectively" believed it had covered
 * them — and counting files says nothing about pages.
 *
 * With a copy of every page in the source layer, and the pages the knowledge base is written from
 * chosen by rule, there is a real arithmetic answer in two parts, and both matter:
 *
 * - **Is every page stored?** Pages the crawler rendered, against copies made, pages that are not
 *   stored at all (a duplicate, a page with no text) and failures outstanding. A page in none of
 *   those is one the mirror has not reached yet.
 * - **Is every chosen page written from?** A page that was chosen and that no file cites is one
 *   the knowledge base has not caught up with. It is counted from the `sources` every file
 *   already stores, so it costs one aggregation and cannot drift from what the files say.
 *
 * Read from MongoDB alone, like the index status line beside it, so the number is available
 * whether or not anything else is running.
 *
 * @param {object} dependencies
 * @param {import("mongodb").Db} dependencies.database connected database
 */
export function createSourceCoverageReader({ database }) {
  const markdown = database.collection(AGENT_COLLECTIONS.markdown);
  const state = database.collection(AGENT_COLLECTIONS.sourceNotes);
  const nodes = database.collection(AGENT_COLLECTIONS.libraryNodes);
  const urls = database.collection(AGENT_COLLECTIONS.urls);

  return {
    /**
     * How much of one workspace's site is stored, and how much of what was chosen is written from.
     *
     * @param {object} options
     * @param {import("mongodb").ObjectId} options.workspaceId
     * @param {import("mongodb").ObjectId|null} [options.siteId] the crawl whose pages count
     * @returns {Promise<{pages: number, stored: number, notStored: number, failed: number,
     *   removed: number, pending: number, chosen: number, cited: number, uncited: number,
     *   mirroredAt: string|null, crawl: {addresses: number, errors: number, notPages: number,
     *   notFetched: number}}>}
     */
    async coverageOf({ workspaceId, siteId = null }) {
      const [pages, buckets, cited, crawl] = await Promise.all([
        siteId ? markdown.countDocuments({ siteId }) : 0,
        state
          .aggregate([
            { $match: { workspaceId } },
            {
              $group: {
                _id: null,
                // Counted by what each row says rather than as an exclusive `$switch`: a page can
                // be stored *and* have failed on a later copy, and what a reader wants to know is
                // how many are outstanding.
                stored: {
                  $sum: { $cond: [{ $and: [{ $ifNull: ["$mirroredAt", false] }, { $ne: ["$removed", true] }] }, 1, 0] },
                },
                notStored: { $sum: { $cond: [{ $ifNull: ["$skipped", false] }, 1, 0] } },
                failed: { $sum: { $cond: [{ $ifNull: ["$error", false] }, 1, 0] } },
                removed: { $sum: { $cond: [{ $eq: ["$removed", true] }, 1, 0] } },
                chosen: {
                  $sum: { $cond: [{ $and: [{ $eq: ["$chosen", true] }, { $ne: ["$removed", true] }] }, 1, 0] },
                },
                mirroredAt: { $max: "$mirroredAt" },
              },
            },
          ])
          .toArray(),
        citedPages(nodes, workspaceId),
        siteId ? crawledAddresses(urls, siteId) : null,
      ]);

      const row = buckets[0] ?? {};
      const stored = row.stored ?? 0;
      const notStored = row.notStored ?? 0;
      const chosen = row.chosen ?? 0;
      const written = chosen && cited.length
        ? await state.countDocuments({ workspaceId, chosen: true, removed: { $ne: true }, sourceKey: { $in: cited } })
        : 0;
      return {
        pages,
        stored,
        notStored,
        failed: row.failed ?? 0,
        removed: row.removed ?? 0,
        // Pages the mirror has not reached. Clamped at zero rather than allowed to go negative: a
        // crawl that dropped pages between the two counts should read as "nothing outstanding",
        // not as a number that cannot be true.
        pending: Math.max(0, pages - stored - notStored),
        chosen,
        cited: written,
        uncited: Math.max(0, chosen - written),
        mirroredAt: row.mirroredAt ? new Date(row.mirroredAt).toISOString() : null,
        // What the crawl's own count of the site is made of, so "30 pages stored" beside a crawl
        // that reports 68 can say where the other 38 went.
        crawl: crawl ?? { addresses: 0, errors: 0, notPages: 0, notFetched: 0 },
      };
    },
  };
}

/**
 * The pages some file of the knowledge base cites, by the crawler's key.
 *
 * The source layer's own files are left out, since each cites the page it is a copy of, and so is
 * the brand folder, whose guide is measured from pages rather than written from their words.
 */
async function citedPages(nodes, workspaceId) {
  const rows = await nodes
    .aggregate([
      {
        $match: {
          workspaceId,
          kind: LIBRARY_NODE_KINDS.file,
          path: { $not: new RegExp(`^(${SOURCE_ROOT_PATH}|${BRAND_ROOT_PATH})(/|$)`) },
        },
      },
      { $project: { sources: 1 } },
      { $unwind: "$sources" },
      { $match: { "sources.kind": LIBRARY_SOURCE_KINDS.page } },
      // Distinct, because two files legitimately cite the same page.
      { $group: { _id: "$sources.key" } },
    ])
    .toArray();
  return rows.map((row) => row._id);
}

/**
 * The addresses the crawl knows for a site, the figure its own page reports as the site's pages,
 * and why the ones that are not stored here are not.
 *
 * A crawl counts every address it found and did not fold into another as a duplicate: pages, but
 * also addresses that answered with an error, files that are not pages (a `.md` twin of a page, a
 * PDF), redirects and pages marked `noindex`. Only the pages with readable content are rendered to
 * Markdown, and those are what `pages` above counts and Sources stores. The two figures are both
 * right and count different things; without the difference spelt out they read as a contradiction.
 *
 * - `errors`: fetched, and answered 400 or above.
 * - `notPages`: fetched, answered, and not a page to store — not indexable, which is how the
 *   crawler records a non-HTML file, a redirect or `noindex`.
 * - `notFetched`: found and not fetched yet, or not allowed to be.
 */
async function crawledAddresses(urls, siteId) {
  const [row] = await urls
    .aggregate([
      { $match: { siteId, $or: [{ variantOf: null }, { variantOf: { $exists: false } }] } },
      {
        $group: {
          _id: null,
          addresses: { $sum: 1 },
          errors: { $sum: { $cond: [{ $gte: ["$lastStatus", 400] }, 1, 0] } },
          notPages: {
            $sum: {
              $cond: [
                { $and: [{ $gt: ["$lastStatus", 0] }, { $lt: ["$lastStatus", 400] }, { $ne: ["$indexable", true] }] },
                1,
                0,
              ],
            },
          },
          notFetched: { $sum: { $cond: [{ $gt: ["$lastStatus", 0] }, 0, 1] } },
        },
      },
    ])
    .toArray();
  return {
    addresses: row?.addresses ?? 0,
    errors: row?.errors ?? 0,
    notPages: row?.notPages ?? 0,
    notFetched: row?.notFetched ?? 0,
  };
}
