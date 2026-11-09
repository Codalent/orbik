import { toRunSummary as toAgentRunSummary } from "../repositories/runRepository.js";

/**
 * Everything happening on the account's behalf right now, in one read.
 *
 * The sidebar's activity monitor asks this every few seconds while anything is live. It spans
 * workspaces on purpose: a crawl of one site and an agent working another are both "what is Orbik
 * doing for me", and a person looking at the second site still wants to know the first is being
 * crawled. Everything is scoped through the workspaces the account can open, owned or as a member.
 *
 * Each item names who started it, `startedBy: {userId, email}`, when a person did — a crawl
 * somebody asked for, a run somebody started — and is null for what the schedule or the work
 * upstream of it started. In a workspace several people share, "Priya started a crawl" is the
 * difference between a crawl you expected and one you did not.
 *
 * @param {object} dependencies
 * @param {object} dependencies.workspaceRepository
 * @param {object} dependencies.crawlRepository
 * @param {object} dependencies.runRepository
 * @param {object} dependencies.aiCallRepository
 * @param {object} dependencies.userRepository to name who started something
 */
export function createActivityService({ workspaceRepository, crawlRepository, runRepository, aiCallRepository, userRepository }) {
  /** The people a list of account identifiers names, by identifier, with their addresses. */
  async function peopleNamed(userIds) {
    const ids = userIds.filter(Boolean);
    if (!ids.length) return new Map();
    const users = await userRepository.listEmailsByIds(ids);
    return new Map(users.map((user) => [user._id.toHexString(), { userId: user._id.toHexString(), email: user.email }]));
  }

  return {
    /**
     * @param {object} query
     * @param {string} query.userId
     * @returns {Promise<{active: boolean, crawls: Array<object>, agents: Array<object>,
     *   aiCalls: Array<object>, library: Array<object>}>}
     */
    async describe({ userId }) {
      const workspaces = await workspaceRepository.listAccessible(userId);
      const names = new Map(workspaces.map((workspace) => [workspace._id.toHexString(), workspace.name]));
      const workspaceIds = workspaces.map((workspace) => workspace._id);

      const sites = await crawlRepository.listSitesByWorkspaces(workspaceIds);
      const [activeRuns, agentRuns, aiCalls, mirroring] = await Promise.all([
        crawlRepository.listActiveRuns(sites.map((site) => site._id)),
        runRepository.listActiveForWorkspaces(workspaceIds),
        aiCallRepository.listRunning(workspaceIds),
        runRepository.listMirroringWorkspaces(workspaceIds),
      ]);
      const runsBySite = new Map(activeRuns.map((run) => [run.siteId.toHexString(), run]));
      // A crawl that is running was started by whoever its run names; one still queued, by whoever
      // asked for it on the site.
      const crawlStarters = new Map(sites.map((site) => {
        const run = runsBySite.get(site._id.toHexString());
        return [site._id.toHexString(), run ? run.startedBy ?? null : site.crawlRequestedBy ?? null];
      }));
      const [outstanding, latestEvents, people] = await Promise.all([
        crawlRepository.countOutstandingJobsFor(activeRuns.map((run) => run._id)),
        runRepository.latestEvents(agentRuns.map((run) => run._id)),
        peopleNamed([...crawlStarters.values(), ...agentRuns.map((run) => run.startedBy)]),
      ]);
      const personOf = (userId) => (userId ? people.get(String(userId)) ?? null : null);

      const crawls = [];
      for (const site of sites) {
        const run = runsBySite.get(site._id.toHexString());
        if (!run && !site.crawlRequestedAt) continue;
        const workspaceId = site.workspaceId.toHexString();
        const remaining = run ? outstanding.get(run._id.toHexString()) ?? 0 : 0;
        const fetched = run ? (run.counters?.pagesFetched ?? 0) + (run.counters?.pagesNotModified ?? 0) : 0;
        crawls.push({
          workspaceId,
          workspaceName: names.get(workspaceId) ?? null,
          seedUrl: site.seedUrl,
          runId: run ? run._id.toHexString() : null,
          // Queued: asked for, and the scheduler has not yet started it.
          phase: run ? phaseOf(run, remaining) : "queued",
          fetched,
          outstanding: remaining,
          discovered: run?.counters?.urlsDiscovered ?? 0,
          startedAt: run?.startedAt ? run.startedAt.toISOString() : null,
          startedBy: personOf(crawlStarters.get(site._id.toHexString())),
        });
      }

      const agents = agentRuns.map((run) => {
        const summary = toAgentRunSummary(run);
        const event = latestEvents.get(run._id.toHexString()) ?? null;
        return {
          workspaceId: run.workspaceId.toHexString(),
          workspaceName: names.get(run.workspaceId.toHexString()) ?? null,
          runId: summary.id,
          agentSlug: summary.agentSlug,
          status: summary.status,
          startedAt: summary.startedAt,
          startedBy: personOf(run.startedBy),
          // The latest thing the run reported: which tool it is on, or that it has begun.
          activity: event ? { type: event.type, tool: event.tool ?? null, at: event.at ? new Date(event.at).toISOString() : null } : null,
        };
      });

      // A model call is made for a run, and was started by whoever started that run.
      const runStarters = new Map(agentRuns.map((run) => [run._id.toHexString(), run.startedBy ?? null]));
      const calls = aiCalls.map((call) => ({
        id: call.id,
        workspaceId: call.workspaceId,
        workspaceName: names.get(call.workspaceId) ?? null,
        purpose: call.purpose,
        model: call.model.requested,
        agentSlug: call.agentSlug,
        runId: call.runId,
        startedAt: call.startedAt,
        startedBy: personOf(call.runId ? runStarters.get(String(call.runId)) : null),
      }));

      // The Library agent's first stage, which is a queue job rather than a run: each page of a
      // crawled site being copied into Sources. Its last stage is a run and is among `agents`.
      const library = mirroring.map((row) => ({
        workspaceId: row.workspaceId.toHexString(),
        workspaceName: names.get(row.workspaceId.toHexString()) ?? null,
        stage: "sources",
        startedAt: row.startedAt ? row.startedAt.toISOString() : null,
        // Started by a finished crawl, never by a person.
        startedBy: null,
      }));

      return {
        active: crawls.length + agents.length + calls.length + library.length > 0,
        crawls,
        agents,
        aiCalls: calls,
        library,
      };
    },
  };
}

/** Mirrors the crawl page's own reading of a run, so the monitor and the page agree. */
function phaseOf(run, outstanding) {
  if (run.phase === "discovering") return run.phase;
  if (!run.phase && !Object.keys(run.counters ?? {}).length) return "starting";
  if (outstanding > 0) return "fetching";
  return (run.counters?.pagesFetched ?? 0) > 0 ? "finalizing" : "discovering";
}
