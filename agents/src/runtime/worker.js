import { log } from "@orbik/core";

import { CRAWLER_AGENT } from "../jobs.js";
import { AgentError, classifyFailure } from "./errors.js";

/**
 * The least a wait for a delayed job lasts, so that a clock a little ahead of the one the job was
 * queued by cannot turn the wait into a spin.
 */
const MIN_WAIT_MS = 25;

/**
 * Creates the loop that turns queued jobs into executed agent work.
 *
 * The worker owns everything an agent should not have to think about: claiming, lease renewal,
 * retry classification, follow-up enqueueing, run counters, lease recovery, and shutdown. An
 * agent handler is therefore an ordinary async function that does its work and returns.
 *
 * Concurrency is a fixed number of slots rather than an unbounded fan-out, because the work is
 * network-bound against third-party sites: an unbounded worker would translate a queue spike
 * directly into a burst of requests at somebody else's server.
 *
 * @param {object} options collaborators
 * @param {ReturnType<import("./queue.js").createJobQueue>} options.queue job queue
 * @param {ReturnType<import("./registry.js").createAgentRegistry>} options.registry agents this process runs
 * @param {ReturnType<import("./runLedger.js").createRunLedger>} options.ledger run ledger
 * @param {import("mongodb").Db} options.database connected database, passed through to handlers
 * @param {object} options.config validated agent environment
 * @param {(level: string, message: string, context?: object) => void} [options.logger] structured logger
 */
export function createWorker({ queue, registry, ledger, database, config, logger = log }) {
  const agents = registry.names();
  const inFlight = new Map();
  const controller = new AbortController();
  let running = false;
  let loop = null;
  let lastReclaimAt = 0;

  /**
   * Executes one claimed job to completion and records its outcome.
   *
   * Follow-up jobs are enqueued **before** the job is completed. If the process dies in between,
   * the lease expires and the job is retried, re-enqueueing the same follow-ups — which is
   * harmless because every follow-up carries an idempotency key. The opposite order would lose
   * follow-up work entirely on a crash, silently truncating a crawl.
   *
   * They are enqueued in one write, however many there are: a crawled page returns one for every
   * page it links to.
   */
  async function execute(job) {
    const jobController = new AbortController();
    const signal = AbortSignal.any([controller.signal, jobController.signal]);
    const leaseLost = () => jobController.abort(new AgentError({ code: "LEASE_LOST", message: "Worker lost its job lease.", retryable: true }));
    let leaseDeadline = setTimeout(leaseLost, config.leaseMs);
    const heartbeat = setInterval(() => {
      queue
        .heartbeat({ jobId: job._id, workerId: config.workerId, leaseMs: config.leaseMs })
        .then((owned) => {
          if (!owned) return leaseLost();
          clearTimeout(leaseDeadline);
          leaseDeadline = setTimeout(leaseLost, config.leaseMs);
        })
        .catch((error) => logger("error", "agent.heartbeat_failed", { jobId: String(job._id), message: error.message }));
    }, Math.max(1000, Math.floor(config.leaseMs / 3)));

    try {
      const { handler } = registry.resolve(job.agent, job.type);
      const result = (await handler(job, {
        database,
        queue,
        ledger,
        logger,
        signal,
        /** Lets a long single step extend its own lease between queue operations. */
        heartbeat: () =>
          queue.heartbeat({ jobId: job._id, workerId: config.workerId, leaseMs: config.leaseMs }),
      })) ?? {};

      signal.throwIfAborted();
      await queue.enqueueMany((result.enqueue ?? []).map((followUp) => ({
        runId: job.runId,
        siteId: job.siteId,
        workspaceId: job.workspaceId,
        ...followUp,
      })));
      if (job.runId && result.counters) await ledger.increment(job.runId, result.counters);
      await queue.complete({ jobId: job._id, workerId: config.workerId, counters: result.counters });
    } catch (error) {
      const failure = classifyFailure(error);
      const outcome = await queue.fail({ jobId: job._id, workerId: config.workerId, failure });
      // A job put off by a hold on its host was not tried, so it is counted apart from the
      // retries and not logged: one hold puts off every queued page of the site, and the request
      // that was actually refused has already been logged as the failure it is.
      const counter = outcome?.status === "failed" ? "jobsDeadLettered" : outcome?.putOff ? "jobsHeld" : "jobsRetried";
      if (job.runId) await ledger.increment(job.runId, { [counter]: 1 });
      if (job.agent === CRAWLER_AGENT && job.runId && outcome?.status === "failed") {
        const counts = await queue.countByStatus(job.runId);
        if (!(counts.pending || counts.running)) await ledger.finish(job.runId, "failed", { error: { code: failure.code, message: failure.message } });
      }
      if (!outcome?.putOff) {
        logger(failure.retryable ? "warn" : "error", "agent.job_failed", {
          agent: job.agent,
          type: job.type,
          jobId: String(job._id),
          attempts: job.attempts,
          code: failure.code,
          retryable: failure.retryable,
          outcome: outcome?.status ?? "lease_lost",
        });
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(leaseDeadline);
      inFlight.delete(String(job._id));
    }
  }

  /** Fills free slots until none is left or the queue has nothing this worker can claim. */
  async function fillSlots() {
    while (running && inFlight.size < config.concurrency) {
      const job = await queue.claim({ agents, workerId: config.workerId, leaseMs: config.leaseMs });
      if (!job) break;
      // Stopped while the claim was on its way. Shutdown has already counted the jobs it will
      // wait for, so this one would be started and then abandoned when the process exits: left
      // running until its lease lapsed, and with it, for a crawl job, the crawl lease. It goes
      // straight back instead, as untouched as it came.
      if (!running) {
        await queue.release({ jobId: job._id, workerId: config.workerId });
        break;
      }
      inFlight.set(String(job._id), execute(job));
    }
  }

  /**
   * Waits until there may be something to claim: a job in flight has finished, a job waiting out
   * a delay has become ready, or the poll interval has passed.
   *
   * A finished job is the commoner reason by far. It frees a slot, it has usually just queued
   * its follow-up work, and for a crawl it is what lets the next job of the run be claimed at
   * all. Sleeping the whole interval instead put most of a second between one page and the next,
   * which was most of a crawl's duration. The interval still bounds the wait, because work also
   * arrives from outside this process: a scheduler, the API.
   *
   * With every slot taken there is nothing to poll for, so only a finished job ends the wait.
   */
  async function waitForWork() {
    const executing = [...inFlight.values()];
    if (executing.length >= config.concurrency) return Promise.race(executing);
    // A job that settles while the queue is being asked is still in `executing`, and ends the
    // race below at once.
    const readyAt = await queue.nextReadyAt({ agents });
    const wait = readyAt
      ? Math.min(config.pollIntervalMs, Math.max(MIN_WAIT_MS, readyAt.getTime() - Date.now()))
      : config.pollIntervalMs;
    const pause = timer(wait, controller.signal);
    try {
      await Promise.race([pause.done, ...executing]);
    } finally {
      // Cancelled when a job wins, or one timer per finished job would be left running.
      pause.cancel();
    }
  }

  return {
    /**
     * Starts claiming and executing until {@link stop} is called.
     *
     * Lease recovery runs on the same loop rather than in a separate process: any worker can
     * recover any other worker's abandoned jobs, so the fleet needs no designated leader and
     * recovery keeps working while only one worker is alive.
     */
    async start() {
      if (running) return;
      running = true;
      logger("info", "agent.worker_started", {
        workerId: config.workerId,
        agents,
        concurrency: config.concurrency,
      });

      loop = (async () => {
        while (running) {
          try {
            // At most once a poll interval. The loop turns once for every finished job, and a
            // lease takes minutes to expire, so looking for one each time would be a query a
            // page for nothing.
            if (Date.now() - lastReclaimAt >= config.pollIntervalMs) {
              lastReclaimAt = Date.now();
              const { reclaimed, deadLettered } = await queue.reclaimExpired();
              if (reclaimed || deadLettered) {
                logger("warn", "agent.leases_recovered", { reclaimed, deadLettered });
              }
            }
            await fillSlots();
            // fillSlots stops when the slots are full or the queue had nothing to give, and
            // either way the next thing worth waiting for is the same.
            if (running) await waitForWork();
          } catch (error) {
            logger("error", "agent.loop_error", { message: error.message });
            await sleep(config.pollIntervalMs, controller.signal);
          }
        }
      })();
      await loop;
    },

    /**
     * Stops claiming, then lets in-flight jobs finish within the grace period.
     *
     * Work still running when the grace period expires is released rather than failed: a deploy
     * interrupting a crawl is not the crawl's fault, so it must not consume a retry attempt.
     *
     * @returns {Promise<{drained: number, released: number}>} how shutdown resolved
     */
    async stop() {
      if (!running) return { drained: 0, released: 0 };
      running = false;
      const outstanding = [...inFlight.keys()];
      const drained = await Promise.race([
        Promise.allSettled([...inFlight.values()]).then(() => true),
        sleep(config.shutdownGraceMs).then(() => false),
      ]);

      let released = 0;
      if (!drained) {
        controller.abort();
        for (const jobId of outstanding) {
          if (await queue.release({ jobId, workerId: config.workerId })) released += 1;
        }
      }
      await loop?.catch(() => {});
      logger("info", "agent.worker_stopped", {
        workerId: config.workerId,
        drained: outstanding.length - released,
        released,
      });
      return { drained: outstanding.length - released, released };
    },
  };
}

/**
 * Sleeps, returning early when the signal aborts so shutdown is not delayed by a poll interval.
 *
 * @param {number} ms delay in milliseconds
 * @param {AbortSignal} [signal] abort source
 */
function sleep(ms, signal) {
  return timer(ms, signal).done;
}

/**
 * A sleep that can be called off.
 *
 * `cancel` clears the timeout and takes the abort listener off the signal, so a wait that ends
 * early for another reason leaves nothing behind. A sleep that runs its course cleans up the
 * same way.
 *
 * @param {number} ms delay in milliseconds
 * @param {AbortSignal} [signal] abort source; the sleep ends when it aborts
 * @returns {{done: Promise<void>, cancel: () => void}}
 */
function timer(ms, signal) {
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const cancel = () => {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
    finish();
  };
  const timeout = setTimeout(cancel, signal?.aborted ? 0 : ms);
  signal?.addEventListener("abort", cancel, { once: true });
  return { done, cancel };
}
