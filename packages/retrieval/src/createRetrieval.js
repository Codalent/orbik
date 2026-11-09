import { log } from "@orbik/core";
import { QdrantClient } from "@qdrant/js-client-rest";

import { EMBEDDING_DIMENSIONS, createOpenAiEmbedder } from "./embeddings.js";
import { createRetrievalIndex } from "./retrievalIndex.js";
import { createVectorStore } from "./vectorStore.js";

/**
 * Assembles the retrieval index from configuration, or reports why it cannot be.
 *
 * A process with no embedding key configured is a normal deployment, not a broken one: the crawler,
 * the Library agents and the Design system agent all work without it, and only search and chat do
 * not. So this returns `null` and says why, rather than throwing at startup — a process that
 * refused to boot over an optional credential would take the whole fleet down for a feature nobody
 * had asked it to run.
 *
 * The reason is kept because it is the sentence a person reads. "The index is offline" and "no
 * embedding key is configured" call for two entirely different actions, and a status line that
 * could only say "unavailable" would send somebody to restart the wrong thing. It names the
 * variable rather than the process, because two processes now build one of these — the agents
 * worker, which fills the index, and the API, which searches it for MCP clients — and a message
 * that said "the worker" would send a person to the wrong `.env`.
 *
 * @param {object} options
 * @param {import("mongodb").Db} options.database connected database
 * @param {object} options.config validated environment of the process building this
 * @param {(level: string, message: string, context?: object) => void} [options.logger]
 * @param {object} [options.callLog] the AI call log every embedding request is reported to
 * @returns {{index: object|null, reason: {code: string, message: string}|null}}
 */
export function createRetrieval({ database, config, logger = log, callLog = null }) {
  if (!config.openaiApiKey) {
    return {
      index: null,
      reason: {
        code: "EMBEDDING_NOT_CONFIGURED",
        message:
          "No embedding key is configured, so nothing can be indexed or searched. " +
          "Set ORBIK_OPENAI_API_KEY in this process's environment.",
      },
    };
  }

  const dimensions = EMBEDDING_DIMENSIONS[config.embeddingModel];
  if (!dimensions) {
    return {
      index: null,
      reason: {
        code: "EMBEDDING_MODEL_UNKNOWN",
        message: `ORBIK_EMBEDDING_MODEL is ${config.embeddingModel}, which this deployment does not know the shape of.`,
      },
    };
  }

  const embedder = createOpenAiEmbedder({ apiKey: config.openaiApiKey, model: config.embeddingModel, callLog });
  const store = createVectorStore({
    url: config.qdrantUrl,
    collection: config.qdrantCollection,
    dimensions,
    apiKey: config.qdrantApiKey,
  });

  return { index: createRetrievalIndex({ database, store, embedder, logger }), reason: null };
}

/**
 * Removes a workspace's points from the vector database, for the API's workspace deletion.
 *
 * Apart from {@link createRetrieval} because it needs no embedding key: a workspace indexed while
 * a key was set must still be removable after the key is taken away, and removing points embeds
 * nothing. It reads the same `QDRANT_URL` and `QDRANT_COLLECTION` as the indexer, so it removes
 * from the collection that was written. The client gives up after `timeoutMs` rather than the
 * client's default five minutes, so a Qdrant that hangs holds a person's request for seconds and
 * the caller records what it could not remove instead.
 *
 * @param {object} options
 * @param {object} options.config validated environment: `qdrantUrl`, `qdrantCollection`,
 *   `qdrantApiKey`, `embeddingModel`
 * @param {number} [options.timeoutMs]
 * @returns {{eraseWorkspace: (workspaceId: string) => Promise<{deleted: boolean, existed: boolean}>}}
 *   whose promise rejects with `INDEX_UNAVAILABLE` when Qdrant is not answering and `INDEX_FAILED`
 *   when it refuses
 */
export function createIndexEraser({ config, timeoutMs = 10_000 }) {
  const client = new QdrantClient({
    url: config.qdrantUrl,
    ...(config.qdrantApiKey ? { apiKey: config.qdrantApiKey } : {}),
    timeout: timeoutMs,
    checkCompatibility: false,
  });
  const store = createVectorStore({
    url: config.qdrantUrl,
    collection: config.qdrantCollection,
    dimensions: EMBEDDING_DIMENSIONS[config.embeddingModel] ?? null,
    client,
  });
  return {
    eraseWorkspace: (workspaceId) => store.deleteWorkspace({ workspaceId: String(workspaceId) }),
  };
}
