import { isOnRequestAgent, isUpstreamAgent } from "@orbik/core";
import { UNLIMITED, agentAllowed } from "@orbik/extensions";
import { isTerminalRunStatus } from "@orbik/protocol";

import { AppError } from "../errors/appError.js";
import { findAgent, listAgentDefinitions, toAgentSummary } from "./agentCatalog.js";
import { toRunDetail, toRunEvent, toRunSummary } from "../repositories/runRepository.js";
import { createWorkspaceAccessCheck } from "./workspaceAccess.js";

/**
 * Creates the use cases behind starting, watching, and cancelling agent runs.
 *
 * Like every other service here, each method starts from the workspace access check, with the
 * role the operation needs, rather than from the run itself. A run identifier is not an authorization token: reaching a run through
 * its workspace means somebody guessing another user's run identifier is refused by the same check
 * that protects the workspace, instead of by a second one that could drift out of step with it.
 *
 * The service creates runs but never dispatches them. That rule already exists in this codebase —
 * `requestCrawl` marks a site due and lets the scheduler start it — and it holds for the same
 * reasons: an HTTP handler must not race a worker, and accepting a request must not depend on the
 * queue being reachable.
 *
 * @param {object} dependencies collaborators
 * @param {object} dependencies.workspaceRepository workspace access by owner or membership
 * @param {object} dependencies.runRepository agent run access
 * @param {object} dependencies.crawlRepository crawl configuration, to scope an agent's tools
 */
export function createRunService({
  workspaceRepository,
  runRepository,
  crawlRepository,
  // The workspace owner's plan limits, for which agents may run; unlimited when not given.
  limitsFor = async () => UNLIMITED,
}) {
  const requireWorkspaceAccess = createWorkspaceAccessCheck(workspaceRepository);

  /** Resolves a run inside a workspace the caller can open, with the same 404 for both failures. */
  async function requireRun(userId, workspaceId, runId, role) {
    const workspace = await requireWorkspaceAccess(userId, workspaceId, { role });
    const run = await runRepository.findInWorkspace(workspace._id, runId);
    if (!run) {
      throw new AppError({ status: 404, code: "RUN_NOT_FOUND", message: "Run was not found." });
    }
    return { workspace, run };
  }

  return {
    /**
     * Lists the agents a user can run.
     *
     * Not workspace-scoped: the catalog is the same for everyone, and a user browsing what Orbik
     * can do has not chosen a workspace yet.
     */
    async listAgents() {
      return { items: listAgentDefinitions().map(toAgentSummary) };
    },

    /**
     * Accepts a run and records it as queued.
     *
     * The agent must exist before a run does. Refusing here — rather than creating a run
     * that fails later — is what lets the interface say something a person can act on.
     *
     * `confirmed` is not something a request can say. It is passed only by the service that owns
     * an agent whose start has to be agreed to (an on-request agent; none in this edition), once
     * it has checked what the person confirmed and written the run's input itself. The shared
     * route never passes it, so such an agent cannot be started there with an input of the
     * caller's choosing.
     *
     * Starting a run needs the member role. `minimumRole` is not something a request can say
     * either: it is passed only by Ask, which lets a read-only person ask a question and answers
     * them with `library-chat-read`, a definition that has no tool that writes. The shared route
     * never passes it.
     *
     * @returns {Promise<{run: object, created: boolean}>}
     */
    async createRun({ userId, workspaceId, agentSlug, input, requestKey, confirmed = false, minimumRole = "member" }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: minimumRole });

      const definition = findAgent(agentSlug);
      if (!definition) {
        throw new AppError({ status: 404, code: "AGENT_NOT_FOUND", message: "Agent was not found." });
      }
      // Some agents are started by the work upstream of them and never by a person: the Library by
      // a crawl and then its notes. Refused here rather than only left out of the interface, so the
      // rule holds for every client and a run cannot be started beside the one that work is about
      // to cause.
      if (isUpstreamAgent(definition.slug)) {
        throw new AppError({
          status: 409,
          code: "AGENT_NOT_MANUAL",
          message: "This agent starts on its own when your site changes. Set it to work and crawl the site.",
        });
      }
      // And some are started only from their own page, after the person has agreed to what the
      // run may fetch and spend. Refused here for the reason above: the rule has to hold for every
      // client, not only for the interface that happens to show the estimate.
      if (isOnRequestAgent(definition.slug) && !confirmed) {
        throw new AppError({
          status: 409,
          code: "CONFIRMATION_REQUIRED",
          message: "This agent is started from its own page, once you have confirmed what the run may fetch and spend.",
        });
      }

      // The worker refuses it too, for the runs that never come through here; this is the same
      // rule said to the person who pressed Run.
      if (!agentAllowed(await limitsFor({ ownerId: workspace.ownerId, workspaceId: workspace._id }), definition.slug)) {
        throw new AppError({ status: 403, code: "PLAN_LIMIT_REACHED", message: "This workspace's plan does not include this agent." });
      }

      const site = await crawlRepository.findSiteByWorkspace(workspace._id);
      return runRepository.createIdempotent({
        workspaceId: workspace._id,
        siteId: site?._id ?? null,
        agentSlug: definition.slug,
        agentVersion: definition.version,
        input,
        requestKey,
        requestedBy: userId,
        startedBy: userId,
      });
    },

    /** Lists a workspace's runs, newest first. */
    async listRuns({ userId, workspaceId, agentSlug, status, limit }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      const runs = await runRepository.list({ workspaceId: workspace._id, agentSlug, status, limit });
      return { items: runs.map(toRunSummary) };
    },

    /** Returns one run with its input and, when it finished successfully, its result. */
    async getRun({ userId, workspaceId, runId }) {
      const { run } = await requireRun(userId, workspaceId, runId, "read-only");
      return { run: toRunDetail(run) };
    },

    /**
     * Reads a run's progress events after one the caller already has.
     *
     * The response says whether the run is still going, so a polling interface knows when to stop
     * asking rather than inferring it from an empty page — which is also what an in-progress run
     * that simply has not emitted anything for a few seconds looks like.
     */
    async listEvents({ userId, workspaceId, runId, after, limit }) {
      const { run } = await requireRun(userId, workspaceId, runId, "read-only");
      const events = await runRepository.listEvents({ runId: run._id, after, limit });
      return {
        items: events.map(toRunEvent),
        status: run.status,
        complete: isTerminalRunStatus(run.status),
      };
    },

    /**
     * Asks a run to stop.
     *
     * A run that has not started is ended here, because nothing is
     * executing it and there is nobody to ask. A running one is only *marked*: the thing that has
     * to stop is a provider call or a subprocess on a worker, and reporting it
     * as cancelled before that happens would tell the user it stopped while it kept costing money.
     */
    async cancelRun({ userId, workspaceId, runId }) {
      const { run } = await requireRun(userId, workspaceId, runId, "member");
      if (isTerminalRunStatus(run.status)) {
        return { run: toRunSummary(run), stopped: true };
      }

      const ended = await runRepository.cancelIfNotStarted(run.workspaceId, runId);
      if (ended) return { run: toRunSummary(ended), stopped: true };

      const marked = await runRepository.requestCancel(run.workspaceId, runId);
      return { run: toRunSummary(marked ?? run), stopped: false };
    },
  };
}
