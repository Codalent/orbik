/**
 * Public surface of `@orbik/retrieval`.
 *
 * One package rather than code inside the agents worker, because two very different callers need
 * the same index: the worker, which fills it, and the tool registry, which queries it on behalf of
 * whatever agent is running. Keeping the vector database and the embedding provider behind this
 * boundary is also what makes the exception documented in `embeddings.js` containable — there is
 * exactly one module in the system that can reach a non-Claude model, and it is this one.
 *
 * Nothing here knows about runs or agent definitions. It is given a database, a store
 * and an embedder, and it answers four questions: bring this workspace's index up to date, find
 * the passages that answer this question (`search`), find the documents closest to this one
 * (`neighbours`), and say how close every pair of a set of documents is (`closeness`) — the last
 * two from vectors already stored, with no embedding call. A fifth — what the index holds right
 * now — is answered from MongoDB alone by `createIndexStatusReader`, which needs neither the
 * store nor the embedder.
 */
export { MAX_SOURCES_PER_PASS } from "./retrievalIndex.js";
export { splitFrontMatter } from "./chunks.js";
export { createIndexEraser, createRetrieval } from "./createRetrieval.js";
export { createIndexStatusReader } from "./indexStatus.js";
export { parseRetrievalEnvironment } from "./environment.js";
