import { toObjectId } from "@orbik/core";
import { ObjectId } from "mongodb";

import { CRAWLER_AGENT } from "../jobs.js";
import { AgentError } from "./errors.js";

/** Job lifecycle states. `pending` and `running` are the only non-terminal ones. */
export const JOB_STATUS = Object.freeze({
  pending: "pending",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
});

/** The one document in `crawl_queue_locks`: the lease every crawl of the deployment runs under. */
const CRAWL_LEASE_ID = "crawler";

const NAME_PATTERN = /^[a-z][a-z0-9]*(?:[.\-_][a-z0-9]+)*$/;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CEILING_MS = 5 * 60 * 1000;

/**
 * Creates the MongoDB-backed job queue used by every agent.
 *
 * MongoDB rather than a dedicated broker: the database is already deployed, backed up, and
 * understood, and a single `findOneAndUpdate` gives the atomic claim a queue needs. At the
 * scale this system targets (sites up to ~50k URLs) that is comfortably sufficient. The surface
 * here is deliberately broker-shaped — claim, heartbeat, complete, fail, release, reclaim — so
 * moving to a dedicated broker later replaces this file rather than the agents above it.
 *
 * Crash safety comes from **leases**, not from acknowledgements: a claimed job carries a
 * `leaseUntil` deadline that its worker must extend while working. If the worker dies, the lease
 * simply expires and the job returns to the queue. No worker heartbeat protocol, no broker state.
 *
 * **Crawls are serialized by a second lease**, one document in `crawl_queue_locks`, and it is
 * held per run by one worker process, not per job:
 *
 * - A worker takes it when nobody owns it, when it has lapsed, or when the worker owns it
 *   already. While it holds it, it may run several jobs of the pinned run at once, up to its own
 *   concurrency; no other worker claims a crawl job meanwhile.
 * - The lease pins a run (`runId`). No job of another run is claimed until the pinned run has no
 *   job pending or running, wherever that job is and however long its retry delay.
 * - The worker gives the lease back when the last crawl job it is running stops, and keeps the
 *   pin on the document, so whoever takes the lease next carries on with the same run.
 *
 * One process, because a host is paced by the fetcher inside that process: two workers sharing a
 * run would each allow themselves the full request rate. That is also why a worker's identity
 * must be unique among live processes, which the default (host name and process id) is.
 *
 * @param {object} options collaborators
 * @param {import("mongodb").Collection} options.jobs the `agent_jobs` collection
 * @param {import("mongodb").Collection} [options.crawlLocks] global crawl lease, supplied by the production runtime
 * @param {() => Date} [options.now] clock; defaults to the system clock
 * @param {() => number} [options.random] jitter source in `[0, 1)`; defaults to `Math.random`
 */
export function createJobQueue({ jobs, crawlLocks, now = () => new Date(), random = Math.random }) {
  // This process's dealings with the crawl lease, one at a time.
  //
  // Whether to give the lease back is decided by counting this worker's running crawl jobs, and
  // the count and the release are two operations. Between them a claim could take the lease it
  // already holds and start a job, and the release would then leave that job running with the
  // lease free for another worker to take. Other processes cannot interleave that way — they can
  // only take a lease that is free or lapsed — so ordering this process's own steps is enough.
  let leaseSteps = Promise.resolve();
  function exclusive(step) {
    const result = leaseSteps.then(step);
    leaseSteps = result.catch(() => {});
    return result;
  }

  /** Gives the lease back unless this worker still has a crawl job running. Inside `exclusive` only. */
  async function settleLease(workerId) {
    const running = await jobs.countDocuments(
      { agent: CRAWLER_AGENT, status: JOB_STATUS.running, leaseOwner: workerId },
      { limit: 1 },
    );
    // The pin stays: the run is not finished because this worker has stopped working on it.
    if (!running) await crawlLocks.updateOne({ _id: CRAWL_LEASE_ID, owner: workerId }, { $unset: { owner: "", leaseUntil: "" } });
  }

  /** Settles the lease after one of this worker's jobs has stopped running, if it was a crawl job. */
  async function afterStopped(workerId, job) {
    if (crawlLocks && job.agent === CRAWLER_AGENT) await exclusive(() => settleLease(workerId));
  }

  /**
   * Takes the crawl lease for this worker, or keeps it, and says which run it pins.
   *
   * @returns {Promise<import("mongodb").ObjectId|null|undefined>} the pinned run; null when the
   *   lease is this worker's and no crawl has work; undefined when somebody else holds it
   */
  async function pinCrawlRun({ workerId, leaseMs }) {
    const current = now();
    let lease;
    try {
      lease = await crawlLocks.findOneAndUpdate(
        { _id: CRAWL_LEASE_ID, $or: [{ owner: { $exists: false } }, { leaseUntil: { $lte: current } }, { owner: workerId }] },
        { $set: { owner: workerId, leaseUntil: new Date(current.getTime() + leaseMs) } },
        { upsert: true, returnDocument: "after" },
      );
    } catch (error) {
      // Held by another worker or a borrower: the filter matched nothing, and the upsert collided
      // with the document that is there.
      if (error.code !== 11000) throw error;
      return undefined;
    }
    const active = { agent: CRAWLER_AGENT, status: { $in: [JOB_STATUS.pending, JOB_STATUS.running] } };
    // Keep the run through retries and follow-up enqueueing. A second site only starts once
    // every job of the current run has reached a terminal state.
    let head = lease.runId ? await jobs.findOne({ ...active, runId: lease.runId }, { projection: { runId: 1 } }) : null;
    // The lease serializes crawl runs, so only a job that belongs to one can be the head.
    head ??= await jobs.findOne({ ...active, runId: { $ne: null } }, { sort: { createdAt: 1, _id: 1 }, projection: { runId: 1 } });
    const crawlRun = head?.runId ?? null;
    if (String(lease.runId ?? "") !== String(crawlRun ?? "")) {
      await crawlLocks.updateOne({ _id: CRAWL_LEASE_ID, owner: workerId }, { $set: { runId: crawlRun } });
    }
    return crawlRun;
  }

  /**
   * The claim itself: one update that moves the best ready job in scope from pending to running.
   *
   * The clock is read here and not when the claim began. A claim that runs the crawler has by
   * now waited its turn for the lease and asked which run it pins, and a job's `startedAt` is
   * when it was taken: stamped any earlier, the first job of a run could appear to start before
   * the last job of the run ahead of it had finished.
   */
  function take({ scope, workerId, leaseMs }) {
    const current = now();
    return jobs.findOneAndUpdate(
      {
        status: JOB_STATUS.pending,
        ...scope,
        availableAt: { $lte: current },
      },
      {
        $set: {
          status: JOB_STATUS.running,
          leaseOwner: workerId,
          leaseUntil: new Date(current.getTime() + leaseMs),
          startedAt: current,
          updatedAt: current,
        },
        $inc: { attempts: 1 },
      },
      { sort: { priority: 1, availableAt: 1 }, returnDocument: "after" },
    );
  }

  return {
    /**
     * Adds one job, or returns the identical job already in flight.
     *
     * `idempotencyKey` makes enqueueing safe to repeat: a scheduler that fires twice, or a
     * retried API call, produces one job rather than duplicate crawls of the same URL. The key
     * constrains only *in-flight* work, so the same key can be enqueued again once the previous
     * job finished — which is exactly what a recurring crawl needs.
     *
     * @param {object} input validated job description
     * @param {string} input.agent registered agent name
     * @param {string} input.type handler name within that agent
     * @param {object} [input.payload] handler input; must serialize under 64 KiB
     * @param {string|ObjectId} [input.runId] owning run
     * @param {string|ObjectId} [input.siteId] site the work belongs to
     * @param {string|ObjectId} [input.workspaceId] owning workspace, for authorization scoping
     * @param {number} [input.priority=5] 0 (soonest) through 9 (last)
     * @param {Date} [input.availableAt] earliest execution time; defaults to now
     * @param {string} [input.idempotencyKey] in-flight uniqueness key
     * @param {number} [input.maxAttempts=5] attempts before the job is dead-lettered
     * @returns {Promise<{job: object, created: boolean}>} `created` is false on a duplicate
     * @throws {AgentError} `INVALID_JOB` when any field is missing, malformed, or out of range
     */
    async enqueue(input) {
      const job = buildJobDocument(input, now());
      try {
        const result = await jobs.insertOne(job);
        return { job: { ...job, _id: result.insertedId }, created: true };
      } catch (error) {
        if (error?.code !== 11000) throw error;
        // A concurrent enqueue won the unique index. The winner is the job the caller wanted.
        const existing = await jobs.findOne({
          agent: job.agent,
          idempotencyKey: job.idempotencyKey,
          active: { $exists: true },
        });
        if (existing) return { job: existing, created: false };
        // The winner reached a terminal state between the failed insert and this read, so the
        // key is free again and retrying is correct rather than an infinite loop.
        const retry = await jobs.insertOne(job);
        return { job: { ...job, _id: retry.insertedId }, created: true };
      }
    },

    /**
     * Adds many jobs in one write, leaving out any whose key is already in flight.
     *
     * This is how a job's follow-up work is queued. A crawled page names every page it links to,
     * dozens at a time, and early in a crawl nearly all of them are queued already: one insert
     * per follow-up, each duplicate answered with a failed insert and a lookup, was some ninety
     * round trips a page. Here it is one, and the partial unique index on the key refuses the
     * duplicates inside it.
     *
     * A refused document is not looked up and not tried again, unlike {@link enqueue}. The caller
     * wanted the work done, not a handle on the job, and a key that was in flight a moment ago
     * names work that is being done or has just been.
     *
     * The inserts are unordered, so a duplicate does not stop the ones after it, and so nothing
     * may depend on the order they become visible in: a job that must not start before the rest
     * of its batch exists has to check for the job that queued it.
     *
     * @param {object[]} inputs job descriptions, each as {@link enqueue} takes one
     * @returns {Promise<{created: number, duplicates: number}>}
     * @throws {AgentError} `INVALID_JOB` when any description is invalid; nothing is then written
     */
    async enqueueMany(inputs) {
      if (!inputs.length) return { created: 0, duplicates: 0 };
      const current = now();
      const documents = inputs.map((input) => buildJobDocument(input, current));
      try {
        const result = await jobs.insertMany(documents, { ordered: false });
        return { created: result.insertedCount, duplicates: 0 };
      } catch (error) {
        // The driver reports every refused document of an unordered insert together. Only a
        // batch whose refusals were all the idempotency index is a success with duplicates in it.
        const refused = [error?.writeErrors ?? []].flat();
        if (!refused.length || refused.some((entry) => entry.code !== 11000)) throw error;
        return {
          created: error.result?.insertedCount ?? documents.length - refused.length,
          duplicates: refused.length,
        };
      }
    },

    /**
     * Atomically claims the next ready job for one worker, or returns null when none is ready.
     *
     * The update is the claim: two workers running this concurrently cannot receive the same
     * document, because only one `findOneAndUpdate` can transition it out of `pending`.
     *
     * A worker that runs the crawler first takes or keeps the crawl lease, and is offered the
     * pinned run's jobs beside every other agent's. A worker that cannot have the lease is
     * offered the other agents' jobs only.
     *
     * @param {object} options claim scope
     * @param {string[]} options.agents agent names this worker can execute
     * @param {string} options.workerId identity recorded as the lease owner
     * @param {number} options.leaseMs how long the claim is valid without a heartbeat
     * @returns {Promise<object|null>} the claimed job, already marked `running`
     */
    async claim({ agents, workerId, leaseMs }) {
      if (!crawlLocks || !agents.includes(CRAWLER_AGENT)) {
        return take({ scope: { agent: { $in: agents } }, workerId, leaseMs });
      }
      const otherAgents = agents.filter((agent) => agent !== CRAWLER_AGENT);
      return exclusive(async () => {
        const crawlRun = await pinCrawlRun({ workerId, leaseMs });
        const claimed = await take({
          scope: {
            $or: [
              { agent: { $in: otherAgents } },
              ...(crawlRun ? [{ agent: CRAWLER_AGENT, runId: crawlRun }] : []),
            ],
          },
          workerId,
          leaseMs,
        });
        // The lease is for running crawl jobs. Having taken or kept it and claimed something
        // else, or nothing, the worker holds on to it only if a crawl job of its own is still
        // running; otherwise another worker, or a borrower, may have it.
        if (crawlRun !== undefined && claimed?.agent !== CRAWLER_AGENT) await settleLease(workerId);
        return claimed;
      });
    },

    /**
     * Says when the next job waiting out a delay becomes ready, for the agents a worker runs.
     *
     * A worker that found nothing to claim would otherwise learn of such a job only at its next
     * poll: a retry due in a moment, or a step re-queued to look again in a quarter of a second,
     * would sit ready for most of a second with the worker asleep beside it.
     *
     * Only jobs not yet ready are considered. One that is ready and was not claimed is one this
     * worker cannot have — a crawl job while another worker holds the crawl lease — and waking
     * for it again would be a loop.
     *
     * @param {object} options
     * @param {string[]} options.agents agent names this worker can execute
     * @returns {Promise<Date|null>} null when nothing is waiting out a delay
     */
    async nextReadyAt({ agents }) {
      const next = await jobs.findOne(
        { status: JOB_STATUS.pending, availableAt: { $gt: now() }, agent: { $in: agents } },
        { sort: { availableAt: 1 }, projection: { availableAt: 1 } },
      );
      return next?.availableAt ?? null;
    },

    /**
     * Extends a lease while work is still in progress.
     *
     * Long crawls outlive any sane lease length, so the alternative to heartbeating is a lease
     * long enough to cover the worst case — which would also delay recovery from a real crash
     * by that same worst case.
     *
     * @returns {Promise<boolean>} false when the lease was already lost to a reclaim
     */
    async heartbeat({ jobId, workerId, leaseMs }) {
      const current = now();
      const leaseUntil = new Date(current.getTime() + leaseMs);
      const job = await jobs.findOneAndUpdate(
        { _id: toObjectId(jobId), status: JOB_STATUS.running, leaseOwner: workerId },
        { $set: { leaseUntil, updatedAt: current } },
        { projection: { agent: 1 } },
      );
      // Any crawl job this worker is running keeps the crawl lease alive, and only a crawl job
      // does: a lease left behind with no crawl job under it must be able to lapse, however busy
      // the worker is with other work.
      if (job?.agent === CRAWLER_AGENT && crawlLocks) {
        await crawlLocks.updateOne({ _id: CRAWL_LEASE_ID, owner: workerId }, { $set: { leaseUntil } });
      }
      return Boolean(job);
    },

    /**
     * Marks a job succeeded and frees its idempotency key.
     *
     * Every terminal transition is scoped to `leaseOwner`. A worker that stalled past its lease
     * has had the job reclaimed and possibly re-executed elsewhere; letting its late result land
     * would overwrite the current owner's outcome with stale data.
     *
     * @returns {Promise<boolean>} false when this worker no longer owned the job
     */
    async complete({ jobId, workerId, counters }) {
      const current = now();
      const job = await jobs.findOneAndUpdate(
        { _id: toObjectId(jobId), status: JOB_STATUS.running, leaseOwner: workerId },
        {
          $set: {
            status: JOB_STATUS.succeeded,
            finishedAt: current,
            updatedAt: current,
            counters: counters ?? {},
            lastError: null,
          },
          $unset: { active: "", leaseOwner: "", leaseUntil: "" },
        },
        { projection: { agent: 1 } },
      );
      if (job) await afterStopped(workerId, job);
      return Boolean(job);
    },

    /**
     * Records a failure, then either schedules a retry or dead-letters the job.
     *
     * A dead-lettered job stays in the collection with its final error rather than being
     * deleted, because "which URLs did we give up on, and why" is itself a reportable finding.
     *
     * A retryable failure that says it consumed no attempt — a job put off because its host is
     * inside a hold — goes back with the attempt its claim counted taken off again, and is never
     * dead-lettered for it: the job has not been tried.
     *
     * @param {object} options failure detail
     * @param {{code: string, message: string, retryable: boolean, retryAfterMs?: number,
     *   consumesAttempt?: boolean}} options.failure classified failure from {@link classifyFailure}
     * @returns {Promise<{status: string, attempts: number, availableAt: Date | null,
     *   putOff?: boolean} | null>} null when this worker no longer owned the job; `putOff` when
     *   the job went back without having been tried
     */
    async fail({ jobId, workerId, failure }) {
      const current = now();
      const job = await jobs.findOne({ _id: toObjectId(jobId) });
      if (!job || job.status !== JOB_STATUS.running || job.leaseOwner !== workerId) return null;

      const putOff = failure.retryable && failure.consumesAttempt === false;
      const exhausted = !putOff && job.attempts >= job.maxAttempts;
      const willRetry = failure.retryable && !exhausted;
      const lastError = { code: failure.code, message: failure.message, at: current };

      if (!willRetry) {
        await jobs.updateOne(
          { _id: job._id, leaseOwner: workerId },
          {
            $set: { status: JOB_STATUS.failed, finishedAt: current, updatedAt: current, lastError },
            $unset: { active: "", leaseOwner: "", leaseUntil: "" },
          },
        );
        await afterStopped(workerId, job);
        return { status: JOB_STATUS.failed, attempts: job.attempts, availableAt: null };
      }

      const availableAt = new Date(
        current.getTime() + (failure.retryAfterMs ?? backoffMs(job.attempts, random)),
      );
      await jobs.updateOne(
        { _id: job._id, leaseOwner: workerId },
        {
          $set: { status: JOB_STATUS.pending, availableAt, updatedAt: current, lastError },
          $unset: { leaseOwner: "", leaseUntil: "", startedAt: "" },
          ...(putOff ? { $inc: { attempts: -1 } } : {}),
        },
      );
      await afterStopped(workerId, job);
      return { status: JOB_STATUS.pending, attempts: job.attempts - (putOff ? 1 : 0), availableAt, putOff };
    },

    /**
     * Returns a claimed job to the queue immediately, without counting a failure.
     *
     * Used on graceful shutdown: work interrupted by a deploy is not a failure of that work, so
     * it must not consume an attempt and must not wait out a backoff delay.
     *
     * @returns {Promise<boolean>} false when this worker no longer owned the job
     */
    async release({ jobId, workerId }) {
      const current = now();
      const job = await jobs.findOneAndUpdate(
        { _id: toObjectId(jobId), status: JOB_STATUS.running, leaseOwner: workerId },
        {
          $set: { status: JOB_STATUS.pending, availableAt: current, updatedAt: current },
          $inc: { attempts: -1 },
          $unset: { leaseOwner: "", leaseUntil: "", startedAt: "" },
        },
        { projection: { agent: 1 } },
      );
      if (job) await afterStopped(workerId, job);
      return Boolean(job);
    },

    /**
     * Returns jobs whose lease expired to the queue, dead-lettering those out of attempts.
     *
     * This is the only recovery path for a worker killed with SIGKILL, an OOM, or a lost host.
     * Attempts are already incremented at claim time, so a job that repeatedly kills its worker
     * is dead-lettered rather than crash-looping the fleet forever.
     *
     * @param {number} [limit=100] maximum jobs to recover in one pass
     * @returns {Promise<{reclaimed: number, deadLettered: number}>}
     */
    async reclaimExpired(limit = 100) {
      const current = now();
      const expired = await jobs
        .find({ status: JOB_STATUS.running, leaseUntil: { $lt: current } })
        .limit(limit)
        .toArray();

      let reclaimed = 0;
      let deadLettered = 0;
      for (const job of expired) {
        const lastError = {
          code: "LEASE_EXPIRED",
          message: "Worker stopped extending the lease; the job was recovered.",
          at: current,
        };
        if (job.attempts >= job.maxAttempts) {
          await jobs.updateOne(
            { _id: job._id, status: JOB_STATUS.running, leaseUntil: { $lt: current } },
            {
              $set: { status: JOB_STATUS.failed, finishedAt: current, updatedAt: current, lastError },
              $unset: { active: "", leaseOwner: "", leaseUntil: "" },
            },
          );
          deadLettered += 1;
          continue;
        }
        await jobs.updateOne(
          { _id: job._id, status: JOB_STATUS.running, leaseUntil: { $lt: current } },
          {
            $set: { status: JOB_STATUS.pending, availableAt: current, updatedAt: current, lastError },
            $unset: { leaseOwner: "", leaseUntil: "", startedAt: "" },
          },
        );
        reclaimed += 1;
      }
      return { reclaimed, deadLettered };
    },

    /**
     * Counts a run's jobs by status, for progress reporting and for deciding when a run is over.
     *
     * @param {string|ObjectId} runId owning run
     * @returns {Promise<Record<string, number>>} status name to count, absent statuses omitted
     */
    async countByStatus(runId) {
      const rows = await jobs
        .aggregate([
          { $match: { runId: toObjectId(runId) } },
          { $group: { _id: "$status", count: { $sum: 1 } } },
        ])
        .toArray();
      return Object.fromEntries(rows.map((row) => [row._id, row.count]));
    },
  };
}

/**
 * Validates and canonicalizes one enqueue request into its persisted document.
 *
 * Job payloads originate in user-supplied configuration (seed URLs, path patterns), so they are
 * validated at this boundary before they can reach a handler or a remote host.
 *
 * @throws {AgentError} `INVALID_JOB` listing every rejected field
 */
function buildJobDocument(input, current) {
  const errors = [];
  const agent = requireName(input.agent, "agent", errors);
  const type = requireName(input.type, "type", errors);

  const payload = defaulted(input.payload, {});
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    errors.push("payload must be an object.");
  } else if (byteLength(payload, errors) > MAX_PAYLOAD_BYTES) {
    errors.push(`payload must serialize to at most ${MAX_PAYLOAD_BYTES} bytes.`);
  }

  const priority = defaulted(input.priority, 5);
  if (!Number.isInteger(priority) || priority < 0 || priority > 9) {
    errors.push("priority must be an integer from 0 through 9.");
  }

  const maxAttempts = defaulted(input.maxAttempts, 5);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    errors.push("maxAttempts must be an integer from 1 through 20.");
  }

  const availableAt = defaulted(input.availableAt, current);
  if (!(availableAt instanceof Date) || Number.isNaN(availableAt.getTime())) {
    errors.push("availableAt must be a valid Date.");
  }

  const idempotencyKey = defaulted(input.idempotencyKey, new ObjectId().toHexString());
  if (typeof idempotencyKey !== "string" || !idempotencyKey || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    errors.push(`idempotencyKey must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`);
  }

  const references = {};
  for (const field of ["runId", "siteId", "workspaceId"]) {
    if (input[field] === undefined || input[field] === null) continue;
    if (!isObjectIdLike(input[field])) {
      errors.push(`${field} must be a MongoDB ObjectId.`);
      continue;
    }
    references[field] = toObjectId(input[field]);
  }

  if (errors.length) {
    throw new AgentError({
      code: "INVALID_JOB",
      message: `Invalid job: ${errors.join(" ")}`,
      retryable: false,
    });
  }

  return {
    agent,
    type,
    payload,
    ...references,
    status: JOB_STATUS.pending,
    // Present only while pending or running; the partial unique index keys off its existence.
    active: true,
    priority,
    availableAt,
    attempts: 0,
    maxAttempts,
    idempotencyKey,
    leaseOwner: null,
    leaseUntil: null,
    lastError: null,
    counters: {},
    createdAt: current,
    updatedAt: current,
  };
}

/**
 * Applies a default only when a field was *omitted*.
 *
 * `??` would also swallow an explicit `null`, turning a caller's mistake into a silently valid
 * job. Distinguishing "absent" from "present but null" is what lets validation reject the second
 * case instead of guessing what the caller meant.
 */
function defaulted(value, fallback) {
  return value === undefined ? fallback : value;
}

/** Validates one lowercase dotted identifier such as `crawler` or `crawler.fetch`. */
function requireName(value, field, errors) {
  if (typeof value !== "string" || !NAME_PATTERN.test(value) || value.length > 64) {
    errors.push(`${field} must be a lowercase dotted identifier of at most 64 characters.`);
    return value;
  }
  return value;
}

/** Measures serialized payload size, reporting values MongoDB could not store at all. */
function byteLength(payload, errors) {
  try {
    return Buffer.byteLength(JSON.stringify(payload) ?? "");
  } catch {
    errors.push("payload must be JSON-serializable.");
    return 0;
  }
}

/**
 * Computes the delay before the next attempt: exponential, capped, and jittered.
 *
 * The jitter is not cosmetic. Without it, a host that fails 200 crawl jobs at once has all 200
 * retry at the same instant, reproducing the overload that caused the failure.
 *
 * @param {number} attempts attempts already consumed
 * @param {() => number} random jitter source in `[0, 1)`
 * @returns {number} delay in milliseconds
 */
function backoffMs(attempts, random = Math.random) {
  const exponential = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CEILING_MS);
  const jitter = 0.8 + random() * 0.4;
  return Math.round(exponential * jitter);
}

/** Reports whether a value can be converted to an ObjectId without throwing. */
function isObjectIdLike(value) {
  return value instanceof ObjectId || (typeof value === "string" && ObjectId.isValid(value));
}
