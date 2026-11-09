import { AGENT_COLLECTIONS, toObjectId } from "@orbik/core";
import {
  LIBRARY_CHUNK_KIND,
  LIBRARY_NODE_KINDS,
  LIBRARY_SOURCE_KINDS,
  SOURCE_LAYER_WRITER_SLUG,
  indexExclusionOf,
  isSourceLayerPath,
  loadPageExclusions,
} from "@orbik/library";

/**
 * What the retrieval index currently holds for one workspace, read from MongoDB alone.
 *
 * It lives in `@orbik/retrieval`, beside the index it describes, and its one caller is the API,
 * which renders the status line the Library page and the ask page both show. It never reaches the
 * vector database, and that is the point: the index state *is* in MongoDB, and a status that
 * needed Qdrant to be up would go blank at exactly the moment it has something to say.
 *
 * Staleness is judged per kind of source, by whatever that kind cheaply proves:
 *
 * - A crawled page carries the content hash the crawler wrote when it rendered it. Comparing that
 *   against the hash the indexer last embedded is exact: a re-crawl that changed nothing costs
 *   nothing, and the alternative — a timestamp — would re-embed a whole site every week.
 * - A Library file has no content hash on it, only a `revision` that a write bumps. So the
 *   comparison here is by revision, which is *conservative*: it reports a file as pending after a
 *   restore that put back identical text. The indexer then computes the content hash, finds it
 *   unchanged, records the new revision and embeds nothing. The cheap check may cry wolf; the
 *   expensive one never pays twice.
 *
 * Only what the indexer would index is counted: not a duplicate, a `noindex` page or an archive of
 * other pages (`indexExclusionOf`), and not the source layer's copy of a page that is still on the
 * site, which is indexed as the page. Counting those would report them pending for good.
 */

/**
 * Creates the reader for one database.
 *
 * @param {object} dependencies
 * @param {import("mongodb").Db} dependencies.database connected database
 */
export function createIndexStatusReader({ database }) {
  const state = database.collection(AGENT_COLLECTIONS.indexState);
  const markdown = database.collection(AGENT_COLLECTIONS.markdown);
  const nodes = database.collection(AGENT_COLLECTIONS.libraryNodes);

  return {
    /**
     * Summarises one workspace's index.
     *
     * @param {object} options
     * @param {unknown} options.workspaceId owning workspace
     * @param {unknown} [options.siteId] the crawl the pages come from; without one there are none
     * @returns {Promise<{chunks: number, pages: number, libraryFiles: number, pending: number,
     *   failed: number, sources: number, indexedAt: string|null, model: string|null,
     *   error: {code: string, message: string}|null}>}
     */
    async statusOf({ workspaceId, siteId = null }) {
      const owner = toObjectId(workspaceId);
      const site = siteId ? toObjectId(siteId) : null;
      const [rows, rendered, nodeRows, exclusions] = await Promise.all([
        state.find({ workspaceId: owner }).project({ sourceKind: 1, sourceKey: 1, hash: 1, revision: 1, chunks: 1, indexedAt: 1, model: 1, error: 1 }).toArray(),
        site ? markdown.find({ siteId: site }).project({ urlHash: 1, url: 1, hash: 1 }).toArray() : [],
        nodes
          .find({ workspaceId: owner, kind: LIBRARY_NODE_KINDS.file })
          .project({ path: 1, revision: 1, authors: 1, removed: 1, hasUserContent: 1 })
          .toArray(),
        site ? loadPageExclusions({ database, workspaceId: owner, siteId: site }) : null,
      ]);
      const pages = exclusions ? rendered.filter((page) => !indexExclusionOf(page, exclusions)) : rendered;
      const files = nodeRows.filter((file) => !(
        isSourceLayerPath(file.path ?? "")
        && file.authors?.agent === SOURCE_LAYER_WRITER_SLUG
        && file.removed !== true
        && file.hasUserContent !== true
      ));

      const byKey = new Map(rows.map((row) => [`${row.sourceKind}\u0000${row.sourceKey}`, row]));
      let pending = 0;
      for (const page of pages) {
        const row = byKey.get(`${LIBRARY_SOURCE_KINDS.page}\u0000${page.urlHash}`);
        if (!row || row.hash !== page.hash) pending += 1;
      }
      for (const file of files) {
        const row = byKey.get(`${LIBRARY_CHUNK_KIND}\u0000${file.path}`);
        if (!row || (row.revision ?? null) !== (file.revision ?? null)) pending += 1;
      }

      const indexed = rows.filter((row) => row.indexedAt);
      const failures = rows.filter((row) => row.error);
      const latest = indexed.reduce(
        (newest, row) => (!newest || row.indexedAt > newest ? row.indexedAt : newest),
        null,
      );
      // The newest failure rather than a list: every row of a pass that could not reach Qdrant or
      // the embedding provider carries the same one, and repeating it is noise.
      const failure = failures
        .slice()
        .sort((left, right) => (right.error?.at ?? 0) - (left.error?.at ?? 0))[0]?.error ?? null;

      return {
        chunks: indexed.reduce((total, row) => total + (row.chunks ?? 0), 0),
        pages: indexed.filter((row) => row.sourceKind === LIBRARY_SOURCE_KINDS.page).length,
        libraryFiles: indexed.filter((row) => row.sourceKind === LIBRARY_CHUNK_KIND).length,
        sources: pages.length + files.length,
        pending,
        failed: failures.length,
        indexedAt: latest ? new Date(latest).toISOString() : null,
        model: indexed[0]?.model ?? null,
        error: failure ? { code: failure.code, message: failure.message } : null,
      };
    },
  };
}
