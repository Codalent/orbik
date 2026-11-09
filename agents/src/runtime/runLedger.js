import { toObjectId } from "@orbik/core";
import { ObjectId } from "mongodb";

import { RUN_STATUS, assertTransition, isTerminalRunStatus } from "@orbik/protocol";

import { AgentError } from "./errors.js";

export { RUN_STATUS };

const TRIGGERS = new Set(["manual", "schedule", "event"]);

/**
 * Creates the ledger that records one document per agent execution.
 *
 * A run is the unit a human reasons about ("last night's crawl of example.com"), while a job is
 * the unit a worker executes. Keeping them separate is what lets a crawl of 50,000 URLs be
 * thousands of independently retryable jobs while still reporting as one run with one status,
 * one duration, and one set of counters.
 *
 * The ledger also records the **configuration snapshot** each run used. Crawl settings change
 * over time, and without the snapshot a comparison between two runs cannot distinguish "the site
 * changed" from "we changed how we crawled it" — which would make every trend line untrustworthy.
 *
 * Every status change goes through `assertTransition`, so the lifecycle in `@orbik/protocol` is
 * the only description of what a run may do. A late writer — a worker whose lease expired — is turned into a caught error rather than an overwrite of a
 * result somebody has already been shown.
 *
 * @param {object} options collaborators
 * @param {import("mongodb").Collection} options.runs the `agent_runs` collection
 * @param {() => Date} [options.now] clock; defaults to the system clock
 */
export function createRunLedger({ runs, now = () => new Date() }) {
  return {
    /**
     * Opens a run and returns its persisted document.
     *
     * A run may start in `running` — which is what the crawler's scheduler does, because it
     * enqueues the work in the same breath — or in `queued`, which is what the API does when it
     * accepts a run that the dispatcher has not yet handed to anything. Both are legitimate
     * entry points, so the caller states which.
     *
     * @param {object} input run description
     * @param {string} input.agent agent name
     * @param {number} input.version agent version, recorded so old runs stay interpretable
     * @param {string} input.trigger `manual`, `schedule`, or `event`
     * @param {string} [input.status=running] initial status, `queued` or `running`
     * @param {string} [input.agentSlug] product identity of the agent definition
     * @param {number} [input.agentVersion] the version that definition carried when the run was accepted
     * @param {object} [input.input] validated agent input
     * @param {string} [input.requestKey] caller's Idempotency-Key
     * @param {string|ObjectId} [input.siteId] site being processed
     * @param {string|ObjectId} [input.workspaceId] owning workspace
     * @param {string|ObjectId} [input.scheduleId] schedule that created it
     * @param {string|ObjectId} [input.startedBy] the person whose request this run answers;
     *   absent for a run nobody asked for
     * @param {Date} [input.scheduledFor] time the run was supposed to start
     * @param {object} [input.config] configuration snapshot this run used
     * @returns {Promise<object>} the created run
     * @throws {AgentError} `INVALID_RUN` when any field is missing or malformed
     */
    async start(input) {
      const errors = [];
      if (typeof input.agent !== "string" || !input.agent) errors.push("agent is required.");
      if (!Number.isInteger(input.version) || input.version < 1) {
        errors.push("version must be a positive integer.");
      }
      if (!TRIGGERS.has(input.trigger)) {
        errors.push(`trigger must be one of ${[...TRIGGERS].join(", ")}.`);
      }

      const status = input.status ?? RUN_STATUS.running;
      if (status !== RUN_STATUS.running && status !== RUN_STATUS.queued) {
        errors.push(`status must be ${RUN_STATUS.queued} or ${RUN_STATUS.running}.`);
      }

      const references = {};
      for (const field of ["siteId", "workspaceId", "scheduleId", "startedBy"]) {
        if (input[field] === undefined || input[field] === null) continue;
        if (!isObjectIdLike(input[field])) {
          errors.push(`${field} must be a MongoDB ObjectId.`);
          continue;
        }
        references[field] = toObjectId(input[field]);
      }
      if (errors.length) {
        throw new AgentError({
          code: "INVALID_RUN",
          message: `Invalid run: ${errors.join(" ")}`,
          retryable: false,
        });
      }

      const current = now();
      const run = {
        agent: input.agent,
        version: input.version,
        agentSlug: input.agentSlug ?? input.agent,
        agentVersion: input.agentVersion ?? input.version,
        trigger: input.trigger,
        ...references,
        status,
        input: input.input ?? {},
        result: null,
        config: input.config ?? {},
        counters: {},
        usage: null,
        cancelRequestedAt: null,
        scheduledFor: input.scheduledFor ?? null,
        error: null,
        startedAt: current,
        finishedAt: null,
        durationMs: null,
        updatedAt: current,
      };
      // Absent rather than null, so the partial unique index constrains only the runs that
      // actually carry a key: a scheduled run has nobody to retry it and needs none.
      if (input.requestKey !== undefined && input.requestKey !== null) {
        run.requestKey = input.requestKey;
      }

      const result = await runs.insertOne(run);
      return { ...run, _id: result.insertedId };
    },

    /**
     * Adds to a run's counters without reading them first.
     *
     * Counters are incremented with `$inc` rather than written wholesale because many workers
     * report progress on the same run concurrently; a read-modify-write would silently lose
     * every increment that lands between another worker's read and its write.
     *
     * @param {string|ObjectId} runId run to update
     * @param {Record<string, number>} counters counter name to delta
     */
    async increment(runId, counters) {
      const deltas = Object.entries(counters ?? {}).filter(([, value]) => Number.isFinite(value));
      if (!deltas.length) return;
      await runs.updateOne(
        { _id: toObjectId(runId) },
        {
          $inc: Object.fromEntries(deltas.map(([name, value]) => [`counters.${name}`, value])),
          $set: { updatedAt: now() },
        },
      );
    },

    /**
     * Records that somebody asked for a run to stop.
     *
     * Cancellation is a *request*, not a state change, because the thing that must stop is a
     * provider call or a subprocess on another machine. The run reaches `cancelled` only once
     * whatever was executing it confirms it stopped — otherwise the interface would report a
     * finished run while a model kept generating and kept costing money.
     *
     * @param {string|ObjectId} runId run to cancel
     * @returns {Promise<object|null>} the updated run, or null when it was already terminal
     */
    async requestCancel(runId) {
      const current = now();
      return runs.findOneAndUpdate(
        { _id: toObjectId(runId), status: { $nin: [...TERMINAL] } },
        { $set: { cancelRequestedAt: current, updatedAt: current } },
        { returnDocument: "after" },
      );
    },

    /** Reports whether a run has been asked to stop, for a worker checking between steps. */
    async isCancelRequested(runId) {
      const run = await runs.findOne(
        { _id: toObjectId(runId) },
        { projection: { cancelRequestedAt: 1 } },
      );
      return Boolean(run?.cancelRequestedAt);
    },

    /**
     * Closes a run in a terminal state. Already-finished runs are left untouched, so a duplicate
     * completion signal cannot rewrite a recorded outcome or its duration.
     *
     * @param {string|ObjectId} runId run to close
     * @param {string} status one of {@link RUN_STATUS} that is terminal
     * @param {object} [outcome] what the run produced
     * @param {{code: string, message: string}} [outcome.error] failure detail for a failed run
     * @param {object} [outcome.result] agent output for a successful run
     * @param {object} [outcome.usage] provider usage the run accumulated
     * @returns {Promise<object|null>} the closed run, or null when it was already terminal
     */
    async finish(runId, status, outcome = {}) {
      if (!isTerminalRunStatus(status)) {
        throw new AgentError({
          code: "INVALID_RUN",
          message: "Invalid run: a run can only be closed in a terminal status.",
          retryable: false,
        });
      }

      const current = now();
      const run = await runs.findOne({ _id: toObjectId(runId) });
      if (!run || isTerminalRunStatus(run.status)) return null;
      assertTransition(run.status, status);

      return runs.findOneAndUpdate(
        { _id: run._id, status: run.status },
        {
          $set: {
            status,
            error: outcome.error ?? null,
            result: outcome.result ?? null,
            usage: outcome.usage ?? null,
            finishedAt: current,
            durationMs: current.getTime() - run.startedAt.getTime(),
            updatedAt: current,
          },
        },
        { returnDocument: "after" },
      );
    },

    /**
     * Counts a workspace's runs of one agent that have not finished.
     *
     * Used to refuse an overlapping run: two runs of one agent over one workspace would race to
     * write the same result, and the second one adds nothing but cost.
     *
     * @param {object} scope what to count
     * @param {string|ObjectId} scope.workspaceId owning workspace
     * @param {string} scope.agentSlug agent to count
     */
    async countActive({ workspaceId, agentSlug }) {
      return runs.countDocuments({
        workspaceId: toObjectId(workspaceId),
        agentSlug,
        status: { $nin: [...TERMINAL] },
      });
    },

    /** Returns one run by identifier, or null when it does not exist. */
    async find(runId) {
      if (!isObjectIdLike(runId)) return null;
      return runs.findOne({ _id: toObjectId(runId) });
    },
  };
}

/** Terminal statuses, materialized once for the `$nin` filter that cancellation uses. */
const TERMINAL = Object.freeze([RUN_STATUS.succeeded, RUN_STATUS.failed, RUN_STATUS.cancelled]);

/** Reports whether a value can be converted to an ObjectId without throwing. */
function isObjectIdLike(value) {
  return value instanceof ObjectId || (typeof value === "string" && ObjectId.isValid(value));
}
