import { findAgentDefinition } from "@orbik/agent-definitions";
import { AGENT_COLLECTIONS, log } from "@orbik/core";
import { RUN_STATUS } from "@orbik/protocol";

import { AI_AGENT } from "../jobs.js";
import { createEventOutbox } from "../runtime/eventOutbox.js";
import { createLoop } from "../runtime/loop.js";

/** How many switched-on agents one pass may consider, so a backlog cannot flood the queue at once. */
const MAX_SCHEDULES_PER_PASS = 50;

/**
 * How soon the next pass comes while an agent is working through a backlog.
 *
 * An agent switched on over a site with history has every earlier crawl to report on, and is given
 * them one run at a time. Waiting a whole scheduling interval between each would turn thirty
 * crawls into half an hour of digests arriving one a minute.
 */
const BACKLOG_INTERVAL_MS = 5000;

/**
 * The agents an outbox event starts.
 *
 * Each entry names the agent, the event it waits for, and how to find the agent's **position** in
 * a site's outbox: the last event of that type it has dealt with, or null for none. The position
 * belongs to the agent — it is derived from whatever the agent stores, so "has this been dealt
 * with" and "where to read from next" cannot disagree — and this pass only asks whether an event
 * lies beyond it.
 *
 * **Adding an agent that an event starts is one entry here**, beside a schedule profile with no
 * cadence in `@orbik/core` (which is what makes the API refuse to start it by hand and the
 * schedule loop leave it alone). No agent in this release is started by an event, so the list is
 * empty and each pass returns at once; the loop stays as the place such an agent is added.
 */
const OUTBOX_CONSUMERS = Object.freeze([]);

/**
 * Creates the loop that starts an agent when the event it waits for is in the outbox.
 *
 * The outbox was built so that agents never call each other: the crawler's job ends when
 * `crawl.completed` is durably recorded, and who acts on it, and when, is not its concern. This
 * pass is the first thing that acts on it. Per switched-on agent it asks one question — is there
 * an event of its type beyond its position — and creates one queued run for the first such event,
 * which the dispatcher hands to a worker like any other run.
 *
 * One run per event, in order, and never two at once for one workspace: the run moves the
 * position when it stores its result, so the next event is only worth starting once that has
 * happened. A backlog is therefore drained an event a pass.
 *
 * **Nothing is claimed.** The other schedulers claim what they start with a write on the row they
 * read, because starting twice would do the work twice. Here the work cannot be done twice: an
 * agent's output is keyed on what it is about (one digest per crawl, by a unique index), so a
 * second run for an event finds it dealt with and stops. What two scheduler processes racing would
 * waste is a run row, and that is prevented by the run's own key — the event and the attempt —
 * under the unique index runs already have for retried requests. A crash between any two
 * statements here therefore strands nothing: there is no claim to be left behind.
 *
 * A run that failed is not started again on every pass. It is tried again when there is a reason
 * to expect a different outcome that a person would recognise: a later event of the same type has
 * arrived (the site was crawled again), or somebody paused the agent and set it to work again,
 * which is the one thing a person can do about a failure and is what `workingSince` records.
 *
 * @param {object} options collaborators
 * @param {import("mongodb").Db} options.database connected database
 * @param {ReturnType<import("../runtime/runLedger.js").createRunLedger>} options.ledger run ledger
 * @param {object} options.config validated agent environment
 * @param {ReadonlyArray<object>} [options.consumers] the agents events start; defaults to the ones
 *   that ship
 * @param {(level: string, message: string, context?: object) => void} [options.logger]
 * @param {() => Date} [options.now] clock; defaults to the system clock
 */
export function createOutboxScheduler({
  database,
  ledger,
  config,
  consumers = OUTBOX_CONSUMERS,
  logger = log,
  now = () => new Date(),
}) {
  const schedules = database.collection(AGENT_COLLECTIONS.schedules);
  const sites = database.collection(AGENT_COLLECTIONS.sites);
  const runs = database.collection(AGENT_COLLECTIONS.runs);
  const events = database.collection(AGENT_COLLECTIONS.events);
  const outbox = createEventOutbox({ events });
  const bySlug = new Map(consumers.map((consumer) => [consumer.agentSlug, consumer]));

  // Whether the last pass left an agent mid-backlog: it started a run, or found one in flight
  // with an event still waiting. The next pass then comes sooner.
  let backlog = false;
  const loop = createLoop({
    name: "outbox_scheduler",
    startedContext: { intervalMs: config.schedulerIntervalMs, agents: [...bySlug.keys()] },
    tick: async () => {
      const { started, skipped } = await scheduler.tick();
      backlog = started.length > 0 || skipped.some((entry) => entry.reason === "ALREADY_RUNNING");
    },
    intervalMs: () => (backlog ? Math.min(BACKLOG_INTERVAL_MS, config.schedulerIntervalMs) : config.schedulerIntervalMs),
    logger,
  });

  /** When the newest event of one type was recorded for a site, or null. */
  async function newestEventAt(siteId, type) {
    const [event] = await events.find({ siteId, type }).project({ createdAt: 1 }).sort({ _id: -1 }).limit(1).toArray();
    return event?.createdAt ?? null;
  }

  /**
   * Decides whether one agent has an event to act on, and starts the run when it has.
   *
   * @returns {Promise<{runId?: object, eventId?: object, version?: number, reason?: string}>} the
   *   run it started, or why it did not
   */
  async function consider({ consumer, schedule, siteId }) {
    const { workspaceId } = schedule;
    const { agentSlug } = consumer;

    const position = await consumer.position(database, siteId);
    const [event] = await outbox.read({ siteId, types: [consumer.eventType], after: position ?? undefined, limit: 1 });
    if (!event) return { reason: "UP_TO_DATE" };
    if (await ledger.countActive({ workspaceId, agentSlug })) return { reason: "ALREADY_RUNNING" };

    // The newest run was for this same event and the position has not moved past it: it failed,
    // was stopped, or ended without recording anything. Whatever became of it, it is only tried
    // again for a reason, and once per reason — which is what the attempt in the run's key is.
    const [last] = await runs
      .find({ workspaceId, agentSlug })
      .project({ status: 1, startedAt: 1, "config.eventId": 1 })
      .sort({ startedAt: -1 })
      .limit(1)
      .toArray();
    let attempt = 0;
    if (last?.config?.eventId && event._id.equals(last.config.eventId)) {
      const again = newest(schedule.workingSince, await newestEventAt(siteId, consumer.eventType));
      if (!again || again <= last.startedAt) {
        return { reason: last.status === RUN_STATUS.succeeded ? "NOT_ADVANCED" : "LAST_RUN_FAILED" };
      }
      attempt = again.getTime();
    }

    const definition = findAgentDefinition(agentSlug);
    if (!definition) return { reason: "AGENT_NOT_AVAILABLE" };

    const current = now();
    try {
      const run = await ledger.start({
        agent: AI_AGENT,
        version: 1,
        agentSlug: definition.slug,
        agentVersion: definition.version,
        trigger: "event",
        status: RUN_STATUS.queued,
        // Empty on purpose. What the run reads is decided by its site and its position, so there
        // is nothing here a caller could use to point it anywhere else.
        input: {},
        workspaceId,
        siteId,
        scheduleId: schedule._id,
        scheduledFor: current,
        config: { after: event.type, eventId: event._id, eventRunId: event.runId ?? null },
        // A slash cannot appear in a caller's Idempotency-Key, so no request can take this key.
        requestKey: `outbox/${agentSlug}/${event._id.toHexString()}/${attempt}`,
      });
      await schedules.updateOne({ _id: schedule._id }, { $set: { lastScheduledAt: current } });
      return { runId: run._id, eventId: event._id, version: definition.version };
    } catch (error) {
      // Another scheduler process started the run for this event and attempt first.
      if (error?.code === 11000) return { reason: "ALREADY_STARTED" };
      throw error;
    }
  }

  const scheduler = {
    /**
     * Runs one pass and reports what it started and what it left alone.
     *
     * Exposed separately from {@link start} so an operator can force a sweep without the daemon,
     * and so the decision is readable on its own.
     *
     * @returns {Promise<{started: object[], skipped: object[]}>}
     */
    async tick() {
      const started = [];
      const skipped = [];
      if (!bySlug.size) return { started, skipped };

      // The switch is the schedule row's `enabled`, and only that: these agents have no due time.
      const rows = await schedules
        .find({ agentSlug: { $in: [...bySlug.keys()] }, enabled: true })
        .limit(MAX_SCHEDULES_PER_PASS)
        .toArray();

      for (const schedule of rows) {
        const consumer = bySlug.get(schedule.agentSlug);
        const context = { workspaceId: schedule.workspaceId.toHexString(), agent: schedule.agentSlug };
        // One bad workspace must not stop the pass: the next one reconsiders every agent, so a
        // failure delays that workspace's agent rather than every workspace's.
        try {
          const site = await sites.findOne({ workspaceId: schedule.workspaceId }, { projection: { _id: 1 } });
          if (!site) {
            skipped.push({ ...context, reason: "NEVER_CRAWLED" });
            continue;
          }
          const outcome = await consider({ consumer, schedule, siteId: site._id });
          if (!outcome.runId) {
            skipped.push({ ...context, reason: outcome.reason });
            continue;
          }
          started.push({ ...context, runId: outcome.runId });
          logger("info", "outbox_scheduler.run_created", {
            ...context,
            runId: outcome.runId.toHexString(),
            version: outcome.version,
            event: consumer.eventType,
            eventId: outcome.eventId.toHexString(),
          });
        } catch (error) {
          logger("error", "outbox_scheduler.run_failed", { ...context, message: error.message });
        }
      }
      return { started, skipped };
    },

    /** Starts passes until {@link stop} is called. */
    start: loop.start,

    /** Stops scheduling and waits for the pass in progress to finish. */
    async stop() {
      await loop.stop();
      backlog = false;
    },
  };
  return scheduler;
}

/** The later of two moments, ignoring the ones that are absent. */
function newest(left, right) {
  if (!left) return right ?? null;
  if (!right) return left;
  return left > right ? left : right;
}
