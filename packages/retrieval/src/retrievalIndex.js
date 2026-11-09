import { AGENT_COLLECTIONS, log, toObjectId } from "@orbik/core";
import {
  LIBRARY_CHUNK_KIND,
  LIBRARY_NODE_KINDS,
  LIBRARY_SOURCE_KINDS,
  SOURCE_LAYER_WRITER_SLUG,
  USER_BLOCK_OPEN,
  indexExclusionOf,
  isSourceLayerPath,
  loadPageExclusions,
  markUserBlocks,
} from "@orbik/library";

import { chunkMarkdown, hashDocument } from "./chunks.js";
import { EMBEDDING_BATCH } from "./embeddings.js";
import { pointIdOf } from "./vectorStore.js";

/**
 * The retrieval index: what turns a workspace's documents into passages anything can search.
 *
 * Two collections of documents go in — the Markdown the crawler rendered from every page, and the
 * Library files agents and people write — and what comes out is one flat set of passages, each
 * knowing which document and which section it came from. Everything above this module works in
 * passages: the `content.search` tool, the chat that answers from it, and the knowledge agent that
 * uses it to find what a site says about a subject without reading every page that mentions it.
 *
 * **The index is a cache, and it says so.** Nothing here is a source of truth: every chunk can be
 * rebuilt from the document it came from, and `index_state` exists only to make the rebuild cheap.
 * That is what makes it safe for a pass to fail halfway — the state rows it did not reach still
 * hold the hashes they held before, so the next pass does exactly the work that is left.
 *
 * **Nothing is embedded twice.** Embedding is the only per-word cost in Orbik, and a weekly crawl
 * that re-fetches an unchanged site must cost nothing. So the unit of work is a source whose
 * content hash differs from the one recorded against it, and a run over a site where nothing moved
 * makes no provider call at all. This is checked, not hoped for: the hash compared is the hash of
 * what was embedded.
 *
 * @param {object} dependencies collaborators
 * @param {import("mongodb").Db} dependencies.database connected database
 * @param {object} dependencies.store the vector store, from `createVectorStore`
 * @param {object} dependencies.embedder the embedding provider, `embed(texts) → vectors`
 * @param {(level: string, message: string, context?: object) => void} [dependencies.logger]
 */
export function createRetrievalIndex({ database, store, embedder, logger = log }) {
  const chunks = database.collection(AGENT_COLLECTIONS.knowledgeChunks);
  const state = database.collection(AGENT_COLLECTIONS.indexState);
  const markdown = database.collection(AGENT_COLLECTIONS.markdown);
  const nodes = database.collection(AGENT_COLLECTIONS.libraryNodes);

  /**
   * Every source this workspace has, with whatever cheaply proves whether it has changed.
   *
   * Deliberately without the text. On a two-thousand-page site loading every page's Markdown to
   * find the three that moved would be the most expensive part of a pass that then embeds nothing,
   * so the text is fetched later and only for the sources that turn out to need it.
   *
   * **A page is indexed once.** The source layer holds a copy of every page, and the pages are
   * indexed in their own right — with the URL and the section anchors a citation needs. Indexing
   * the copy as well would put every passage of the site in the index twice, and a search would
   * answer with the same paragraph as a page and as a file. So the copy of a page that is still
   * on the site is left out. Two things about it are kept: what a person wrote inside it, which is
   * in no page, and a copy whose page has gone, which is the only place those words still are.
   *
   * **And only the pages that are documents in their own right.** A duplicate of another page, a
   * page that says `noindex`, and an archive of other pages — pagination, tag and author listings
   * — are left out by `indexExclusionOf`, the rule the source layer shares. A page that drops out
   * this way is removed from the index by the sweep below, like one the crawler stopped rendering.
   */
  async function listSources({ workspaceId, siteId }) {
    const [rendered, nodeRows, exclusions] = await Promise.all([
      siteId
        ? markdown
          .find({ siteId })
          .project({ urlHash: 1, url: 1, title: 1, heading: 1, hash: 1, updatedAt: 1 })
          .toArray()
        : [],
      nodes
        .find({ workspaceId, kind: LIBRARY_NODE_KINDS.file })
        .project({ path: 1, title: 1, revision: 1, updatedAt: 1, authors: 1, removed: 1, hasUserContent: 1 })
        .toArray(),
      siteId ? loadPageExclusions({ database, workspaceId, siteId }) : null,
    ]);
    const pages = exclusions ? rendered.filter((page) => !indexExclusionOf(page, exclusions)) : rendered;
    const files = nodeRows.filter((file) => !isLiveCopy(file) || file.hasUserContent === true);

    return [
      ...pages.map((page) => ({
        sourceKind: LIBRARY_SOURCE_KINDS.page,
        sourceKey: page.urlHash,
        url: page.url ?? null,
        path: null,
        title: page.title ?? page.heading ?? null,
        hash: page.hash ?? null,
        revision: null,
        updatedAt: page.updatedAt ?? null,
      })),
      ...files.map((file) => ({
        sourceKind: LIBRARY_CHUNK_KIND,
        sourceKey: file.path,
        url: null,
        path: file.path,
        title: file.title ?? null,
        // A Library file's content hash is not stored on the node, so it cannot be known without
        // reading the text. `revision` stands in for the cheap check; the hash is computed below
        // and is still what decides whether anything is embedded.
        hash: null,
        revision: file.revision ?? null,
        updatedAt: file.updatedAt ?? null,
      })),
    ];
  }

  /**
   * The passages of Library files with what a person wrote in them marked, as `library.read`
   * marks a file: wrapped in `<!-- user -->` … `<!-- /user -->`.
   *
   * Marked when a search answers rather than when a file is indexed, for two reasons. The marks
   * would otherwise be embedded as words and change what a passage matches; and which blocks are a
   * person's changes without the text changing — an agent that keeps a paragraph somebody wrote
   * writes the same words — so a mark stored in the index would be wrong until the next pass. A
   * passage with nothing of a person's in it is returned exactly as it was stored.
   */
  async function withPersonsWriting(workspaceId, rows) {
    const paths = [...new Set(rows.filter((row) => row.sourceKind === LIBRARY_CHUNK_KIND && row.path).map((row) => row.path))];
    if (!paths.length) return rows;
    const written = await nodes
      .find({ workspaceId, path: { $in: paths }, kind: LIBRARY_NODE_KINDS.file, hasUserContent: true })
      .project({ path: 1, protectedBlocks: 1 })
      .toArray();
    if (!written.length) return rows;
    const blocksOf = new Map(written.map((node) => [node.path, node.protectedBlocks ?? []]));
    return rows.map((row) => {
      const blocks = row.sourceKind === LIBRARY_CHUNK_KIND ? blocksOf.get(row.path) : null;
      if (!blocks?.length) return row;
      const marked = markUserBlocks(row.text, blocks);
      return marked.includes(USER_BLOCK_OPEN) ? { ...row, text: marked } : row;
    });
  }

  /** Reads the text of one source, and the hash that says what it currently is. */
  async function readSource(source, { workspaceId, siteId }) {
    if (source.sourceKind === LIBRARY_SOURCE_KINDS.page) {
      const page = await markdown.findOne(
        { siteId, urlHash: source.sourceKey },
        { projection: { markdown: 1, url: 1, title: 1, heading: 1, hash: 1, updatedAt: 1 } },
      );
      if (!page) return null;
      return {
        ...source,
        url: page.url ?? source.url,
        title: page.title ?? page.heading ?? source.title,
        hash: page.hash ?? null,
        markdown: page.markdown ?? "",
        updatedAt: page.updatedAt ?? source.updatedAt,
      };
    }

    const node = await nodes.findOne(
      { workspaceId, path: source.sourceKey, kind: LIBRARY_NODE_KINDS.file },
      {
        projection: {
          path: 1, markdown: 1, title: 1, summary: 1, revision: 1, updatedAt: 1,
          authors: 1, removed: 1, protectedBlocks: 1,
        },
      },
    );
    if (!node) return null;
    if (isLiveCopy(node)) {
      // The page's own passages are in the index already. What is not is the writing a person
      // added to the copy, so that, and only that, is what this file contributes.
      const theirs = (node.protectedBlocks ?? []).map((block) => block.text).join("\n\n");
      return {
        ...source,
        title: node.title ?? source.title,
        revision: node.revision ?? source.revision,
        hash: hashDocument(node.title, theirs),
        markdown: theirs,
        updatedAt: node.updatedAt ?? source.updatedAt,
      };
    }
    return {
      ...source,
      title: node.title ?? source.title,
      revision: node.revision ?? source.revision,
      // The summary is part of the hash because rewriting it changes what the file claims to be
      // even when the body is untouched, and the first chunk carries it.
      hash: hashDocument(node.title, node.summary, node.markdown),
      markdown: `${node.summary ? `${node.summary}\n\n` : ""}${node.markdown ?? ""}`,
      updatedAt: node.updatedAt ?? source.updatedAt,
    };
  }

  /**
   * Writes one part of one source's passages: the vectors to Qdrant, the text to MongoDB.
   *
   * The two stores are written in that order and neither is transactional with the other. A crash
   * between them leaves a point whose text is missing, which the search below drops rather than
   * returning a result with nothing in it — and the state row is written last, so the next pass
   * re-does the source and repairs it.
   *
   * A part rather than a whole source, because a document long enough to need more than one
   * embedding request must still be written as one piece: only the last part removes what a
   * shortened document left behind, and only the last part records the source as indexed.
   */
  async function writePart({ source, part, cut, previous, last }, vectors, workspaceId) {
    const owner = workspaceId.toHexString();
    const points = part.map((chunk, index) => ({
      id: pointIdOf({ workspaceId: owner, sourceKind: source.sourceKind, sourceKey: source.sourceKey, ordinal: chunk.ordinal }),
      vector: vectors[index],
      payload: {
        workspaceId: owner,
        sourceKind: source.sourceKind,
        sourceKey: source.sourceKey,
        url: source.url,
        path: source.path,
        title: source.title,
        headingPath: chunk.headingPath,
        ordinal: chunk.ordinal,
        // A bounded snippet rather than the passage: the full text lives in MongoDB, and a
        // payload carrying every word would make the vector database a second copy of the corpus
        // with none of the reasons to be one.
        snippet: chunk.text.slice(0, SNIPPET_CHARACTERS),
        model: embedder.model,
        updatedAt: source.updatedAt ? new Date(source.updatedAt).toISOString() : null,
      },
    }));

    await store.upsert(points);

    await chunks.bulkWrite(
      part.map((chunk, index) => ({
        updateOne: {
          filter: { workspaceId, sourceKind: source.sourceKind, sourceKey: source.sourceKey, ordinal: chunk.ordinal },
          update: {
            $set: {
              pointId: points[index].id,
              url: source.url,
              path: source.path,
              title: source.title,
              headingPath: chunk.headingPath,
              text: chunk.text,
              hash: chunk.hash,
              characters: chunk.characters,
              model: embedder.model,
              updatedAt: source.updatedAt ?? new Date(),
              indexedAt: new Date(),
            },
            $setOnInsert: {
              workspaceId,
              sourceKind: source.sourceKind,
              sourceKey: source.sourceKey,
              ordinal: chunk.ordinal,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );

    if (!last) return;

    // A document that got shorter leaves points and rows behind it. They are removed by ordinal,
    // which the previous state row is the only record of — which is why it is read before the new
    // one is written.
    const before = previous?.chunks ?? 0;
    if (before > cut.length) {
      const stale = [];
      for (let ordinal = cut.length; ordinal < before; ordinal += 1) {
        stale.push(pointIdOf({ workspaceId: owner, sourceKind: source.sourceKind, sourceKey: source.sourceKey, ordinal }));
      }
      await store.deletePoints(stale);
      await chunks.deleteMany({
        workspaceId,
        sourceKind: source.sourceKind,
        sourceKey: source.sourceKey,
        ordinal: { $gte: cut.length },
      });
    }
    await recordIndexed(workspaceId, source, cut);
  }

  /** Records that one source is indexed at this hash, and clears any failure against it. */
  function recordIndexed(workspaceId, source, cut) {
    return state.updateOne(
      { workspaceId, sourceKind: source.sourceKind, sourceKey: source.sourceKey },
      {
        $set: {
          hash: source.hash,
          revision: source.revision ?? null,
          chunks: cut.length,
          characters: cut.reduce((total, chunk) => total + chunk.characters, 0),
          model: embedder.model,
          indexedAt: new Date(),
          url: source.url,
          path: source.path,
          title: source.title,
        },
        $unset: { error: "" },
        $setOnInsert: { workspaceId, sourceKind: source.sourceKind, sourceKey: source.sourceKey },
      },
      { upsert: true },
    );
  }

  /**
   * Records why a source could not be indexed, without touching what it was indexed at.
   *
   * That distinction is the whole retry story. The hash stays as it was, so the next pass sees the
   * same work outstanding and does it; and the reason is on the row, so the status line can say
   * "the index is offline" rather than "nothing has been indexed" — two very different sentences
   * to read when a question comes back empty.
   */
  function recordFailure(workspaceId, source, failure) {
    return state.updateOne(
      { workspaceId, sourceKind: source.sourceKind, sourceKey: source.sourceKey },
      {
        $set: {
          error: { code: failure.code ?? "INDEX_FAILED", message: String(failure.message ?? "").slice(0, 400), at: new Date() },
          attemptedAt: new Date(),
          url: source.url,
          path: source.path,
          title: source.title,
        },
        $setOnInsert: { workspaceId, sourceKind: source.sourceKind, sourceKey: source.sourceKey },
      },
      { upsert: true },
    );
  }

  /**
   * Whether a Library file is the source layer's copy of a page that is still on the site.
   *
   * Asked of who wrote it as well as of where it is, because a person can make a file of their
   * own under `/sources`, and that is a document like any other.
   */
  function isLiveCopy(file) {
    return isSourceLayerPath(file.path ?? "")
      && file.authors?.agent === SOURCE_LAYER_WRITER_SLUG
      && file.removed !== true;
  }

  /** Removes every trace of a source that no longer exists. */
  async function forget(workspaceId, row) {
    await store.deleteSource({
      workspaceId: workspaceId.toHexString(),
      sourceKind: row.sourceKind,
      sourceKey: row.sourceKey,
    });
    await chunks.deleteMany({ workspaceId, sourceKind: row.sourceKind, sourceKey: row.sourceKey });
    await state.deleteOne({ workspaceId, sourceKind: row.sourceKind, sourceKey: row.sourceKey });
  }

  return {
    model: embedder.model,
    dimensions: embedder.dimensions,

    /** Creates the Qdrant collection and its payload indexes if they are missing. */
    ensureReady() {
      return store.ensureCollection();
    },

    /**
     * Brings one workspace's index up to date with its documents.
     *
     * Bounded by `limit` sources per call so one pass cannot hold a queue lease for an hour on a
     * first index of a large site; the caller re-enqueues while `remaining` is non-zero, exactly
     * as the crawler's finalize step re-queues itself while fetches are outstanding.
     *
     * @param {object} options
     * @param {unknown} options.workspaceId owning workspace
     * @param {unknown} [options.siteId] the crawl whose pages belong to it
     * @param {number} [options.limit] sources this pass may index
     * @param {() => Promise<unknown>} [options.heartbeat] extends the caller's lease between batches
     * @param {AbortSignal} [options.signal] cancellation
     */
    async indexWorkspace({ workspaceId, siteId = null, limit = MAX_SOURCES_PER_PASS, heartbeat, signal }) {
      const owner = toObjectId(workspaceId);
      const site = siteId ? toObjectId(siteId) : null;

      await this.ensureReady();

      const sources = await listSources({ workspaceId: owner, siteId: site });
      const rows = await state.find({ workspaceId: owner }).toArray();
      const byKey = new Map(rows.map((row) => [keyOf(row), row]));

      // Sources that have gone: a page the crawler no longer renders, a Library file somebody
      // deleted. Removed first, so a question asked mid-pass cannot be answered from a document
      // that no longer exists.
      const present = new Set(sources.map(keyOf));
      let removed = 0;
      for (const row of rows) {
        if (present.has(keyOf(row))) continue;
        await forget(owner, row);
        removed += 1;
      }

      const pending = sources.filter((source) => {
        const row = byKey.get(keyOf(source));
        if (!row) return true;
        if (row.error) return true;
        if (source.sourceKind === LIBRARY_SOURCE_KINDS.page) return row.hash !== source.hash;
        // A Library file's revision is the cheap check; an equal revision cannot hide a changed
        // body, because every write bumps it.
        return (row.revision ?? null) !== (source.revision ?? null);
      });

      const batch = pending.slice(0, limit);
      const counters = {
        sources: sources.length,
        pending: pending.length,
        indexed: 0,
        unchanged: 0,
        chunks: 0,
        removed,
        failed: 0,
        remaining: Math.max(0, pending.length - batch.length),
      };
      if (!batch.length) return counters;

      // Bundled so one embedding request carries as many passages as it is allowed to, rather than
      // one request per page. Ten pages of five sections each is one call, not ten.
      const handled = new Set();
      let bundle = [];
      let bundled = 0;

      const flush = async () => {
        if (!bundle.length) return;
        const texts = bundle.flatMap((entry) => entry.part.map((chunk) => chunk.text));
        const vectors = await embedder.embed(texts, { trace: { workspaceId: owner, siteId: site } });
        let at = 0;
        for (const entry of bundle) {
          const slice = vectors.slice(at, at + entry.part.length);
          at += entry.part.length;
          await writePart(entry, slice, owner);
          counters.chunks += entry.part.length;
          if (entry.last) {
            handled.add(keyOf(entry.source));
            counters.indexed += 1;
          }
        }
        bundle = [];
        bundled = 0;
        // The lease is extended between requests rather than inside one: an embedding call is
        // seconds, and a first index of a large site is hundreds of them.
        await heartbeat?.();
      };

      try {
        for (const source of batch) {
          signal?.throwIfAborted();
          const previous = byKey.get(keyOf(source)) ?? null;
          const loaded = await readSource(source, { workspaceId: owner, siteId: site });
          if (!loaded) {
            // Deleted between listing the sources and reading this one. The sweep above already
            // removes what is gone, and the next pass will see it missing too.
            handled.add(keyOf(source));
            continue;
          }

          // The expensive check, for the kind that has no cheap one. A Library file restored to a
          // version it already held bumps its revision and changes not one word; recording the new
          // revision and embedding nothing is the whole reason the two checks are separate.
          if (previous && !previous.error && previous.hash && previous.hash === loaded.hash) {
            await state.updateOne(
              { workspaceId: owner, sourceKind: loaded.sourceKind, sourceKey: loaded.sourceKey },
              { $set: { revision: loaded.revision ?? null, checkedAt: new Date() } },
            );
            handled.add(keyOf(source));
            counters.unchanged += 1;
            continue;
          }

          const { chunks: cut } = chunkMarkdown(loaded.markdown, { title: loaded.title });
          if (!cut.length) {
            // A page whose content was all navigation. Recorded at its current hash with nothing
            // behind it, so it is not reconsidered every minute for the rest of its life.
            if (previous?.chunks) {
              await store.deleteSource({ workspaceId: owner.toHexString(), sourceKind: loaded.sourceKind, sourceKey: loaded.sourceKey });
              await chunks.deleteMany({ workspaceId: owner, sourceKind: loaded.sourceKind, sourceKey: loaded.sourceKey });
            }
            await recordIndexed(owner, loaded, []);
            handled.add(keyOf(source));
            counters.indexed += 1;
            continue;
          }

          for (let offset = 0; offset < cut.length; offset += EMBEDDING_BATCH) {
            const part = cut.slice(offset, offset + EMBEDDING_BATCH);
            if (bundled && bundled + part.length > EMBEDDING_BATCH) await flush();
            bundle.push({
              source: loaded,
              part,
              cut,
              previous,
              last: offset + part.length >= cut.length,
            });
            bundled += part.length;
          }
        }
        await flush();
      } catch (error) {
        // Whatever is left of the pass is recorded as failed against the sources it would have
        // covered, and the pass returns rather than throwing: the job is not the thing that went
        // wrong, and dead-lettering it would stop the retries this depends on.
        const untouched = batch.filter((source) => !handled.has(keyOf(source)));
        for (const source of untouched) await recordFailure(owner, source, error);
        counters.failed = untouched.length;
        counters.error = { code: error.code ?? "INDEX_FAILED", message: error.message };
        logger("warn", "index.pass_failed", {
          workspaceId: owner.toHexString(),
          code: error.code ?? "INDEX_FAILED",
          message: error.message,
          failed: counters.failed,
        });
      }

      return counters;
    },

    /**
     * Finds the passages that answer a question, inside one workspace.
     *
     * The workspace is a parameter of this function and never of the query: every caller above
     * takes it from a run's scope, and the filter is applied in the store rather than here, so
     * there is no code path in which it can be omitted.
     *
     * @param {object} options
     * @param {unknown} options.workspaceId owning workspace
     * @param {string} options.query the question, in words
     * @param {string[]} [options.kinds] restrict to `page`, `library` or `document`
     * @param {string} [options.path] restrict Library results to one branch
     * @param {number} [options.limit] passages to return
     * @param {object} [options.trace] the run searching, for the call log: `runId`, `siteId`,
     *   `agentSlug`. The workspace is always this search's own.
     */
    async search({ workspaceId, query, kinds = [], path = null, limit = 8, trace = {} }) {
      const owner = toObjectId(workspaceId);
      const [vector] = await embedder.embed([query.slice(0, MAX_QUERY_CHARACTERS)], {
        trace: { ...trace, workspaceId: owner },
      });
      const points = await store.search({
        vector,
        workspaceId: owner.toHexString(),
        kinds,
        pathPrefix: path,
        // Over-fetched because a path filter is applied to the points that come back: asking for
        // exactly `limit` and then discarding half of them would quietly return four results to a
        // caller that asked for eight.
        limit: path && path !== "/" ? Math.min(limit * 4, 80) : limit,
      });
      if (!points.length) return { query, total: 0, results: [] };

      const stored = await chunks
        .find({ workspaceId: owner, pointId: { $in: points.map((point) => point.id) } })
        .project({ pointId: 1, text: 1, url: 1, path: 1, title: 1, headingPath: 1, sourceKind: 1, sourceKey: 1, ordinal: 1 })
        .toArray();
      // Marked before a long passage is cut, so the mark is where the person's words start.
      const byPoint = new Map((await withPersonsWriting(owner, stored)).map((row) => [row.pointId, row]));

      const results = [];
      let spent = 0;
      for (const point of points) {
        if (results.length >= limit || spent >= MAX_RESULT_CHARACTERS) break;
        // A point whose text is missing is the residue of a pass that died between the two writes.
        // Dropping it is better than returning a result a model cannot read; the next pass over
        // that source restores it.
        const row = byPoint.get(point.id);
        if (!row) continue;
        const snippet = row.text.length > MAX_PASSAGE_CHARACTERS
          ? `${row.text.slice(0, MAX_PASSAGE_CHARACTERS)}…`
          : row.text;
        spent += snippet.length;
        results.push({
          sourceKind: row.sourceKind,
          url: row.url ?? null,
          path: row.path ?? null,
          title: row.title ?? null,
          headingPath: row.headingPath ?? [],
          ordinal: row.ordinal,
          snippet,
          score: Math.round(point.score * 1000) / 1000,
          cite: citationFor(row),
        });
      }

      return { query, total: results.length, results };
    },

    /**
     * Finds the documents whose passages are closest to one document, inside one workspace.
     *
     * "Pages related to this page", answered from the vectors the index already holds rather than
     * by embedding anything: the document's own passages are looked up in MongoDB, and Qdrant
     * searches around the mean of their stored vectors. **No embedding call is made**, so asking
     * costs nothing and works for a document far too long to embed as a query.
     *
     * Passages the document shares word for word with another — a template's call to action, a
     * boilerplate heading — are left out on both sides. They say nothing about what this document
     * is about, and the same paragraph on another page is a perfect match that means nothing.
     *
     * The workspace is a parameter here and never of the query, as in {@link search}; the
     * document itself is never among the results.
     *
     * @param {object} options
     * @param {unknown} options.workspaceId owning workspace
     * @param {string} options.sourceKey the document: a page's URL hash, or a Library path
     * @param {string} [options.sourceKind] what kind of document that is; a page by default
     * @param {string[]} [options.kinds] restrict the neighbours to these kinds; pages by default
     * @param {string[]} [options.excludeSourceKeys] documents to leave out of the neighbours
     * @param {number} [options.limit] documents to return
     * @param {number} [options.passagesPerSource] passages to return for each
     * @returns {Promise<{indexed: boolean, passages: number, passagesUsed: number, total: number,
     *   results: Array<{sourceKind: string, sourceKey: string, url: string|null, path: string|null,
     *   title: string|null, score: number, passages: Array<{ordinal: number, headingPath: string[],
     *   text: string, score: number, cite: string}>}>}>} `indexed` is false when the index has not
     *   reached the document; `passages` is 0 when it was indexed and nothing could be cut from
     *   it. Neither is the same as having no neighbours
     * @throws an error coded `INDEX_UNAVAILABLE` when the vector database is not answering
     */
    async neighbours({
      workspaceId,
      sourceKey,
      sourceKind = LIBRARY_SOURCE_KINDS.page,
      kinds = [LIBRARY_SOURCE_KINDS.page],
      excludeSourceKeys = [],
      limit = 8,
      passagesPerSource = 2,
    }) {
      const owner = toObjectId(workspaceId);
      const own = await chunks
        .find({ workspaceId: owner, sourceKind, sourceKey })
        .project({ _id: 0, pointId: 1, hash: 1, ordinal: 1 })
        .sort({ ordinal: 1 })
        .toArray();
      if (!own.length) {
        // Two different things have no passages: a document the index has not reached yet, and
        // one it indexed and could cut nothing from. The state row is what tells them apart.
        const row = await state.findOne(
          { workspaceId: owner, sourceKind, sourceKey },
          { projection: { indexedAt: 1, error: 1 } },
        );
        return { indexed: Boolean(row?.indexedAt && !row.error), passages: 0, passagesUsed: 0, total: 0, results: [] };
      }

      const twins = await chunks
        .find({ workspaceId: owner, hash: { $in: own.map((chunk) => chunk.hash) }, sourceKey: { $ne: sourceKey } })
        .project({ _id: 0, pointId: 1, hash: 1 })
        .limit(MAX_TWIN_PASSAGES)
        .toArray();
      const shared = new Set(twins.map((chunk) => chunk.hash));
      const distinctive = own.filter((chunk) => !shared.has(chunk.hash));
      // A document that is boilerplate from top to bottom still has to be looked for by something.
      const around = (distinctive.length ? distinctive : own).slice(0, MAX_NEIGHBOUR_PASSAGES);

      const groups = await store.neighbours({
        pointIds: around.map((chunk) => chunk.pointId),
        workspaceId: owner.toHexString(),
        kinds,
        excludeSourceKeys: [...new Set([sourceKey, ...excludeSourceKeys])],
        excludePointIds: twins.map((chunk) => chunk.pointId),
        limit,
        groupSize: passagesPerSource,
      });

      const ids = groups.flatMap((group) => group.hits.map((hit) => hit.id));
      const stored = ids.length
        ? await chunks
          .find({ workspaceId: owner, pointId: { $in: ids } })
          .project({ pointId: 1, text: 1, url: 1, path: 1, title: 1, headingPath: 1, sourceKind: 1, sourceKey: 1, ordinal: 1 })
          .toArray()
        : [];
      const byPoint = new Map(stored.map((row) => [row.pointId, row]));

      const results = [];
      let spent = 0;
      for (const group of groups) {
        if (spent >= MAX_RESULT_CHARACTERS) break;
        const passages = [];
        let first = null;
        for (const hit of group.hits) {
          // As in `search`: a point whose text is missing is the residue of a pass that died
          // between the two writes, and is dropped rather than returned empty.
          const row = byPoint.get(hit.id);
          if (!row || spent >= MAX_RESULT_CHARACTERS) continue;
          first ??= row;
          const text = row.text.length > MAX_PASSAGE_CHARACTERS ? `${row.text.slice(0, MAX_PASSAGE_CHARACTERS)}…` : row.text;
          spent += text.length;
          passages.push({
            ordinal: row.ordinal,
            headingPath: row.headingPath ?? [],
            text,
            score: Math.round(hit.score * 1000) / 1000,
            cite: citationFor(row),
          });
        }
        if (!passages.length) continue;
        results.push({
          sourceKind: first.sourceKind,
          sourceKey: first.sourceKey,
          url: first.url ?? null,
          path: first.path ?? null,
          title: first.title ?? null,
          // A document is as close as its closest passage; Qdrant returns each group best first.
          score: passages[0].score,
          passages,
        });
      }

      return { indexed: true, passages: own.length, passagesUsed: around.length, total: results.length, results };
    },

    /**
     * How close every pair of a set of documents is, as whole documents.
     *
     * The index holds a vector per passage and none per document, so a document's vector is made
     * here: the mean of its passages' stored vectors. Two documents are then as close as the
     * cosine of their two means, one number per pair, the same whichever of the two is asked
     * about. **No embedding call is made**: every vector read is one an indexing pass stored.
     *
     * It differs from {@link neighbours} on purpose. That answers "which passages elsewhere are
     * near this document", and scores a page by its best passage, so a long page that mentions a
     * subject once is a neighbour of the page about it. This compares documents with documents,
     * which is the question "are these two pages about the same thing".
     *
     * Passages a document shares word for word with another document of the set are left out of
     * its mean, as they are in `neighbours`: a template's closing paragraph says nothing about
     * what a page is about, and two pages that share it would look alike for that alone. A
     * document that is such passages from top to bottom is compared on all of them.
     *
     * The answer is a pure function of what the index holds for those documents: the same
     * vectors give the same scores, in the same order.
     *
     * @param {object} options
     * @param {unknown} options.workspaceId owning workspace
     * @param {string[]} options.sourceKeys the documents to compare: URL hashes, or Library paths
     * @param {string} [options.sourceKind] what kind of document they are; pages by default
     * @param {AbortSignal} [options.signal] cancellation, checked between requests
     * @returns {Promise<{model: string, documents: Array<{sourceKey: string, indexed: boolean,
     *   passages: number, passagesUsed: number}>, keys: string[], scores: Float32Array}>}
     *   `documents` has one entry per document asked about, in the order of `sourceKeys` sorted;
     *   `keys` are the ones that could be compared, sorted; `scores` is their square matrix, row
     *   by row, so the closeness of `keys[i]` and `keys[j]` is `scores[i * keys.length + j]`
     * @throws an error coded `INDEX_UNAVAILABLE` when the vector database is not answering
     */
    async closeness({ workspaceId, sourceKeys, sourceKind = LIBRARY_SOURCE_KINDS.page, signal }) {
      const owner = toObjectId(workspaceId);
      const wanted = [...new Set(sourceKeys)].sort();
      const [stored, rows] = await Promise.all([
        chunks
          .find({ workspaceId: owner, sourceKind, sourceKey: { $in: wanted } })
          .project({ _id: 0, pointId: 1, hash: 1, sourceKey: 1, ordinal: 1 })
          .sort({ sourceKey: 1, ordinal: 1 })
          .toArray(),
        state
          .find({ workspaceId: owner, sourceKind, sourceKey: { $in: wanted } })
          .project({ _id: 0, sourceKey: 1, indexedAt: 1, error: 1 })
          .toArray(),
      ]);

      const indexedKeys = new Set(rows.filter((row) => row.indexedAt && !row.error).map((row) => row.sourceKey));
      const passagesOf = new Map();
      const owners = new Map();
      for (const passage of stored) {
        const own = passagesOf.get(passage.sourceKey) ?? [];
        own.push(passage);
        passagesOf.set(passage.sourceKey, own);
        const sharing = owners.get(passage.hash) ?? new Set();
        sharing.add(passage.sourceKey);
        owners.set(passage.hash, sharing);
      }

      // Which passages each document is compared on, decided before a single vector is read.
      const documents = [];
      const used = new Map();
      for (const sourceKey of wanted) {
        const own = passagesOf.get(sourceKey) ?? [];
        const distinctive = own.filter((passage) => owners.get(passage.hash).size === 1);
        const around = (distinctive.length ? distinctive : own).slice(0, MAX_NEIGHBOUR_PASSAGES);
        used.set(sourceKey, around);
        documents.push({
          sourceKey,
          // A document with passages was indexed, whatever its state row says about a later pass.
          indexed: own.length > 0 || indexedKeys.has(sourceKey),
          passages: own.length,
          passagesUsed: around.length,
        });
      }

      // Read a few documents' vectors at a time and keep only each document's mean, so the
      // memory held is one vector per document rather than one per passage of the whole site.
      const described = new Map(documents.map((document) => [document.sourceKey, document]));
      const means = new Map();
      let batch = [];
      let batched = 0;
      const flush = async () => {
        if (!batch.length) return;
        signal?.throwIfAborted();
        const vectors = await store.vectors({
          pointIds: batch.flatMap((sourceKey) => used.get(sourceKey).map((passage) => passage.pointId)),
          workspaceId: owner.toHexString(),
        });
        for (const sourceKey of batch) {
          const mean = meanDirection(used.get(sourceKey).map((passage) => vectors.get(passage.pointId)));
          // A passage whose point is gone is the residue of a pass that died between two writes;
          // the document is compared on what is there, and not at all when nothing is.
          if (mean) means.set(sourceKey, mean);
          else described.get(sourceKey).passagesUsed = 0;
        }
        batch = [];
        batched = 0;
      };
      for (const sourceKey of wanted) {
        const count = used.get(sourceKey).length;
        if (!count) continue;
        if (batched && batched + count > CLOSENESS_BATCH_PASSAGES) await flush();
        batch.push(sourceKey);
        batched += count;
      }
      await flush();

      const keys = wanted.filter((sourceKey) => means.has(sourceKey));
      const size = keys.length;
      const scores = new Float32Array(size * size);
      for (let row = 0; row < size; row += 1) {
        scores[row * size + row] = 1;
        const left = means.get(keys[row]);
        for (let column = row + 1; column < size; column += 1) {
          const right = means.get(keys[column]);
          let dot = 0;
          for (let index = 0; index < left.length; index += 1) dot += left[index] * right[index];
          scores[row * size + column] = dot;
          scores[column * size + row] = dot;
        }
      }

      return { model: embedder.model, documents, keys, scores };
    },

    /**
     * Fails with `INDEX_UNAVAILABLE` when the vector database is not answering.
     *
     * For a caller that reads a result worked out from the index earlier and must still refuse to
     * go on while the index itself is down.
     */
    ping() {
      return store.ping();
    },

    /**
     * Turns texts into vectors and writes them **nowhere**.
     *
     * For text that is compared with the index and must never become part of it, such as what
     * another site says. The vectors are handed back to the caller, which keeps them in its own
     * collection; no point is added to the vector collection, no row to `knowledge_chunks`, none
     * to `index_state`. That is what keeps outside words out of every search this index answers.
     *
     * The requests go through the one embedding module like every other, in batches of its own
     * size, and each is in the AI call log with what the trace says it was for.
     *
     * @param {string[]} texts the texts, in the order their vectors are wanted
     * @param {object} [options]
     * @param {object} [options.trace] what the requests are for: `workspaceId`, `runId`, `siteId`,
     *   `agentSlug`
     * @param {() => Promise<unknown>} [options.heartbeat] called between requests
     * @param {AbortSignal} [options.signal] cancellation, checked between requests
     * @returns {Promise<number[][]>} one vector per text, in order
     */
    async embedTexts(texts, { trace = {}, heartbeat, signal } = {}) {
      const vectors = [];
      for (let offset = 0; offset < texts.length; offset += EMBEDDING_BATCH) {
        signal?.throwIfAborted();
        vectors.push(...await embedder.embed(texts.slice(offset, offset + EMBEDDING_BATCH), { trace }));
        await heartbeat?.();
      }
      return vectors;
    },

    /**
     * Finds the workspace's own pages nearest to a vector the caller already has: each page once,
     * with the scores of its few best passages.
     *
     * The read half of a comparison with something outside the index: a text embedded by
     * {@link embedTexts} is set against what this workspace's site says. **Nothing
     * is embedded and nothing is written.** Only crawled pages are searched — the Library's files
     * are written from those same pages, and counting both would count one statement twice.
     *
     * The workspace is a parameter here and never of the query, as in {@link search}.
     *
     * @param {object} options
     * @param {unknown} options.workspaceId owning workspace
     * @param {number[]} options.vector a vector of this index's model
     * @param {number} [options.limit] pages to return
     * @param {number} [options.passages] how many of each page's best passages to score
     * @returns {Promise<Array<{sourceKey: string, url: string|null, title: string|null,
     *   heading: string|null, score: number, scores: number[]}>>} pages in the order of their
     *   best passage; `sourceKey` is the page's URL hash, `score` its best passage's score,
     *   `heading` the section that passage sits under, and `scores` its best passages' scores,
     *   best first
     * @throws an error coded `INDEX_UNAVAILABLE` when the vector database is not answering
     */
    async nearestPages({ workspaceId, vector, limit = 20, passages = 1 }) {
      const owner = toObjectId(workspaceId);
      const documents = await store.nearestDocuments({
        vector,
        workspaceId: owner.toHexString(),
        kinds: [LIBRARY_SOURCE_KINDS.page],
        limit,
        passages,
      });
      // Rounded as a search's scores are, so a caller that compares one with a fixed line
      // compares the number a person is shown.
      const round = (score) => Math.round(score * 1000) / 1000;
      return documents.map((document) => {
        const [best] = document.hits;
        return {
          sourceKey: document.sourceKey,
          url: best.payload.url ?? null,
          title: best.payload.title ?? null,
          heading: (best.payload.headingPath ?? []).at(-1) ?? null,
          score: round(best.score),
          scores: document.hits.map((hit) => round(hit.score)),
        };
      });
    },

    /**
     * The workspace's own pages the index holds at least one passage of.
     *
     * What a comparison with the index can speak for: a page that was never embedded, or that had
     * no running text to cut a passage from, cannot be "covered" by anything, and is not listed.
     *
     * @param {object} options
     * @param {unknown} options.workspaceId owning workspace
     * @returns {Promise<Array<{sourceKey: string, url: string|null, title: string|null, passages: number}>>}
     */
    async indexedPages({ workspaceId }) {
      const rows = await state
        .find({ workspaceId: toObjectId(workspaceId), sourceKind: LIBRARY_SOURCE_KINDS.page, chunks: { $gt: 0 } })
        .project({ _id: 0, sourceKey: 1, url: 1, title: 1, chunks: 1 })
        .sort({ sourceKey: 1 })
        .toArray();
      return rows.map((row) => ({ sourceKey: row.sourceKey, url: row.url ?? null, title: row.title ?? null, passages: row.chunks }));
    },
  };

  /** Identity of one source, as both a state row and a listed source express it. */
  function keyOf(source) {
    return `${source.sourceKind}\0${source.sourceKey}`;
  }
}

/** Characters of a passage kept on the vector point, for a caller that reads only the payload. */
const SNIPPET_CHARACTERS = 320;

/** Characters of one passage a search returns. Long enough to answer from, short enough to fit. */
const MAX_PASSAGE_CHARACTERS = 1_200;

/**
 * Characters one search result set may total.
 *
 * A tool result is a message in the model's conversation, carried by every later turn of the run.
 * Eight passages of twelve hundred characters is already a long message; this stops a query that
 * matched eight long sections from costing more than the pages it was meant to save reading.
 */
const MAX_RESULT_CHARACTERS = 9_000;

/** Longest question embedded. Beyond this it is not a question, and the tail adds no meaning. */
const MAX_QUERY_CHARACTERS = 2_000;

/**
 * How many of a document's own passages a neighbour search looks around.
 *
 * The mean of sixty-four sections is already what a long page is about; past that the request
 * only grows.
 */
const MAX_NEIGHBOUR_PASSAGES = 64;

/** How many word-for-word copies of a document's passages are named to be left out of its neighbours. */
const MAX_TWIN_PASSAGES = 2_000;

/**
 * Passages whose vectors one request of a document comparison reads, give or take one document.
 *
 * The same size as a batch of the store's own, so a comparison of a site is a handful of
 * requests of a few megabytes each.
 */
const CLOSENESS_BATCH_PASSAGES = 256;

/**
 * The direction a set of vectors points in on average, as a unit vector, or null for none.
 *
 * Each vector counts once whatever its length, so a document is the plain mean of what its
 * passages are about. Summed in the order given and in double precision, which is what makes the
 * result the same every time it is worked out from the same vectors.
 *
 * @param {Array<number[]|undefined>} vectors stored vectors; a missing one is passed over
 * @returns {Float64Array|null}
 */
function meanDirection(vectors) {
  let sum = null;
  for (const vector of vectors) {
    if (!vector) continue;
    let length = 0;
    for (const value of vector) length += value * value;
    length = Math.sqrt(length);
    if (!length) continue;
    sum ??= new Float64Array(vector.length);
    for (let index = 0; index < vector.length; index += 1) sum[index] += vector[index] / length;
  }
  if (!sum) return null;
  let length = 0;
  for (const value of sum) length += value * value;
  length = Math.sqrt(length);
  if (!length) return null;
  for (let index = 0; index < sum.length; index += 1) sum[index] /= length;
  return sum;
}

/** Sources one indexing pass covers before the caller is asked to queue another. */
export const MAX_SOURCES_PER_PASS = 200;

/**
 * The string a model can paste to point at exactly this passage.
 *
 * A page gets its URL with the section's own anchor, derived the way GitHub and most static site
 * generators derive one, so the citation opens at the heading rather than at the top of a long
 * page. A Library file gets its path, which is what `library.read` takes. Neither is guessed: both
 * come from what was indexed.
 */
function citationFor(row) {
  if (row.sourceKind !== LIBRARY_SOURCE_KINDS.page || !row.url) return row.path ?? row.url ?? "";
  const heading = (row.headingPath ?? []).at(-1);
  const anchor = heading ? slugifyHeading(heading) : "";
  return anchor ? `${row.url}#${anchor}` : row.url;
}

/** Turns a heading into the anchor most renderers give it. */
function slugifyHeading(heading) {
  return String(heading)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
}
