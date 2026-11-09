import { isOnRequestAgent, scheduleProfileFor } from "@orbik/core";

import { AppError } from "../errors/appError.js";
import { findAgent, toAgentSummary } from "./agentCatalog.js";
import { createWorkspaceAccessCheck } from "./workspaceAccess.js";

/**
 * Converts a stored setup to its public shape.
 *
 * @param {object|null} setup the stored document
 */
function toSetupSummary(setup) {
  if (!setup) return null;
  return {
    agentSlug: setup.agentSlug,
    pages: (setup.pages ?? []).map((page) => ({
      key: page.key,
      url: page.url,
      label: page.label,
      pattern: page.pattern ?? null,
      addedAt: page.addedAt ? page.addedAt.toISOString() : null,
    })),
    working: Boolean(setup.working),
    lastRunAt: setup.lastRunAt ? setup.lastRunAt.toISOString() : null,
    nextRunAt: setup.nextRunAt ? setup.nextRunAt.toISOString() : null,
    createdAt: setup.createdAt.toISOString(),
    updatedAt: setup.updatedAt.toISOString(),
  };
}

/**
 * Creates the use cases behind an agent's page: choosing pages and switching the agent on.
 *
 * The setup is what a person decided; the schedule is what makes the agent act. They are separate
 * because they answer different questions — "which pages", "is it on" — and because the schedule
 * is the generic mechanism every agent shares while the setup is the agent's own.
 *
 * @param {object} dependencies collaborators
 * @param {object} dependencies.workspaceRepository workspace access by owner or membership
 * @param {object} dependencies.setupStore setup persistence, from `@orbik/core`
 * @param {object} dependencies.agentScheduleRepository the on/off switch in `agent_schedules`
 * @param {object} dependencies.runRepository agent runs, for when an agent last finished
 * @param {object} dependencies.crawlRepository crawl data, for readiness
 * @param {() => Date} [dependencies.now] clock
 */
export function createAgentSetupService({
  workspaceRepository,
  setupStore,
  agentScheduleRepository,
  runRepository,
  crawlRepository,
  now = () => new Date(),
}) {
  const requireWorkspaceAccess = createWorkspaceAccessCheck(workspaceRepository);

  /** Resolves an agent, or fails as a missing one. */
  function requireAgent(agentSlug) {
    const definition = findAgent(agentSlug);
    if (!definition) {
      throw new AppError({ status: 404, code: "AGENT_NOT_FOUND", message: "Agent was not found." });
    }
    return definition;
  }

  /**
   * What the workspace has that an agent could work from.
   *
   * `crawled` is what a page picker chooses from; `markdownPages` is what the
   * knowledge agents read, and the two are not the same fact — a crawl that finished with every
   * page redirecting has run but rendered nothing to read.
   */
  async function describeReadiness(workspace) {
    const site = await crawlRepository.findSiteByWorkspace(workspace._id);
    const latestRun = site ? await crawlRepository.findLatestRun(site._id) : null;
    const markdownPages = site ? await crawlRepository.countMarkdown({ siteId: site._id }) : 0;
    return { crawled: Boolean(site && latestRun), siteUrl: site?.seedUrl ?? null, markdownPages };
  }

  /** When this agent last finished a run in this workspace, or null when it never has. */
  async function lastSucceededAt(workspaceId, agentSlug) {
    const run = await runRepository.findLatest({ workspaceId, agentSlug, status: "succeeded" });
    return run?.finishedAt ?? run?.startedAt ?? null;
  }

  /**
   * What switching an agent on writes about when it runs next.
   *
   * Nothing when it is being switched off: the row keeps what it had, so resuming can reason from
   * it. An agent with no cadence gets no due time and the moment it was switched on instead.
   */
  async function dueTimes({ workspace, agentSlug, profile, setup, working, current }) {
    if (!working) return {};
    if (profile.cadenceHours === null) return { nextRunAt: null, workingSince: current };
    const cadenceMs = profile.cadenceHours * 3_600_000;
    // The setup's own record where the agent keeps one, and otherwise the run history, which every
    // agent has. Without the fallback,
    // pausing and resuming an agent that keeps no setup would start a fresh run each time.
    const lastRunAt = setup?.lastRunAt ?? (await lastSucceededAt(workspace._id, agentSlug));
    const ranRecently = lastRunAt && current.getTime() - lastRunAt.getTime() < cadenceMs;
    return { nextRunAt: ranRecently ? new Date(lastRunAt.getTime() + cadenceMs) : current };
  }

  /** The setup with the schedule's next due time folded in, so one read answers "when next". */
  async function withSchedule(workspaceId, agentSlug, setup) {
    if (!setup) return null;
    const schedule = await agentScheduleRepository.find({ workspaceId, agentSlug });
    return { ...setup, nextRunAt: schedule?.enabled ? schedule.nextRunAt : null };
  }

  return {
    /** Returns the setup, the agent, and whether there is a crawl to choose pages from. */
    async getSetup({ userId, workspaceId, agentSlug }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      const definition = await requireAgent(agentSlug);
      const [setup, readiness] = await Promise.all([
        setupStore.find({ workspaceId: workspace._id, agentSlug }),
        describeReadiness(workspace),
      ]);
      return {
        agent: toAgentSummary(definition),
        setup: toSetupSummary(await withSchedule(workspace._id, agentSlug, setup)),
        readiness,
      };
    },

    /** Saves the pages to track. */
    async saveSetup({ userId, workspaceId, agentSlug, pages }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "member" });
      await requireAgent(agentSlug);
      const setup = await setupStore.save({ workspaceId: workspace._id, agentSlug, pages });
      return { setup: toSetupSummary(await withSchedule(workspace._id, agentSlug, setup)) };
    },

    /**
     * Switches an agent on, or off.
     *
     * For an agent on a schedule, the first run is due immediately when the agent has never run,
     * so pressing the button produces something to look at within the scheduler's next pass rather
     * than in a month. When it has run recently, the next run is due one cadence after that run,
     * so pausing and resuming does not produce a second data point three days after the first.
     *
     * How often, and whether anything has to be configured first, come from the agent's schedule
     * profile: an agent that measures a list somebody chose is useless without it, while the
     * knowledge agents read whatever the crawler found and need no setup at all.
     *
     * An agent with no cadence — the Library — is not given a due time at all. Its row is only the
     * switch, and what it records instead is *when* it was switched on: the agents scheduler starts
     * a run when the work upstream (the notes) has moved since the last one, and a switch thrown
     * after a run that failed is how a person says "try that again".
     *
     * An agent with a page of its own for starting it (an on-request agent: one whose run spends
     * something a person has to agree to first) has no switch at all: no schedule row is written
     * for it, and the schedule loop would ignore one anyway.
     */
    async setWorking({ userId, workspaceId, agentSlug, working }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "member" });
      await requireAgent(agentSlug);
      if (isOnRequestAgent(agentSlug)) {
        throw new AppError({
          status: 409,
          code: "AGENT_ON_REQUEST_ONLY",
          message: "This agent is started from its own page. It has no switch.",
        });
      }
      const profile = scheduleProfileFor(agentSlug);
      const setup = await setupStore.find({ workspaceId: workspace._id, agentSlug });
      if (profile.requiresPages && !setup?.pages?.length) {
        throw new AppError({ status: 409, code: "AGENT_NOT_CONFIGURED", message: "Choose the pages to track before starting the agent." });
      }

      const current = now();
      await agentScheduleRepository.save({
        workspaceId: workspace._id,
        agentSlug,
        enabled: Boolean(working),
        intervalHours: profile.cadenceHours,
        dueTimes: await dueTimes({ workspace, agentSlug, profile, setup, working, current }),
        now: current,
      });
      const updated = await setupStore.setWorking({ workspaceId: workspace._id, agentSlug, working });
      return { setup: toSetupSummary(await withSchedule(workspace._id, agentSlug, updated)) };
    },
  };
}
