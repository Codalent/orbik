import { createWorkspaceAccessCheck } from "./workspaceAccess.js";

/**
 * The agents whose runs are somebody's question rather than the workspace's: Ask, for a member and
 * for a read-only person. Left out, as Home leaves them out.
 */
const PRIVATE_AGENTS = new Set(["library-chat", "library-chat-read", "brand-chat", "brand-chat-read"]);

/**
 * The Agents overview: for every agent in a workspace, how its newest run went, and whether it is
 * set to work and when it runs next.
 *
 * A composition, not a new source of truth: each figure is read from where the agent's own page
 * reads it — the runs and the schedule behind the set-to-work switch — in two queries for every
 * agent at once, rather than each page's reads asked for separately.
 * What each agent is doing right now (working, idle, not set up) is not decided here: the web app
 * works that out from the crawl and the other reads its sidebar already makes, so the overview and
 * the sidebar cannot disagree. Nothing on this read writes.
 *
 * Read-only and up: everybody who can open a workspace can see what its agents did.
 *
 * @param {object} dependencies
 * @param {object} dependencies.workspaceRepository workspace access by owner or membership
 * @param {object} dependencies.agentOverviewRepository newest run per agent, and the schedules
 */
export function createAgentOverviewService({ workspaceRepository, agentOverviewRepository }) {
  const requireWorkspaceAccess = createWorkspaceAccessCheck(workspaceRepository);

  return {
    async getOverview({ userId, workspaceId }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      const id = workspace._id;
      const [latestRuns, schedules] = await Promise.all([
        agentOverviewRepository.latestRunPerAgent(id),
        agentOverviewRepository.listSchedules(id),
      ]);

      const runs = new Map(latestRuns.map((run) => [run.agentSlug, run]));
      const switches = new Map(schedules.map((row) => [row.agentSlug, row]));
      const slugs = new Set([...runs.keys(), ...switches.keys()]);

      const items = [...slugs]
        .filter((slug) => typeof slug === "string" && slug && !PRIVATE_AGENTS.has(slug))
        .sort()
        .map((slug) => {
          const run = runs.get(slug);
          const schedule = switches.get(slug);
          return {
            agentSlug: slug,
            latestRun: run
              ? { id: run.id, status: run.status, trigger: run.trigger, startedAt: iso(run.startedAt), finishedAt: iso(run.finishedAt), error: run.error }
              : null,
            // Only a switch that is on has a next run; a paused agent's old due time means nothing.
            schedule: schedule
              ? { working: Boolean(schedule.enabled), nextRunAt: schedule.enabled ? iso(schedule.nextRunAt) : null }
              : null,
          };
        });

      return { workspace: { id: id.toHexString(), role: workspace.role }, items };
    },
  };
}

/** A moment as ISO text, or null. */
function iso(value) {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}
