import { escapeRegExp } from "@orbik/core";
import { ObjectId } from "mongodb";

/**
 * Reads the AI call log the agents worker writes.
 *
 * Read-only from the API, on purpose. A call is recorded by the process that made it, at the
 * moment it made it; an API that could edit or insert entries would be an API that could make the
 * log say something other than what happened.
 *
 * @param {object} collections agent-owned collection handles from `getAgentCollections`
 */
export function createAiCallRepository(collections) {
  const calls = collections.aiCalls;

  return {
    /**
     * Lists calls for a set of workspaces, newest first, as summaries.
     *
     * Summaries carry everything a row shows and nothing that could be long: the prompt, the
     * system prompt, and the reply are read one call at a time. `before` pages by start time
     * rather than by offset so a page stays stable while new calls keep arriving on top.
     *
     * @param {object} query
     * @param {ObjectId[]} query.workspaceIds workspaces the caller owns
     * @param {number} query.limit page size
     * @param {Date} [query.before] only calls started strictly before this instant
     * @param {object} [query.filters] what to narrow to; see {@link toFilter}
     * @returns {Promise<Array<object>>}
     */
    async list({ workspaceIds, limit, before, filters = {} }) {
      if (workspaceIds.length === 0) return [];
      const documents = await calls
        .find(toFilter({ workspaceIds, before, ...filters }), { projection: { system: 0, prompt: 0, response: 0 } })
        .sort({ startedAt: -1, _id: -1 })
        .limit(limit)
        .toArray();
      return documents.map(toSummary);
    },

    /**
     * Totals the calls a filter matches, in one pass over them.
     *
     * Tokens are summed kind by kind rather than as one number, because "input" means three
     * different prices — uncached, written to the cache, read from it — and a total that folded
     * them together could not be checked against the spend beside it. The median is of the calls
     * that produced output, so a page of embedding requests, which produce none, does not drag it
     * to zero.
     *
     * @param {object} query
     * @param {ObjectId[]} query.workspaceIds workspaces the caller owns
     * @param {object} [query.filters] the same filters as {@link list}
     */
    async summarize({ workspaceIds, filters = {} }) {
      const empty = {
        calls: 0,
        failed: 0,
        running: 0,
        costUsd: 0,
        inputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        medianOutputTokens: null,
        byModel: [],
      };
      if (workspaceIds.length === 0) return empty;

      const [result] = await calls.aggregate([
        { $match: toFilter({ workspaceIds, ...filters }) },
        {
          $facet: {
            totals: [{
              $group: {
                _id: null,
                calls: { $sum: 1 },
                failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
                running: { $sum: { $cond: [{ $eq: ["$status", "running"] }, 1, 0] } },
                costUsd: { $sum: { $ifNull: ["$costUsd", 0] } },
                inputTokens: { $sum: { $ifNull: ["$usage.inputTokens", 0] } },
                cacheWriteTokens: { $sum: { $ifNull: ["$usage.cacheWriteTokens", 0] } },
                cacheReadTokens: { $sum: { $ifNull: ["$usage.cacheReadTokens", 0] } },
                outputTokens: { $sum: { $ifNull: ["$usage.outputTokens", 0] } },
                medianOutputTokens: {
                  $median: {
                    input: { $cond: [{ $gt: ["$usage.outputTokens", 0] }, "$usage.outputTokens", null] },
                    method: "approximate",
                  },
                },
              },
            }],
            byModel: [
              {
                $group: {
                  _id: { $ifNull: ["$model.used", "$model.requested"] },
                  calls: { $sum: 1 },
                  costUsd: { $sum: { $ifNull: ["$costUsd", 0] } },
                },
              },
              { $sort: { costUsd: -1, calls: -1, _id: 1 } },
            ],
          },
        },
      ]).toArray();

      const totals = result?.totals?.[0];
      if (!totals) return empty;
      return {
        calls: totals.calls,
        failed: totals.failed,
        running: totals.running,
        costUsd: totals.costUsd,
        inputTokens: totals.inputTokens,
        cacheWriteTokens: totals.cacheWriteTokens,
        cacheReadTokens: totals.cacheReadTokens,
        outputTokens: totals.outputTokens,
        medianOutputTokens: Number.isFinite(totals.medianOutputTokens) ? Math.round(totals.medianOutputTokens) : null,
        byModel: result.byModel.map((row) => ({ model: row._id ?? null, calls: row.calls, costUsd: row.costUsd })),
      };
    },

    /** Calls that have started and not yet finished, across workspaces, oldest first. */
    async listRunning(workspaceIds) {
      if (!workspaceIds.length) return [];
      const documents = await calls
        .find({ workspaceId: { $in: workspaceIds }, status: "running" }, { projection: { system: 0, prompt: 0, response: 0 } })
        .sort({ startedAt: 1 })
        .limit(50)
        .toArray();
      return documents.map(toSummary);
    },

    /**
     * Finds one call, only when it belongs to one of the caller's workspaces.
     *
     * @param {object} query
     * @param {string} query.callId
     * @param {ObjectId[]} query.workspaceIds
     * @returns {Promise<object | null>} the full call, prompts and reply included
     */
    async findOwned({ callId, workspaceIds }) {
      if (!ObjectId.isValid(callId) || workspaceIds.length === 0) return null;
      const document = await calls.findOne({ _id: new ObjectId(callId), workspaceId: { $in: workspaceIds } });
      return document ? toDetail(document) : null;
    },
  };
}

/**
 * Builds the query for a set of filters, always inside the caller's workspaces.
 *
 * The model filter matches the model a row shows: the one that answered, or the one asked for
 * while nothing has answered yet. The text search is a case-insensitive substring match over the
 * words of a call and its run's identifier. It is a scan of the rows the other filters leave, which
 * is what a developer's search box over a bounded period can afford; a text index would not help,
 * since it matches words rather than substrings and would miss half of an identifier.
 *
 * @param {object} filters
 * @param {ObjectId[]} filters.workspaceIds the caller's workspaces
 * @param {Date} [filters.since] only calls started at or after this instant
 * @param {Date} [filters.before] only calls started strictly before this instant
 * @param {string} [filters.purpose] stored purpose
 * @param {string} [filters.agentSlug] only this agent's calls
 * @param {string} [filters.excludeAgentSlug] every agent's calls but this one's
 * @param {string} [filters.model] the model a row shows
 * @param {string} [filters.status]
 * @param {string} [filters.q] text to look for
 */
function toFilter({ workspaceIds, since, before, purpose, agentSlug, excludeAgentSlug, model, status, q }) {
  const filter = { workspaceId: { $in: workspaceIds } };
  if (since || before) {
    filter.startedAt = {};
    if (since) filter.startedAt.$gte = since;
    if (before) filter.startedAt.$lt = before;
  }
  if (status) filter.status = status;
  if (purpose) filter.purpose = purpose;
  if (agentSlug) filter.agentSlug = agentSlug;
  else if (excludeAgentSlug) filter.agentSlug = { $ne: excludeAgentSlug };

  const all = [];
  if (model) all.push({ $or: [{ "model.used": model }, { "model.used": null, "model.requested": model }] });
  if (q) {
    const pattern = new RegExp(escapeRegExp(q), "i");
    const any = [{ prompt: pattern }, { system: pattern }, { response: pattern }];
    if (/^[0-9a-f]{1,24}$/i.test(q)) {
      any.push({ $expr: { $regexMatch: { input: { $ifNull: [{ $toString: "$runId" }, ""] }, regex: pattern } } });
    }
    all.push({ $or: any });
  }
  if (all.length) filter.$and = all;
  return filter;
}

/** The row shape: identifiers, what was asked of which model, what it used, how it went. */
function toSummary(call) {
  return {
    id: call._id.toHexString(),
    startedAt: call.startedAt ? call.startedAt.toISOString() : null,
    finishedAt: call.finishedAt ? call.finishedAt.toISOString() : null,
    durationMs: call.durationMs ?? null,
    status: call.status,
    backend: call.backend,
    purpose: call.purpose,
    model: { requested: call.model?.requested ?? null, used: call.model?.used ?? null },
    effort: call.effort ?? null,
    workspaceId: call.workspaceId ? call.workspaceId.toHexString() : null,
    runId: call.runId ? call.runId.toHexString() : null,
    agentSlug: call.agentSlug ?? null,
    agentVersion: call.agentVersion ?? null,
    turn: call.turn ?? null,
    tools: call.tools ?? [],
    inputs: call.inputs ?? null,
    toolCalls: call.toolCalls ?? [],
    usage: call.usage ?? null,
    costUsd: call.costUsd ?? null,
    pricing: call.pricing ?? null,
    turns: call.turns ?? null,
    error: call.error ? { code: call.error.code, message: call.error.message } : null,
  };
}

/** The row plus the words: system prompt, prompt, and reply. */
function toDetail(call) {
  return {
    ...toSummary(call),
    system: call.system ?? null,
    prompt: call.prompt ?? null,
    response: call.response ?? null,
  };
}
