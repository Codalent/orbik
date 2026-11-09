import { log } from "@orbik/core";
import { RUN_STATUS } from "@orbik/protocol";

import { AI_AGENT, AI_JOBS } from "../jobs.js";
import { createLoop } from "../runtime/loop.js";

/** How many runs one pass may dispatch, so a backlog cannot flood the queue in one tick. */
const MAX_RUNS_PER_PASS = 50;

/**
 * Creates the loop that moves accepted runs onto the job queue.
 *
 * It exists because the API deliberately does not enqueue work. That rule is already in the
 * codebase — `POST /crawl/runs` sets a due time and lets the scheduler pick it up — and it is
 * there so an HTTP handler cannot race a worker, and so accepting a request never depends on the
 * queue being reachable. Runs follow the same shape: the API writes an `agent_runs` row in
 * `queued` and returns 202; this loop turns that row into work.
 *
 * @param {object} options collaborators
 * @param {import("mongodb").Collection} options.runs the `agent_runs` collection
 * @param {ReturnType<import("../runtime/queue.js").createJobQueue>} options.queue job queue
 * @param {object} options.config validated agent environment
 * @param {(level: string, message: string, context?: object) => void} [options.logger]
 * @param {() => Date} [options.now] clock; defaults to the system clock
 */
export function createRunDispatcher({ runs, queue, config, logger = log, now = () => new Date() }) {
  // One bad run must not stop the loop: the next pass reconsiders everything queued, so a failure
  // delays that run rather than every run.
  const loop = createLoop({
    name: "dispatcher",
    intervalMs: config.dispatcherIntervalMs,
    tick: () => dispatcher.tick(),
    logger,
  });

  /**
   * Atomically claims one queued run.
   *
   * The claim is the status change: two dispatchers racing cannot both take the same run, because
   * only one `findOneAndUpdate` can move it out of `queued`. It goes straight to `running`
   * because the job is enqueued immediately afterwards.
   */
  async function claimQueuedRun(current) {
    return runs.findOneAndUpdate(
      { status: RUN_STATUS.queued },
      { $set: { status: RUN_STATUS.running, updatedAt: current } },
      { sort: { startedAt: 1 }, returnDocument: "after" },
    );
  }

  const dispatcher = {
    /**
     * Runs one dispatch pass and reports what it moved.
     *
     * Exposed separately from {@link start} so an operator can drain a backlog by hand.
     *
     * @returns {Promise<{dispatched: object[]}>}
     */
    async tick() {
      const dispatched = [];

      for (let index = 0; index < MAX_RUNS_PER_PASS; index += 1) {
        const current = now();
        const run = await claimQueuedRun(current);
        if (!run) break;

        // The idempotency key is the run itself, so a dispatcher that crashes between claiming and
        // enqueueing — and a run recovered later — produce one job, not two.
        await queue.enqueue({
          agent: AI_AGENT,
          type: AI_JOBS.execute,
          payload: { runId: run._id.toHexString() },
          runId: run._id,
          siteId: run.siteId,
          workspaceId: run.workspaceId,
          priority: run.trigger === "manual" ? 1 : 5,
          maxAttempts: config.maxAttempts,
          idempotencyKey: `ai:${run._id.toHexString()}`,
        });

        dispatched.push({ runId: run._id });
        logger("info", "dispatcher.run_dispatched", {
          runId: run._id.toHexString(),
          agent: run.agentSlug,
        });
      }

      return { dispatched };
    },

    /** Starts dispatch passes until {@link stop} is called. */
    start: loop.start,

    /** Stops dispatching and waits for the pass in progress to finish. */
    stop: loop.stop,
  };
  return dispatcher;
}
