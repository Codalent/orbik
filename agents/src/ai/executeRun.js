import { findAgentDefinition } from "@orbik/agent-definitions";
import { AGENT_COLLECTIONS, COLLECTIONS } from "@orbik/core";
import { activeExtensions, agentAllowed } from "@orbik/extensions";
import { LIBRARY_WRITE_CHANNELS } from "@orbik/library";
import { AGENT_EVENT_TYPES, AGENT_WRITERS, RUN_STATUS, toDispatchPayload } from "@orbik/protocol";
import { ObjectId } from "mongodb";

import { AgentError, classifyFailure } from "../runtime/errors.js";
import { createRunEventLog } from "../runtime/runEventLog.js";
import { TOOLS, createToolRegistry } from "@orbik/tools";

/**
 * Creates the single job handler that executes any agent definition.
 *
 * There is one handler, not one per agent, and that is the point of the whole architecture. A new
 * SEO agent is a definition in `@orbik/agent-definitions`; shipping it changes no code here. What
 * this handler does is the part that is genuinely the same every time: resolve the definition,
 * build a workspace-scoped tool registry, pick a runtime, stream the events, and close the run.
 *
 * @param {object} options collaborators
 * @param {object} options.runtimes `model`, and `plain`: the plain-code runtimes, keyed by the
 *   runtime requirement that names each
 * @param {object|null} [options.retrieval] the retrieval index the search tool queries
 * @returns {(job: object, context: object) => Promise<object>} a runtime job handler
 */
export function createExecuteRunHandler({ runtimes, retrieval = null }) {
  /**
   * Executes one run to completion.
   *
   * The run is closed here rather than by the worker, because only this function knows whether the
   * agent produced a result. The worker's own retry machinery still applies to the *job*: a
   * provider rate limit throws a retryable `AgentError`, the job goes back on the queue, and this
   * function runs again for the same run — which is why every step below is safe to repeat.
   */
  return async function executeRun(job, { database, ledger, logger, signal }) {
    const runId = job.runId;
    if (!runId) {
      throw new AgentError({
        code: "INVALID_JOB",
        message: "An agent execution job must name the run it belongs to.",
        retryable: false,
      });
    }

    const run = await ledger.find(runId);
    if (!run) {
      throw new AgentError({
        code: "RUN_NOT_FOUND",
        message: "The run this job belongs to no longer exists.",
        retryable: false,
      });
    }
    // A run somebody cancelled while the job sat in the queue must not start.
    if (run.status !== RUN_STATUS.running) {
      logger("info", "ai.run_not_runnable", { runId: String(runId), status: run.status });
      return { counters: { runsSkipped: 1 } };
    }

    const definition = loadDefinition(run.agentSlug);
    const events = createRunEventLog({ runEvents: database.collection(AGENT_COLLECTIONS.runEvents) });
    // Over the owner's plan, the run is closed as failed with the reason before anything is read or
    // asked — closed here rather than thrown, so the person sees why instead of a run left open.
    const refusal = await planRefusal(database, run, definition.slug);
    if (refusal) {
      await events.append({ runId, seq: (await events.lastSeq(runId)) + 1, event: { type: AGENT_EVENT_TYPES.failed, ...refusal } });
      await ledger.finish(runId, RUN_STATUS.failed, { error: refusal });
      logger("info", "ai.run_refused", { runId: String(runId), agent: definition.slug, code: refusal.code });
      return { counters: { runsFailed: 1 } };
    }
    const runtime = chooseRuntime(runtimes, definition);
    if (!runtime) {
      throw new AgentError({
        code: "NO_RUNTIME",
        message: `This worker cannot execute ${definition.slug}.`,
        retryable: false,
      });
    }

    const siteId = run.siteId ?? (await findSite(database, run.workspaceId));
    const actor = definition.writesAs === AGENT_WRITERS.person
      ? await personActor(database, run)
      : null;
    const tools = createToolRegistry({
      tools: TOOLS,
      allowed: definition.tools,
      // The scope is the run's, taken from the run document rather than from the job payload or
      // the agent's input. A tool therefore cannot be pointed at another workspace by anything the
      // model writes, or by anything written on a page the model read.
      //
      // The agent and the run travel with it because the writing tools need them: an agent's
      // record of which source pages it has accounted for is its own, and a document it writes
      // records the run that last wrote it. Neither can be an argument — an agent that could name
      // another agent's ledger could make its own work look done.
      //
      // The one exception is a definition that writes as the person (`writesAs: "person"`): the
      // chat in the side panel, doing what somebody just asked it to. Its writes are recorded as
      // theirs, "via Ask", and the person is read from the run document — who asked — never from
      // the input, so nothing typed into the chat or read on a page can choose whose they are.
      scope: { workspaceId: run.workspaceId, siteId, agentSlug: definition.slug, runId, ...(actor ? { actor } : {}) },
      // The retrieval index is a collaborator rather than something a tool constructs, for the
      // same reason the database is: it holds a connection and a credential, and a tool that
      // built one per call would open one per call. A worker without an index passes null, and
      // `content.search` says so rather than returning an empty list a model would read as "this
      // site says nothing about that".
      context: { database, retrieval },
      // The registry is built once per run, which is what makes the reading ceiling a closure
      // rather than a database counter: every `content.readPages` call of this run shares it.
      readingBudget: definition.readingBudget ?? null,
    });

    // Numbering continues from what is already recorded, so a retried job appends to the run's
    // history instead of colliding with its own earlier events.
    let seq = await events.lastSeq(runId);

    try {
      const stream = runtime.run({
        definition: toDispatchPayload(definition),
        input: run.input ?? {},
        tools,
        signal,
        isCancelled: () => ledger.isCancelRequested(runId),
        // So the call log can say which run, workspace, and site each model call was for.
        trace: { runId, workspaceId: run.workspaceId, siteId },
      });

      let outcome = null;
      while (true) {
        const next = await stream.next();
        if (next.done) {
          outcome = next.value;
          break;
        }
        seq += 1;
        await events.append({ runId, seq, event: next.value });
      }

      await ledger.finish(runId, RUN_STATUS.succeeded, {
        result: outcome.result,
        usage: outcome.usage ?? null,
      });

      logger("info", "ai.run_succeeded", {
        runId: String(runId),
        agent: definition.slug,
        version: definition.version,
      });
      return { counters: { runsSucceeded: 1 } };
    } catch (error) {
      const failure = classifyFailure(error);
      // A retryable failure leaves the run open on purpose: the queue will hand the job back, and
      // closing the run now would tell the user it failed while it is about to run again.
      if (failure.retryable) throw error;

      seq += 1;
      await events.append({
        runId,
        seq,
        event: { type: AGENT_EVENT_TYPES.failed, code: failure.code, message: failure.message },
      });

      const cancelled = failure.code === "CANCELLED";
      await ledger.finish(runId, cancelled ? RUN_STATUS.cancelled : RUN_STATUS.failed, {
        error: { code: failure.code, message: failure.message },
      });

      logger(cancelled ? "info" : "error", "ai.run_finished", {
        runId: String(runId),
        code: failure.code,
        status: cancelled ? RUN_STATUS.cancelled : RUN_STATUS.failed,
      });
      return { counters: cancelled ? { runsCancelled: 1 } : { runsFailed: 1 } };
    }
  };
}

/**
 * Picks what executes a definition: the plain-code runtime one of its requirements names, or a
 * model.
 *
 * The requirements are the only thing read, so the choice is the definition's and never the
 * run's: nothing a person or a schedule passes can send a measuring agent to a model, or a
 * reasoning one to code. A requirement that names no runtime here — `crawl-dataset` — is a fact
 * about what the agent needs rather than about what executes it, and leaves the choice alone.
 *
 * @param {{model: object, plain?: Record<string, object>}} runtimes what this worker can execute in
 * @param {object} definition the parsed definition
 * @returns {object|undefined} the runtime, or undefined when this worker has none for it
 */
function chooseRuntime(runtimes, definition) {
  const plain = runtimes.plain ?? {};
  const named = definition.runtimeRequirements.find((requirement) => Object.hasOwn(plain, requirement));
  return named ? plain[named] : runtimes.model;
}

/**
 * Finds the definition a run executes.
 *
 * A run names its agent by slug and is executed by the definition this worker ships. The version
 * the run recorded when it was accepted is a label, not a selector: there is one definition per
 * agent, and it is the one in the release that is running.
 */
function loadDefinition(slug) {
  const definition = findAgentDefinition(slug);
  if (!definition) {
    throw new AgentError({
      code: "AGENT_NOT_FOUND",
      message: `Agent ${slug} is not available on this deployment.`,
      retryable: false,
    });
  }
  return definition;
}

/**
 * Why a run of this agent is over the workspace owner's plan, or null when it is not. The API
 * refuses such a run when a person starts it; this is the same rule for the runs a schedule, a
 * crawl or the Library starts, which never pass through the API.
 *
 * @returns {Promise<{code: string, message: string}|null>}
 */
async function planRefusal(database, run, slug) {
  const extensions = activeExtensions();
  if (!extensions.hasPlanLimits || !run.workspaceId) return null;
  const workspace = await database
    .collection(COLLECTIONS.workspaces)
    .findOne({ _id: new ObjectId(run.workspaceId) }, { projection: { ownerId: 1 } });
  const limits = await extensions.limitsFor(workspace?.ownerId ?? null);
  if (agentAllowed(limits, slug)) return null;
  return { code: "PLAN_LIMIT_REACHED", message: "This workspace's plan does not include this agent." };
}

/**
 * The person a `writesAs: "person"` run writes for: whoever asked, as the API recorded it on the
 * run, or — for a run made before it recorded that — the workspace's owner, who is the only person
 * who can ask a workspace anything. A run naming neither cannot write, and fails rather than
 * writing under an agent's name what a person asked for.
 */
async function personActor(database, run) {
  let userId = run.requestedBy ?? null;
  if (!userId && run.workspaceId) {
    const workspace = await database
      .collection(COLLECTIONS.workspaces)
      .findOne({ _id: new ObjectId(run.workspaceId) }, { projection: { ownerId: 1 } });
    userId = workspace?.ownerId ?? null;
  }
  if (!userId) {
    throw new AgentError({
      code: "NO_PERSON",
      message: "This run does not say who asked for it, so it cannot write for them.",
      retryable: false,
    });
  }
  return { userId, via: { kind: LIBRARY_WRITE_CHANNELS.ask, client: "Ask" } };
}

/** Finds the crawl site a workspace's agents read from, or null when it has none yet. */
async function findSite(database, workspaceId) {
  if (!workspaceId) return null;
  const site = await database
    .collection(AGENT_COLLECTIONS.sites)
    .findOne({ workspaceId: new ObjectId(workspaceId) }, { projection: { _id: 1 } });
  return site?._id ?? null;
}
