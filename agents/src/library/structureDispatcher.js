import { AGENT_COLLECTIONS, KNOWLEDGE_AGENT_SLUG, log } from "@orbik/core";

import { LIBRARY_JOBS, libraryJob } from "../jobs.js";
import { createLoop } from "../runtime/loop.js";

/** How many requests one pass may queue, so a backlog cannot flood the queue in one tick. */
const MAX_PER_PASS = 20;

/**
 * How long a queued request may go unanswered before it is queued again.
 *
 * The job is one model call with a three-minute ceiling; one still pending after this was lost
 * with its worker, and the person waiting on the Library page would otherwise wait for good.
 */
const STALE_MS = 10 * 60 * 1000;

/**
 * Creates the loop that turns a person's request to change the Library's folders into a job.
 *
 * The API never enqueues: it stores the request on the knowledge agent's setup document as
 * `structure.revision`, `pending`, and returns. The Library scheduler that waits on the structure
 * passes once a minute, which is too slow for somebody who has just pressed Send and is watching
 * the list, so this pass runs at the run dispatcher's pace and does one thing: claims each pending
 * request nobody has queued (by setting `queuedAt`, which only one process can do first) and
 * queues its `structure.revise` job. What the job does is `./structure.js`.
 *
 * @param {object} options collaborators
 * @param {import("mongodb").Db} options.database connected database
 * @param {ReturnType<import("../runtime/queue.js").createJobQueue>} options.queue job queue
 * @param {object} options.config validated agent environment
 * @param {(level: string, message: string, context?: object) => void} [options.logger]
 * @param {() => Date} [options.now] clock; defaults to the system clock
 */
export function createStructureDispatcher({ database, queue, config, logger = log, now = () => new Date() }) {
  const setups = database.collection(AGENT_COLLECTIONS.agentSetups);
  const loop = createLoop({
    name: "structure_dispatcher",
    intervalMs: config.dispatcherIntervalMs,
    tick: () => dispatcher.tick(),
    logger,
  });

  /** Claims one pending request that is not queued, or whose job was lost. */
  function claim(current) {
    return setups.findOneAndUpdate(
      {
        agentSlug: KNOWLEDGE_AGENT_SLUG,
        "structure.revision.status": "pending",
        $or: [
          { "structure.revision.queuedAt": { $exists: false } },
          { "structure.revision.queuedAt": { $lt: new Date(current.getTime() - STALE_MS) } },
        ],
      },
      { $set: { "structure.revision.queuedAt": current } },
      { projection: { workspaceId: 1, "structure.revision.id": 1 }, returnDocument: "after" },
    );
  }

  const dispatcher = {
    /** Runs one pass and reports what it queued. */
    async tick() {
      const queued = [];
      for (let index = 0; index < MAX_PER_PASS; index += 1) {
        const current = now();
        const setup = await claim(current);
        if (!setup) break;
        const revisionId = setup.structure.revision.id;
        const job = libraryJob(LIBRARY_JOBS.revise, {
          workspaceId: setup.workspaceId,
          idempotencyKey: `structure:${revisionId.toHexString()}:${current.getTime()}`,
        });
        await queue.enqueue({
          ...job,
          payload: { ...job.payload, revisionId: revisionId.toHexString() },
          // Somebody is watching the page for the answer.
          priority: 1,
          maxAttempts: 1,
        });
        queued.push({ workspaceId: setup.workspaceId, revisionId });
        logger("info", "structure_dispatcher.queued", {
          workspaceId: setup.workspaceId.toHexString(),
          revisionId: revisionId.toHexString(),
        });
      }
      return { queued };
    },

    /** Starts passes until {@link stop} is called. */
    start: loop.start,

    /** Stops and waits for the pass in progress to finish. */
    stop: loop.stop,
  };
  return dispatcher;
}
