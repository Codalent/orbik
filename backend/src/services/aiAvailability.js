import { COLLECTIONS } from "@orbik/core";

/** The `system_state` document the agents worker records its AI settings' outcome in. */
const AI_AVAILABILITY_ID = "ai";
const CACHE_MS = 15_000;

/**
 * What `GET /v1/edition` says about AI: `{reasoning, search}`, each a boolean, or a field left out
 * when this process cannot know it.
 *
 * - `reasoning`: whether the reasoning provider agent runs, the Ask chat and plain-code agents'
 *   short texts go to has its key. Those calls are made by the agents worker with its own settings
 *   (`agents/.env`), which the API does not read, so this is what the worker recorded at its start
 *   in `system_state` (`_id: "ai"`). Before any worker has recorded it, it is left out.
 * - `search`: whether the embedding key is set where it is needed: in the worker, which builds the
 *   index and searches it for the chat, and in this process, which searches it for the Library page
 *   and MCP clients. Without the worker's record, this process's own answer.
 *
 * Read at most every 15 seconds: the route is public and asked on every page load. A failed read
 * answers what was read last, or null, so the edition never fails for it.
 *
 * @param {object} options
 * @param {import("mongodb").Db} options.database
 * @param {boolean} options.searchConfigured whether this process has the embedding key
 * @param {() => number} [options.now]
 * @returns {() => Promise<{reasoning?: boolean, search: boolean}|null>}
 */
export function createAiAvailabilityReader({ database, searchConfigured, now = Date.now }) {
  const state = database.collection(COLLECTIONS.systemState);
  let cached = null;
  let cachedAt = 0;

  return async function aiAvailability() {
    if (cached && now() - cachedAt < CACHE_MS) return cached;
    let recorded;
    try {
      recorded = await state.findOne(
        { _id: AI_AVAILABILITY_ID },
        { projection: { reasoning: 1, embeddings: 1 } },
      );
    } catch {
      return cached;
    }
    const answer = { search: Boolean(searchConfigured) && recorded?.embeddings !== false };
    if (typeof recorded?.reasoning === "boolean") answer.reasoning = recorded.reasoning;
    cached = answer;
    cachedAt = now();
    return answer;
  };
}
