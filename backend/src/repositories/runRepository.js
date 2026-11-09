import { toObjectId } from "@orbik/core";
import { ObjectId } from "mongodb";

/**
 * Converts an agent run to its public summary.
 *
 * The two timestamps are both here on purpose: `scheduledFor` is when a run was due and
 * `startedAt` is when it was recorded, and a scheduler that fell behind shows up as the gap.
 */
export function toRunSummary(run) {
  return {
    id: run._id.toHexString(),
    agentSlug: run.agentSlug,
    agentVersion: run.agentVersion,
    status: run.status,
    trigger: run.trigger,
    scheduledFor: run.scheduledFor ? run.scheduledFor.toISOString() : null,
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    durationMs: run.durationMs ?? null,
    cancelRequested: Boolean(run.cancelRequestedAt),
    error: run.error ? { code: run.error.code, message: run.error.message } : null,
    input: run.input ?? {},
    outcome: toOutcome(run.result),
  };
}

/** The headline of a result, for a list that must not carry twenty full reports. */
const OUTCOME_FIELDS = Object.freeze(["mode", "target", "card", "branch", "scores", "improvement", "pullRequest", "summary"]);

/**
 * Reduces a result to the fields a list row shows, or null when there is no result.
 *
 * Keyed by well-known names rather than by agent, so any agent whose result carries a `summary`
 * gets a headline for free and the list stays one shape. A result that carries `cards` — one
 * report per card worked — keeps each card's headline the same way, without its loops and
 * audits.
 */
function toOutcome(result) {
  if (!result || typeof result !== "object") return null;
  const outcome = pick(result, OUTCOME_FIELDS);
  if (Array.isArray(result.cards)) {
    outcome.cards = result.cards.slice(0, 10).map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const { report, ...rest } = entry;
      return report && typeof report === "object" ? { ...rest, report: pick(report, OUTCOME_FIELDS) } : rest;
    });
  }
  return Object.keys(outcome).length ? outcome : null;
}

/** Copies the named fields that are present. */
function pick(source, fields) {
  const copy = {};
  for (const field of fields) {
    if (source[field] !== undefined) copy[field] = source[field];
  }
  return copy;
}

/** Converts a run to the detailed shape one run's own page renders, including its result. */
export function toRunDetail(run) {
  return { ...toRunSummary(run), result: run.result ?? null };
}

/** Converts a stored progress event to its public shape. */
export function toRunEvent(event) {
  return {
    seq: event.seq,
    type: event.type,
    at: event.at.toISOString(),
    ...event.data,
  };
}

/**
 * Creates workspace-scoped access to agent runs and their progress events.
 *
 * The API creates runs here and reads them; it never moves one to `running`, never writes a
 * result. Those belong to the processes that actually execute work, and
 * an HTTP handler writing them would race a worker over the same row.
 *
 * @param {object} collections agent-owned collections from `@orbik/core`
 */
export function createRunRepository(collections) {
  const { runs, runEvents, jobs } = collections;

  return {
    /**
     * Creates one run, or returns the run an identical earlier request already created.
     *
     * The caller's `Idempotency-Key` is stored on the run under a partial unique index, so a
     * retried request — a flaky connection, a double-clicked button — returns the first run
     * rather than starting a second one.
     *
     * @returns {Promise<{run: object, created: boolean}>}
     */
    async createIdempotent(input) {
      const now = new Date();
      const document = {
        agent: "ai",
        version: 1,
        agentSlug: input.agentSlug,
        agentVersion: input.agentVersion,
        trigger: "manual",
        workspaceId: toObjectId(input.workspaceId),
        siteId: input.siteId ? toObjectId(input.siteId) : null,
        status: "queued",
        input: input.input,
        result: null,
        config: {},
        counters: {},
        usage: null,
        cancelRequestedAt: null,
        scheduledFor: now,
        scheduleId: null,
        error: null,
        startedAt: now,
        finishedAt: null,
        durationMs: null,
        updatedAt: now,
        requestKey: input.requestKey,
        // Who asked for it. Read by the worker for the one agent that writes as the person who
        // asked — the chat in the side panel — and otherwise a record.
        requestedBy: input.requestedBy ? toObjectId(input.requestedBy) : null,
        // Who started it, for the record a workspace several people share keeps: Activity names
        // them. The same person as `requestedBy` for every run the API accepts; a run the
        // scheduler or the worker starts has nobody.
        startedBy: input.startedBy ? toObjectId(input.startedBy) : null,
      };

      try {
        const result = await runs.insertOne(document);
        return { run: { ...document, _id: result.insertedId }, created: true };
      } catch (error) {
        if (error?.code !== 11000) throw error;
        const existing = await runs.findOne({
          workspaceId: document.workspaceId,
          requestKey: input.requestKey,
        });
        // A duplicate key with nothing to find would mean the index caught something else
        // entirely, and silently retrying could create the second run this guard exists to
        // prevent.
        if (!existing) throw error;
        return { run: existing, created: false };
      }
    },

    /**
     * The most recently started run of one agent in a workspace, or null when it has none.
     *
     * Any status unless one is named: "last updated" and the last failure read the newest run
     * whatever it did, while "when did this agent last finish" asks for `succeeded`.
     */
    async findLatest({ workspaceId, agentSlug, status }) {
      const filter = { workspaceId: toObjectId(workspaceId), agentSlug };
      if (status) filter.status = status;
      const [run] = await runs.find(filter).sort({ startedAt: -1 }).limit(1).toArray();
      return run ?? null;
    },

    /**
     * The first run of one agent in a workspace that ended in `status`, or null when none has.
     *
     * The Home page's "Library written" step is done from the first write run that finished, and
     * says when; the newest run says nothing about when setup was over.
     */
    async findEarliest({ workspaceId, agentSlug, status }) {
      const [run] = await runs
        .find({ workspaceId: toObjectId(workspaceId), agentSlug, status })
        .sort({ startedAt: 1 })
        .limit(1)
        .toArray();
      return run ?? null;
    },

    /**
     * How many different files one run has written so far, from its own progress events.
     *
     * Each successful `library.write` reports what it did and to which path ("created
     * /01-company/about", "updated /index"); a refused one reports "failed: …" and is not a file.
     * Counted by distinct path, because the agent often writes the same file twice in a run — the
     * index, the overview — and "14 files" should mean fourteen files. An aggregate rather than
     * `distinct`, which the API's strict Stable API connection does not allow.
     */
    async countWrittenFiles(runId) {
      const rows = await runEvents.aggregate([
        { $match: { runId: toObjectId(runId), type: "tool-completed", "data.tool": "library.write" } },
        { $project: { _id: 0, summary: "$data.summary" } },
      ]).toArray();
      const paths = new Set();
      for (const { summary } of rows) {
        if (typeof summary !== "string" || summary.startsWith("failed")) continue;
        paths.add(summary.slice(summary.indexOf(" ") + 1));
      }
      return paths.size;
    },

    /**
     * Each agent's newest run in one workspace: its status, when it ended and why it failed.
     *
     * What the Home page's "Needs attention" list reads to find an agent whose last attempt
     * failed. One aggregate over the workspace's runs rather than a read per agent, through the
     * `(workspaceId, startedAt)` index.
     *
     * @returns {Promise<Array<{agentSlug: string, status: string, finishedAt: Date|null,
     *   error: {code: string, message: string}|null}>>}
     */
    async latestPerAgent(workspaceId) {
      const rows = await runs.aggregate([
        { $match: { workspaceId: toObjectId(workspaceId) } },
        { $sort: { startedAt: -1 } },
        { $group: { _id: "$agentSlug", status: { $first: "$status" }, finishedAt: { $first: "$finishedAt" }, error: { $first: "$error" } } },
      ]).toArray();
      return rows.map((row) => ({
        agentSlug: row._id,
        status: row.status,
        finishedAt: row.finishedAt ?? null,
        error: row.error ? { code: row.error.code, message: row.error.message } : null,
      }));
    },

    /** Lists a workspace's runs, newest first, optionally filtered by agent or status. */
    async list({ workspaceId, agentSlug, status, limit }) {
      const filter = { workspaceId: toObjectId(workspaceId) };
      if (agentSlug) filter.agentSlug = agentSlug;
      if (status) filter.status = status;
      return runs.find(filter).sort({ startedAt: -1, _id: -1 }).limit(limit).toArray();
    },

    /**
     * Finds one run only when it belongs to the given workspace.
     *
     * Scoped in the query rather than checked afterwards: a run identifier is not an
     * authorization token, and a find-then-compare leaves the row in memory of a caller who was
     * never entitled to it.
     */
    findInWorkspace(workspaceId, runId) {
      if (!ObjectId.isValid(runId)) return null;
      return runs.findOne({ _id: toObjectId(runId), workspaceId: toObjectId(workspaceId) });
    },

    /** Records that a user asked for a run to stop, leaving terminal runs untouched. */
    async requestCancel(workspaceId, runId) {
      const now = new Date();
      return runs.findOneAndUpdate(
        {
          _id: toObjectId(runId),
          workspaceId: toObjectId(workspaceId),
          status: { $nin: ["succeeded", "failed", "cancelled"] },
        },
        { $set: { cancelRequestedAt: now, updatedAt: now } },
        { returnDocument: "after" },
      );
    },

    /**
     * Ends a run that had not started yet, so cancelling a queued run is immediate.
     *
     * A run still `queued` has nothing executing it, so there is nobody to
     * ask to stop and no reason to make the user watch it sit there. A `running` run is left to
     * its worker, which has to abort a provider call before the run is really over.
     */
    async cancelIfNotStarted(workspaceId, runId) {
      const now = new Date();
      return runs.findOneAndUpdate(
        {
          _id: toObjectId(runId),
          workspaceId: toObjectId(workspaceId),
          status: "queued",
        },
        {
          $set: {
            status: "cancelled",
            cancelRequestedAt: now,
            finishedAt: now,
            durationMs: 0,
            updatedAt: now,
          },
        },
        { returnDocument: "after" },
      );
    },

    /** Every agent run that is queued or running, across workspaces. */
    listActiveForWorkspaces(workspaceIds) {
      if (!workspaceIds.length) return [];
      return runs
        .find({ workspaceId: { $in: workspaceIds }, status: { $in: ["queued", "running"] } })
        .sort({ startedAt: -1, _id: -1 })
        .limit(50)
        .toArray();
    },

    /**
     * The workspaces whose pages are being copied into the Library's source layer right now.
     *
     * Asked of the queue because that stage of the Library agent is a job and has no run row: a
     * crawl hands a site over, and a pass at a time the worker copies each page under
     * `/sources/website`. Without this the Library is being written with nothing anywhere saying
     * so.
     *
     * @param {ObjectId[]} workspaceIds
     * @returns {Promise<Array<{workspaceId: ObjectId, startedAt: Date|null}>>} one row per
     *   workspace, with when the oldest pass still in flight began
     */
    async listMirroringWorkspaces(workspaceIds) {
      if (!workspaceIds.length) return [];
      const rows = await jobs.aggregate([
        {
          $match: {
            agent: "library",
            status: { $in: ["pending", "running"] },
            type: "sources.mirror",
            workspaceId: { $in: workspaceIds },
          },
        },
        { $group: { _id: "$workspaceId", startedAt: { $min: "$createdAt" } } },
      ]).toArray();
      return rows.map((row) => ({ workspaceId: row._id, startedAt: row.startedAt ?? null }));
    },

    /**
     * The most recent progress event of each run, so a monitor can say what a run is doing now.
     *
     * @param {ObjectId[]} runIds
     * @returns {Promise<Map<string, object>>} run id to its latest event
     */
    async latestEvents(runIds) {
      if (!runIds.length) return new Map();
      const rows = await runEvents.aggregate([
        { $match: { runId: { $in: runIds } } },
        { $sort: { runId: 1, seq: -1 } },
        { $group: { _id: "$runId", type: { $first: "$type" }, data: { $first: "$data" }, at: { $first: "$at" } } },
      ]).toArray();
      return new Map(rows.map((row) => [row._id.toHexString(), { type: row.type, tool: row.data?.tool ?? null, at: row.at ?? null }]));
    },

    /** Reads a run's progress events after a sequence number the caller already has. */
    listEvents({ runId, after, limit }) {
      return runEvents
        .find({ runId: toObjectId(runId), seq: { $gt: after } })
        .sort({ seq: 1 })
        .limit(limit)
        .toArray();
    },
  };
}
