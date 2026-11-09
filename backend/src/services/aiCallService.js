import { AppError } from "../errors/appError.js";
import { AI_CALL_PERIODS } from "../validators/aiCallValidators.js";
import { CHAT_AGENT_SLUGS } from "./conversationService.js";

/**
 * What each source a person filters by is, in terms of what the worker stores.
 *
 * Chat is an agent run like any other — the same runtime writes it — so it is told apart by the
 * agent that ran, and "agent runs" means every agent but that one. Ask is two definitions, the
 * one that can write and the read-only one, so both slugs are matched with an operator rather
 * than a single slug; the values are fixed here and never come from a request.
 */
const SOURCES = Object.freeze({
  "agent-run": { purpose: "agent-run", agentSlug: { $nin: [...CHAT_AGENT_SLUGS] } },
  chat: { purpose: "agent-run", agentSlug: { $in: [...CHAT_AGENT_SLUGS] } },
  embedding: { purpose: "embedding" },
  "crawl-schedule": { purpose: "crawl-schedule" },
});

/**
 * The AI call log as an account sees it.
 *
 * Calls are scoped to an account through its workspaces: every call the worker records belongs
 * to a workspace — a run's, or a crawl site's — and an account sees the calls of the workspaces
 * it can open, owned or as a member, at any role. The log answers "what has the AI been doing on my behalf", and the answer spans
 * workspaces; a workspace is a filter on it, never a way out of it.
 *
 * @param {object} dependencies
 * @param {object} dependencies.workspaceRepository workspace access by owner or membership
 * @param {object} dependencies.aiCallRepository the call log
 * @param {() => Date} [dependencies.now] clock, for the period filters
 */
export function createAiCallService({ workspaceRepository, aiCallRepository, now = () => new Date() }) {
  async function accessibleWorkspaceIds(userId) {
    const workspaces = await workspaceRepository.listAccessible(userId);
    return workspaces.map((workspace) => workspace._id);
  }

  /**
   * The workspaces a query may read, narrowed to one when it names one.
   *
   * A workspace the account cannot open narrows to nothing rather than failing, so the answer to
   * "is this someone else's workspace" is the same empty page as "this workspace made no calls".
   */
  async function scopeOf(userId, workspaceId) {
    const owned = await accessibleWorkspaceIds(userId);
    return workspaceId ? owned.filter((id) => id.equals(workspaceId)) : owned;
  }

  /** Turns validated filters into the stored fields they select. */
  function toQuery({ period, source, model, status, q } = {}) {
    return {
      ...(period ? { since: new Date(now().getTime() - AI_CALL_PERIODS[period]) } : {}),
      ...(source ? SOURCES[source] : {}),
      ...(model ? { model } : {}),
      ...(status ? { status } : {}),
      ...(q ? { q } : {}),
    };
  }

  return {
    /**
     * Lists the account's calls, newest first.
     *
     * @param {object} query
     * @param {string} query.userId
     * @param {number} query.limit
     * @param {Date} [query.before]
     * @param {object} [query.filters] period, source, model, status, workspaceId, q
     * @returns {Promise<{items: Array<object>, nextBefore: string | null}>} a page, and the cursor
     *   for the next one when this page was full
     */
    async listCalls({ userId, limit, before, filters = {} }) {
      const workspaceIds = await scopeOf(userId, filters.workspaceId);
      const items = await aiCallRepository.list({ workspaceIds, limit, before, filters: toQuery(filters) });
      const last = items.at(-1);
      return { items, nextBefore: items.length === limit && last?.startedAt ? last.startedAt : null };
    },

    /**
     * Totals the calls the same filters select: counts, spend, tokens, and spend by model.
     *
     * @param {object} query
     * @param {string} query.userId
     * @param {object} [query.filters] period, source, model, status, workspaceId, q
     */
    async summarizeCalls({ userId, filters = {} }) {
      const workspaceIds = await scopeOf(userId, filters.workspaceId);
      return aiCallRepository.summarize({ workspaceIds, filters: toQuery(filters) });
    },

    /**
     * Reads one call in full.
     *
     * @param {object} query
     * @param {string} query.userId
     * @param {string} query.callId
     */
    async getCall({ userId, callId }) {
      const call = await aiCallRepository.findOwned({ callId, workspaceIds: await accessibleWorkspaceIds(userId) });
      if (!call) throw new AppError({ status: 404, code: "AI_CALL_NOT_FOUND", message: "AI call was not found." });
      return call;
    },
  };
}
