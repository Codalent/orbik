import { toObjectId } from "@orbik/core";

/** How long a call is kept. The TTL index on `mcp_calls` (`db/indexes.js`) sweeps older rows. */
export const MCP_CALL_RETENTION_DAYS = 90;

/** The longest query kept, which is also the longest `content.search` accepts. */
const QUERY_MAX = 500;

/**
 * The record of what a person's own AI did over MCP: one row per tool call, in the workspace the
 * call read.
 *
 * Kept because nothing else says it. The process log has failures and writes, but not which
 * tools are used at all, through which clients, or — the part worth most — what the AI went
 * looking for and whether the knowledge base had it. A `content_search` or `search` call is kept
 * with its query, how many passages came back and the best passage's score, which is what the
 * "What your AI asked" report on the settings page ranks: the questions answered least well are
 * the Library's to-do list and the site's content gaps.
 *
 * What a row holds: when, which tool, how it went (`ok` or the code the client was answered
 * with), how long it took, the person, the credential's kind and id, and the client's name as the
 * credential records it (the token's name, or the app's). Never the answer, never a secret, never
 * a Library write's text.
 *
 * A call that never reached a workspace — `workspace_list`, or a roaming call refused with
 * `WORKSPACE_REQUIRED` — is not kept: it belongs to no workspace's report and no workspace's
 * deletion would remove it. A `search` that fanned out across several workspaces is kept as one
 * row per workspace it searched, marked `fanOut`, so each workspace's counts include it; it is left
 * out of the question list, where a question about one company would otherwise read as a gap in
 * all the others.
 *
 * Recording never fails a call and never delays one: the caller does not wait for it, and a failed
 * write is logged and dropped.
 *
 * @param {object} options
 * @param {import("mongodb").Collection} options.collection `mcp_calls`
 * @param {(level: string, message: string, context?: object) => void} options.logger
 */
export function createMcpCallLog({ collection, logger }) {
  return {
    /**
     * Records one tool call.
     *
     * @param {object} session the request's session
     * @param {object} call
     * @param {string} call.tool the tool's advertised name
     * @param {string | null} call.workspaceId the workspace it read, when it got that far
     * @param {string} call.outcome `ok`, or the code the client was answered with
     * @param {number} call.durationMs
     * @param {Array<object>} [call.searches] one `searchRecord` per workspace the call searched
     */
    async record(session, { tool, workspaceId, outcome, durationMs, searches = [] }) {
      const base = {
        at: new Date(),
        tool,
        outcome,
        durationMs,
        userId: session.userId ?? null,
        kind: session.kind ?? null,
        tokenId: session.tokenId ?? null,
        client: session.client || null,
      };
      const rows = searches.length
        ? searches.map(({ workspaceId: searched, ...search }) => ({ ...base, workspaceId: toObjectId(searched), ...search }))
        : workspaceId
          ? [{ ...base, workspaceId: toObjectId(workspaceId) }]
          : [];
      if (!rows.length) return;
      try {
        await collection.insertMany(rows, { ordered: false });
      } catch (error) {
        logger("warn", "mcp.call_log_failed", { tool, message: error?.message ?? "unknown" });
      }
    },

    /**
     * What a workspace's AI clients did since a moment: totals, each tool, each client, and the
     * questions its knowledge base answered least well — every query that came back with nothing
     * first, then the rest by their best passage's score, lowest first.
     *
     * @param {string} workspaceId
     * @param {object} options
     * @param {Date} options.since
     * @param {number} options.questionLimit how many questions to return
     */
    async summarise(workspaceId, { since, questionLimit }) {
      const failed = { $sum: { $cond: [{ $eq: ["$outcome", "ok"] }, 0, 1] } };
      // A question is a search that was answered: a refused one (the index down, say) says nothing
      // about what the knowledge base holds. A fanned-out search is counted, but not listed.
      const answered = { $match: { queryKey: { $type: "string" }, outcome: "ok", fanOut: { $ne: true } } };
      const [facets] = await collection
        .aggregate([
          { $match: { workspaceId: toObjectId(workspaceId), at: { $gte: since } } },
          {
            $facet: {
              totals: [{ $group: { _id: null, calls: { $sum: 1 }, failed, lastAt: { $max: "$at" } } }],
              tools: [
                { $group: { _id: "$tool", calls: { $sum: 1 }, failed, lastAt: { $max: "$at" } } },
                { $sort: { calls: -1, _id: 1 } },
              ],
              clients: [
                { $group: { _id: { client: "$client", kind: "$kind" }, calls: { $sum: 1 }, lastAt: { $max: "$at" } } },
                { $sort: { calls: -1, lastAt: -1 } },
                { $limit: 20 },
              ],
              searches: [
                answered,
                { $group: { _id: null, asked: { $sum: 1 }, empty: { $sum: { $cond: [{ $eq: ["$hits", 0] }, 1, 0] } } } },
              ],
              questions: [
                answered,
                { $sort: { at: -1 } },
                {
                  $group: {
                    _id: "$queryKey",
                    query: { $first: "$query" },
                    times: { $sum: 1 },
                    lastAskedAt: { $first: "$at" },
                    hits: { $max: "$hits" },
                    topScore: { $max: "$topScore" },
                    clients: { $addToSet: "$client" },
                  },
                },
                { $addFields: { empty: { $eq: ["$hits", 0] } } },
                { $sort: { empty: -1, topScore: 1, times: -1, lastAskedAt: -1 } },
                { $limit: questionLimit },
              ],
            },
          },
        ])
        .toArray();

      const totals = facets?.totals?.[0];
      const searches = facets?.searches?.[0];
      return {
        calls: totals?.calls ?? 0,
        failed: totals?.failed ?? 0,
        lastCallAt: totals?.lastAt ?? null,
        questionsAsked: searches?.asked ?? 0,
        questionsEmpty: searches?.empty ?? 0,
        tools: (facets?.tools ?? []).map((row) => ({ tool: row._id, calls: row.calls, failed: row.failed, lastAt: row.lastAt })),
        clients: (facets?.clients ?? []).map((row) => ({
          client: row._id?.client ?? null,
          kind: row._id?.kind ?? null,
          calls: row.calls,
          lastAt: row.lastAt,
        })),
        questions: (facets?.questions ?? []).map((row) => ({
          query: row.query,
          times: row.times,
          lastAskedAt: row.lastAskedAt,
          hits: row.hits ?? 0,
          topScore: typeof row.topScore === "number" ? row.topScore : null,
          clients: (row.clients ?? []).filter(Boolean).sort(),
        })),
      };
    },
  };
}

/**
 * What one search of one workspace returned, as the call log keeps it: the query, how many
 * passages, and the best one's score (null when there were none).
 *
 * @param {string} workspaceId the workspace searched
 * @param {unknown} query the query as the client sent it
 * @param {{total?: number, results?: Array<{score?: number}>}} answer what `content.search` returned
 * @param {boolean} [fanOut] whether the call searched several workspaces at once
 */
export function searchRecord(workspaceId, query, answer, fanOut = false) {
  const text = String(query ?? "").slice(0, QUERY_MAX);
  const scores = (answer?.results ?? []).map((result) => result?.score).filter((score) => typeof score === "number");
  return {
    workspaceId,
    query: text,
    queryKey: queryKey(text),
    hits: answer?.total ?? answer?.results?.length ?? 0,
    topScore: scores.length ? Math.max(...scores) : null,
    ...(fanOut ? { fanOut: true } : {}),
  };
}

/** A query as the report groups it: case, spacing and Unicode forms do not make two questions. */
function queryKey(query) {
  return query.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
