import { QdrantClient } from "@qdrant/js-client-rest";
import { createHash } from "node:crypto";

/**
 * The vector side of the retrieval index: one Qdrant collection, shared by every workspace.
 *
 * **One collection, filtered by workspace.** Every point carries `workspaceId` in its payload and
 * every query filters on it, with the value taken from the run's scope and never from an argument.
 * A collection per workspace would make that boundary a matter of naming — one wrong string and a
 * question about one company is answered from another's site — where a filter that is applied in
 * one place, here, is a boundary the callers cannot forget. Qdrant indexes the field, so the
 * filter costs a lookup rather than a scan. The trade is revisited if a workspace ever holds a few
 * hundred thousand chunks, which is a much larger site than Orbik crawls today.
 *
 * **Identity is derived, not generated.** A point's id is a UUID computed from
 * `(workspaceId, sourceKind, sourceKey, ordinal)`, so re-indexing a page overwrites the points it
 * wrote last time instead of accumulating a second copy of every passage beside the first. It also
 * means the indexer needs no record of what it has written in order to replace it.
 *
 * **Being unreachable is an ordinary outcome.** Qdrant is a separate process; it can be down
 * during a deploy or simply not started on a development machine. Every method here turns that
 * into `INDEX_UNAVAILABLE` rather than an unhandled rejection, because the callers — a scheduled
 * job and a tool a model is holding — both have something sensible to do with it, and neither has
 * anything sensible to do with a fetch error.
 */

/** A failure of the vector database, in the terms the indexer and the search tool act on. */
class VectorStoreError extends Error {
  /**
   * @param {object} options failure detail
   * @param {string} options.code stable upper-case code
   * @param {string} options.message safe description
   * @param {boolean} [options.retryable] whether the next tick should try again
   */
  constructor({ code, message, retryable = false }) {
    super(message);
    this.name = "VectorStoreError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** Payload fields Qdrant keeps an index on, so a filter on them is a lookup rather than a scan. */
const INDEXED_PAYLOAD_FIELDS = Object.freeze({
  workspaceId: "keyword",
  sourceKind: "keyword",
  sourceKey: "keyword",
  path: "keyword",
  model: "keyword",
});

/**
 * Points read in one request when their vectors are wanted.
 *
 * A vector is about eighteen kilobytes as JSON, so this is a response of a few megabytes: large
 * enough that a site is a handful of requests, small enough that none of them is a download.
 */
const VECTOR_BATCH = 256;

/**
 * Creates the vector store over one Qdrant collection.
 *
 * @param {object} options
 * @param {string} options.url where Qdrant listens, e.g. `http://127.0.0.1:6333`
 * @param {string} options.collection the collection name for this environment
 * @param {number} options.dimensions the embedding width, which fixes the collection's shape
 * @param {string} [options.apiKey] Qdrant's own key, when it is run with one
 * @param {object} [options.client] injectable client, for a caller that has one already
 */
export function createVectorStore({ url, collection, dimensions, apiKey = null, client = null }) {
  const qdrant = client ?? new QdrantClient({
    url,
    ...(apiKey ? { apiKey } : {}),
    // The client otherwise asks the server for its version on the first call and logs a warning
    // when the two differ by a minor release. It is noise in a worker's log, and a mismatch this
    // code would actually break on would fail the call it was made in anyway.
    checkCompatibility: false,
  });

  /** Runs one Qdrant call, turning every way it can fail into a code a caller can act on. */
  async function attempt(what, work) {
    try {
      return await work();
    } catch (error) {
      throw toStoreError(error, what, url);
    }
  }

  return {
    collection,
    dimensions,

    /**
     * Creates the collection and its payload indexes when they are missing.
     *
     * Idempotent, and called before indexing rather than only at startup: a worker that started
     * while Qdrant was down must be able to recover without being restarted, and a collection
     * somebody dropped must come back rather than turning every later write into a 404.
     */
    async ensureCollection() {
      const existence = await attempt("check the collection", () => qdrant.collectionExists(collection));
      if (!existence?.exists) {
        try {
          await qdrant.createCollection(collection, {
            // Cosine because the embeddings are normalised for it and because it is what makes a
            // score comparable between a long passage and a short one.
            vectors: { size: dimensions, distance: "Cosine" },
          });
        } catch (error) {
          // Two workers indexing two workspaces at the same moment both find the collection
          // missing and both create it; the loser is told Conflict. That is the collection
          // existing, which is what was asked for — so it is only a failure if it still does not.
          const now = await attempt("check the collection", () => qdrant.collectionExists(collection));
          if (!now?.exists) throw toStoreError(error, "create the collection", url);
        }
      }
      for (const [field, schema] of Object.entries(INDEXED_PAYLOAD_FIELDS)) {
        // Creating an index that exists is accepted by Qdrant, so this needs no existence check
        // and stays correct when a field is added to the list later.
        await attempt(`index ${field}`, () =>
          qdrant.createPayloadIndex(collection, { field_name: field, field_schema: schema, wait: true }));
      }
      return { collection, dimensions };
    },

    /**
     * Writes points, replacing any that share an id.
     *
     * @param {Array<{id: string, vector: number[], payload: object}>} points
     */
    async upsert(points) {
      if (!points.length) return { written: 0 };
      await attempt("write points", () => qdrant.upsert(collection, { wait: true, points }));
      return { written: points.length };
    },

    /** Removes points by id. */
    async deletePoints(ids) {
      if (!ids.length) return { deleted: 0 };
      await attempt("delete points", () => qdrant.delete(collection, { wait: true, points: ids }));
      return { deleted: ids.length };
    },

    /**
     * Removes every point of one source, however many chunks it had.
     *
     * By filter rather than by id because the caller deleting a page does not know how many
     * passages it was cut into last time — and computing the ids from a count it no longer has
     * would leave the tail of a shortened document in the index forever.
     */
    async deleteSource({ workspaceId, sourceKind, sourceKey }) {
      await attempt("delete a source", () =>
        qdrant.delete(collection, {
          wait: true,
          filter: {
            must: [
              { key: "workspaceId", match: { value: workspaceId } },
              { key: "sourceKind", match: { value: sourceKind } },
              { key: "sourceKey", match: { value: sourceKey } },
            ],
          },
        }));
      return { deleted: true };
    },

    /**
     * Removes every point of one workspace: what deleting the workspace asks of the index.
     *
     * By filter, like {@link deleteSource}, so it needs no list of what was written. A collection
     * that does not exist holds nothing of anybody's, so it counts as done rather than as a
     * failure; any other refusal, and being unreachable, are thrown as the codes above.
     */
    async deleteWorkspace({ workspaceId }) {
      const existence = await attempt("check the collection", () => qdrant.collectionExists(collection));
      if (!existence?.exists) return { deleted: true, existed: false };
      await attempt("delete a workspace", () =>
        qdrant.delete(collection, {
          wait: true,
          filter: { must: [{ key: "workspaceId", match: { value: workspaceId } }] },
        }));
      return { deleted: true, existed: true };
    },

    /**
     * Finds the passages closest to one vector, inside one workspace.
     *
     * `workspaceId` is required rather than optional. An unfiltered query is not a useful default
     * that somebody forgot to narrow; it is a cross-tenant read, and the only safe place to make
     * it impossible is the function that builds the filter.
     *
     * @param {object} options
     * @param {number[]} options.vector the query embedding
     * @param {string} options.workspaceId hexadecimal workspace identifier
     * @param {string[]} [options.kinds] restrict to these source kinds
     * @param {string} [options.pathPrefix] restrict Library results to one branch
     * @param {number} [options.limit] how many passages to return
     */
    async search({ vector, workspaceId, kinds = [], pathPrefix = null, limit = 8 }) {
      const must = [{ key: "workspaceId", match: { value: workspaceId } }];
      if (kinds.length) must.push({ key: "sourceKind", match: { any: [...kinds] } });
      // A path prefix is expressed as a text match on the stored path rather than as a range,
      // because Qdrant's keyword index matches whole values: the candidates it returns are then
      // narrowed exactly by the caller, which holds the same paths in MongoDB.
      const filter = { must };

      const response = await attempt("search", () =>
        qdrant.query(collection, {
          query: vector,
          filter,
          limit,
          with_payload: true,
        }));
      const points = response?.points ?? [];
      return points
        .filter((point) => !pathPrefix || isWithin(point.payload?.path, pathPrefix))
        .map((point) => ({ id: String(point.id), score: point.score ?? 0, payload: point.payload ?? {} }));
    },

    /**
     * Finds the passages closest to a set of stored points, grouped by the document they are in.
     *
     * The question is "what is near this document", and it is answered from vectors the index
     * already holds: Qdrant averages the named points' own vectors and searches with that, so no
     * text is embedded and no provider is called. The points named are never returned.
     *
     * `workspaceId` is required for the reason it is in {@link search}. The ids are the caller's
     * to get right: they must be points of that workspace, which the index reads from MongoDB by
     * workspace before it comes here.
     *
     * @param {object} options
     * @param {string[]} options.pointIds the stored points to look around; at least one
     * @param {string} options.workspaceId hexadecimal workspace identifier
     * @param {string[]} [options.kinds] restrict to these source kinds
     * @param {string[]} [options.excludeSourceKeys] documents whose passages must not come back
     * @param {string[]} [options.excludePointIds] single passages that must not come back
     * @param {number} [options.limit] how many documents to return
     * @param {number} [options.groupSize] how many passages of each document
     * @returns {Promise<Array<{sourceKey: string, hits: Array<{id: string, score: number, payload: object}>}>>}
     */
    async neighbours({ pointIds, workspaceId, kinds = [], excludeSourceKeys = [], excludePointIds = [], limit = 8, groupSize = 2 }) {
      if (!pointIds.length) return [];
      const must = [{ key: "workspaceId", match: { value: workspaceId } }];
      if (kinds.length) must.push({ key: "sourceKind", match: { any: [...kinds] } });
      const mustNot = [];
      if (excludeSourceKeys.length) mustNot.push({ key: "sourceKey", match: { any: [...excludeSourceKeys] } });
      if (excludePointIds.length) mustNot.push({ has_id: [...excludePointIds] });

      const response = await attempt("find neighbours", () =>
        qdrant.queryGroups(collection, {
          // The mean of the points' vectors: what the document is about as a whole. Scoring each
          // candidate against its best-matching point instead rewards a passage for resembling
          // any one section, and a template's closing paragraph resembles every other page's.
          query: { recommend: { positive: [...pointIds], strategy: "average_vector" } },
          filter: { must, ...(mustNot.length ? { must_not: mustNot } : {}) },
          group_by: "sourceKey",
          group_size: groupSize,
          limit,
          with_payload: true,
        }));
      return (response?.groups ?? []).map((group) => ({
        sourceKey: String(group.id),
        hits: (group.hits ?? []).map((point) => ({ id: String(point.id), score: point.score ?? 0, payload: point.payload ?? {} })),
      }));
    },

    /**
     * Finds the documents closest to one vector, inside one workspace: each document once, with
     * its few best passages.
     *
     * {@link search} answers "which passages", and returns a document as often as it has passages
     * near the vector. This answers "which documents, and how near is each", which is what a
     * comparison of a subject with a whole site needs: one row per page, so a long page does not
     * fill the answer with itself. A document's several best passages come back rather than its
     * one best, because one near passage is a mention and several are a page on the subject, and
     * the caller has to be able to tell which it found.
     *
     * The search is exact rather than approximate. The caller turns scores into verdicts against
     * fixed lines, and a verdict has to be the same every time the same index is asked.
     *
     * `workspaceId` is required for the reason it is in {@link search}. Nothing is written: the
     * vector is the caller's and is not kept.
     *
     * @param {object} options
     * @param {number[]} options.vector the vector to look around
     * @param {string} options.workspaceId hexadecimal workspace identifier
     * @param {string[]} [options.kinds] restrict to these source kinds
     * @param {number} [options.limit] how many documents to return
     * @param {number} [options.passages] how many passages of each document
     * @returns {Promise<Array<{sourceKey: string, hits: Array<{score: number, payload: object}>}>>}
     *   documents in the order of their best passage, each with its passages best first
     */
    async nearestDocuments({ vector, workspaceId, kinds = [], limit = 20, passages = 1 }) {
      const must = [{ key: "workspaceId", match: { value: workspaceId } }];
      if (kinds.length) must.push({ key: "sourceKind", match: { any: [...kinds] } });

      const response = await attempt("search", () =>
        qdrant.queryGroups(collection, {
          query: vector,
          filter: { must },
          params: { exact: true },
          group_by: "sourceKey",
          group_size: passages,
          limit,
          with_payload: true,
        }));
      return (response?.groups ?? [])
        .map((group) => ({
          sourceKey: String(group.id),
          hits: (group.hits ?? []).map((point) => ({ score: point.score ?? 0, payload: point.payload ?? {} })),
        }))
        .filter((group) => group.hits.length);
    },

    /**
     * Reads the stored vectors of named points, inside one workspace.
     *
     * For a comparison the vector database cannot make itself: how close two whole documents are
     * is the angle between the means of their passages, and those means have to be worked out
     * somewhere. Nothing is embedded; these are the vectors an indexing pass already paid for.
     *
     * `workspaceId` is required for the reason it is in {@link search}, and it is part of the
     * filter rather than a promise about the ids: a point of another workspace is not returned
     * even when it is named.
     *
     * @param {object} options
     * @param {string[]} options.pointIds the stored points to read
     * @param {string} options.workspaceId hexadecimal workspace identifier
     * @returns {Promise<Map<string, number[]>>} point id to vector; a point that is gone is absent
     */
    async vectors({ pointIds, workspaceId }) {
      const found = new Map();
      for (let offset = 0; offset < pointIds.length; offset += VECTOR_BATCH) {
        const ids = pointIds.slice(offset, offset + VECTOR_BATCH);
        const response = await attempt("read vectors", () =>
          qdrant.scroll(collection, {
            filter: { must: [{ key: "workspaceId", match: { value: workspaceId } }, { has_id: ids }] },
            limit: ids.length,
            with_vector: true,
            with_payload: false,
          }));
        for (const point of response?.points ?? []) {
          if (Array.isArray(point.vector)) found.set(String(point.id), point.vector);
        }
      }
      return found;
    },

    /**
     * Asks Qdrant whether it is there, and fails in the store's own terms when it is not.
     *
     * {@link isReachable} answers the same question with a boolean, for a status line. This one
     * is for a caller that must stop: it throws `INDEX_UNAVAILABLE` with the sentence a person
     * can act on.
     */
    async ping() {
      await attempt("be read", () => qdrant.collectionExists(collection));
    },

    /** How many points one workspace holds, which is what the index status line reports. */
    async count({ workspaceId }) {
      const response = await attempt("count points", () =>
        qdrant.count(collection, {
          exact: true,
          filter: { must: [{ key: "workspaceId", match: { value: workspaceId } }] },
        }));
      return response?.count ?? 0;
    },

    /** Whether Qdrant is answering at all, for a status line that has to say "offline" honestly. */
    async isReachable() {
      try {
        await qdrant.collectionExists(collection);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * The id of one chunk's point.
 *
 * Qdrant accepts an unsigned integer or a UUID and nothing else, so the natural key — a workspace,
 * a source and an ordinal — is hashed into UUID shape. Version and variant bits are set so it is a
 * well-formed version-5-style name-based UUID rather than a hex string that happens to have dashes
 * in it: Qdrant validates the form, and a value that parsed today and not tomorrow would orphan
 * every point already written.
 *
 * @param {object} key the chunk's natural identity
 * @returns {string} a UUID
 */
export function pointIdOf({ workspaceId, sourceKind, sourceKey, ordinal }) {
  const digest = createHash("sha256")
    .update(`${workspaceId}\u0000${sourceKind}\u0000${sourceKey}\u0000${ordinal}`)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Whether a stored Library path sits at or under a prefix. */
function isWithin(path, prefix) {
  if (typeof path !== "string") return false;
  if (prefix === "/") return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Turns whatever the client threw into a coded failure.
 *
 * The distinction that matters is unreachable versus refused. A Qdrant that is not running is a
 * configuration or an ops problem the person reading the message can fix, and every caller reports
 * it in those words; a request Qdrant understood and rejected is a bug in this file, and saying so
 * differently is what stops the second being mistaken for the first for an afternoon.
 */
function toStoreError(error, what, url) {
  const name = error?.name ?? "";
  const message = String(error?.message ?? "");
  const unreachable =
    name === "TypeError" ||
    name === "QdrantClientTimeoutError" ||
    /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(message);

  if (unreachable) {
    return new VectorStoreError({
      code: "INDEX_UNAVAILABLE",
      message: `The search index at ${url} is not answering, so it could not ${what}. Start Qdrant and try again.`,
      retryable: true,
    });
  }
  return new VectorStoreError({
    code: "INDEX_FAILED",
    message: `The search index refused to ${what}: ${message.slice(0, 300)}`,
    retryable: name === "QdrantClientResourceExhaustedError",
  });
}
