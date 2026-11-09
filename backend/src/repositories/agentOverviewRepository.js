import { toObjectId } from "@orbik/core";

/**
 * The reads behind the Agents overview that no other repository answers in one query: each
 * agent's newest run in a workspace, and every agent's on/off switch in it.
 *
 * Both read collections other repositories own (`agent_runs`, `agent_schedules`) and write
 * nothing. They are here, rather than as new methods there, because the overview is the only page
 * that wants every agent at once.
 *
 * @param {object} collections agent collections from `@orbik/core`
 */
export function createAgentOverviewRepository(collections) {
  const { runs, schedules } = collections;

  return {
    /**
     * Each agent's newest run in the workspace, one row per agent that has ever run there.
     *
     * Crawls are left out: they are recorded with `agent: "crawler"` and no `agentSlug`, and the
     * crawl overview already says how the newest one went.
     */
    async latestRunPerAgent(workspaceId) {
      const rows = await runs.aggregate([
        { $match: { workspaceId: toObjectId(workspaceId), agentSlug: { $type: "string" } } },
        { $sort: { startedAt: -1 } },
        {
          $group: {
            _id: "$agentSlug",
            runId: { $first: "$_id" },
            status: { $first: "$status" },
            trigger: { $first: "$trigger" },
            startedAt: { $first: "$startedAt" },
            finishedAt: { $first: "$finishedAt" },
            error: { $first: "$error" },
          },
        },
      ]).toArray();
      return rows.map((row) => ({
        agentSlug: row._id,
        id: row.runId.toHexString(),
        status: row.status,
        trigger: row.trigger ?? null,
        startedAt: row.startedAt ?? null,
        finishedAt: row.finishedAt ?? null,
        error: row.error ? { code: row.error.code, message: row.error.message } : null,
      }));
    },

    /** Every agent's switch in the workspace: whether it is set to work, and when it runs next. */
    listSchedules(workspaceId) {
      return schedules
        .find({ workspaceId: toObjectId(workspaceId) }, { projection: { agentSlug: 1, enabled: 1, nextRunAt: 1 } })
        .toArray();
    },
  };
}
