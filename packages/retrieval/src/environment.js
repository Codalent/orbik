import { parseUrl } from "@orbik/core";

import { DEFAULT_EMBEDDING_MODEL } from "./embeddings.js";

/**
 * Parses the retrieval index's settings: where Qdrant is, which collection holds the chunks, and
 * which model embeds them — exactly the fields `createRetrieval({ config })` reads.
 *
 * The agents worker fills the index and the API searches it on behalf of MCP clients, and the two
 * must point at one Qdrant collection and one embedding model or a query would search an index
 * nothing wrote. That agreement is this function: both processes parse these variables here, with
 * the same names, rules, defaults and messages, rather than through two copies that could drift.
 *
 * All optional. A process without an embedding key starts and simply has no index — refusing to
 * start over a credential that only the index needs would take everything else down for a feature
 * nobody had switched on. What each process does without one is its own to decide and report.
 *
 * In this package the key is for embeddings only, and `embeddings.js` is the one module here that
 * uses it. The agents worker makes its reasoning calls with the same key, through its own adapter.
 * The key is never echoed into an error.
 *
 * @param {Record<string, string | undefined>} source environment values
 * @param {string[]} errors caller-owned list that receives safe failure messages
 * @returns {{ qdrantUrl: string, qdrantCollection: string, qdrantApiKey: string,
 *   openaiApiKey: string, embeddingModel: string }} retrieval configuration
 */
export function parseRetrievalEnvironment(source, errors) {
  const qdrantUrl = parseUrl(source.QDRANT_URL, "http://127.0.0.1:6333", "QDRANT_URL", errors);
  const qdrantCollection = (source.QDRANT_COLLECTION ?? "orbik_chunks").trim();
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(qdrantCollection)) {
    errors.push("QDRANT_COLLECTION must be 1-63 characters of lowercase letters, digits, dash, or underscore.");
  }
  const qdrantApiKey = (source.QDRANT_API_KEY ?? "").trim();

  const openaiApiKey = (source.ORBIK_OPENAI_API_KEY ?? "").trim();
  if (openaiApiKey && openaiApiKey.length < 20) {
    errors.push("ORBIK_OPENAI_API_KEY must be a complete API key when it is set.");
  }
  const embeddingModel = (source.ORBIK_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL).trim();
  if (!/^[\w.:-]{1,64}$/.test(embeddingModel)) {
    errors.push("ORBIK_EMBEDDING_MODEL must be a model name of at most 64 characters.");
  }

  return { qdrantUrl, qdrantCollection, qdrantApiKey, openaiApiKey, embeddingModel };
}
