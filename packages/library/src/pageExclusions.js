import { AGENT_COLLECTIONS } from "@orbik/core";

import { isListingUrl } from "./selection.js";
import { sourceMirrorVerdict } from "./sourceLayer.js";

/**
 * Which of a site's pages are not documents of the workspace in their own right, asked of the crawl
 * alone.
 *
 * Two readers ask, and they have to agree. The source layer stores a page unless it is a duplicate
 * of another, has no text, or says not to index it; the retrieval index embeds what the source
 * layer would store, less the archives of other pages. Until 2026-10-14 the index embedded every
 * page the crawler rendered: on one development site that was 1,000 duplicate URLs beside 1,061
 * pages — `http://` twins, `?ref=` twins, trailing-slash twins — so a search answered with each
 * passage twice, and tag archives the site marks `noindex` came first for a question about the
 * blog.
 *
 * Both are worked out from what the crawl recorded rather than from what the source layer did with
 * it, because the two stages run beside each other: the index pass a crawl hands off must not wait
 * on the mirror to know which pages are duplicates.
 */

/** The indexability reasons that mean "the site does not want this read", and only those. */
const HONOURED_EXCLUSIONS = Object.freeze(["META_NOINDEX", "HEADER_NOINDEX", "ROBOTS_DISALLOWED"]);

/**
 * The pages that ask not to be indexed, by the site's own instruction.
 *
 * Read from the latest snapshot's `indexabilityReasons` rather than from `crawl_urls.indexable`,
 * and that distinction is the difference between a complete mirror and an empty one. On the first
 * site this ran against, fifty-three of seventy-eight URLs were "not indexable" and every single
 * one of them was `CANONICAL_TO_OTHER` — a page whose canonical tag names its own trailing-slash
 * twin, where the twin is frequently not even rendered. Skipping those would have left the
 * Library with no service pages at all.
 *
 * A `noindex` directive, or a path robots.txt disallows, is a different statement: the site is
 * saying do not read this. Those, and nothing else, are honoured here.
 *
 * @param {import("mongodb").Db} database connected database
 * @param {import("mongodb").ObjectId} siteId the crawl
 * @returns {Promise<Set<string>>} URL hashes
 */
export async function noindexPageKeys(database, siteId) {
  const rows = await database
    .collection(AGENT_COLLECTIONS.snapshots)
    .aggregate([
      { $match: { siteId } },
      { $sort: { fetchedAt: -1 } },
      // The latest snapshot per URL, whichever crawl produced it, and only then the question — so
      // a page that carried a noindex last month and does not now is not still honoured.
      { $group: { _id: "$urlHash", reasons: { $first: "$indexabilityReasons" } } },
      { $match: { reasons: { $in: [...HONOURED_EXCLUSIONS] } } },
      { $project: { _id: 1 } },
    ])
    .toArray();
  return new Set(rows.map((row) => row._id));
}

/**
 * Everything {@link indexExclusionOf} needs about one site, in three queries.
 *
 * @param {object} options
 * @param {import("mongodb").Db} options.database connected database
 * @param {import("mongodb").ObjectId} options.workspaceId owning workspace
 * @param {import("mongodb").ObjectId} options.siteId its crawl
 * @returns {Promise<{variants: Set<string>, noindex: Set<string>, included: Set<string>}>}
 */
export async function loadPageExclusions({ database, workspaceId, siteId }) {
  const [variants, noindex, included] = await Promise.all([
    database
      .collection(AGENT_COLLECTIONS.urls)
      .find({ siteId, variantOf: { $ne: null } })
      .project({ _id: 0, urlHash: 1 })
      .toArray(),
    noindexPageKeys(database, siteId),
    database
      .collection(AGENT_COLLECTIONS.sourceNotes)
      .find({ workspaceId, include: true })
      .project({ _id: 0, sourceKey: 1 })
      .toArray(),
  ]);
  return {
    variants: new Set(variants.map((row) => row.urlHash)),
    noindex,
    included: new Set(included.map((row) => row.sourceKey)),
  };
}

/**
 * Why a page is left out of the retrieval index, or null when it is indexed.
 *
 * What the source layer would not store, by its own rule — a duplicate, a page that says
 * `noindex` — and, beyond that, an archive: pagination and the tag, category and author listings,
 * whose text is the titles and opening lines of posts that are indexed themselves. A page a
 * person asked for by name is indexed whatever it is, except a duplicate, whose words are already
 * in the index under the page it duplicates.
 *
 * @param {{urlHash: string, url: string|null, words?: number}} page a rendered page
 * @param {{variants: Set<string>, noindex: Set<string>, included: Set<string>}} exclusions
 * @returns {"duplicate"|"noindex"|"listing"|null}
 */
export function indexExclusionOf(page, { variants, noindex, included }) {
  const asked = included.has(page.urlHash);
  // An empty page is cut into no passages anyway, so its word count is not asked here.
  const verdict = sourceMirrorVerdict({
    variant: variants.has(page.urlHash),
    noindex: noindex.has(page.urlHash),
    words: 1,
    included: asked,
  });
  if (!verdict.store) return verdict.reason;
  if (!asked && isListingUrl(page.url)) return "listing";
  return null;
}
