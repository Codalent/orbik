import { findAgentDefinition } from "@orbik/agent-definitions";
import { ON_REQUEST_AGENT_SLUGS, UPSTREAM_AGENT_SLUGS, log } from "@orbik/core";
import { RUN_STATUS } from "@orbik/protocol";

import { AI_AGENT } from "../jobs.js";
import { createLoop } from "../runtime/loop.js";

/** How many schedules one pass may fire, so a backlog cannot flood the queue at once. */
const MAX_SCHEDULES_PER_PASS = 50;

/**
 * Creates the loop that turns "audit this site every week" into queued runs.
 *
 * It is a near-twin of the crawl scheduler, and deliberately so: the same atomic
 * claim-and-advance, the same reason for advancing the due time *before* the work is created
 * rather than after it finishes. A run that crashed halfway must not be able to block its schedule
 * forever, because nothing would remain to move the schedule forward.
 *
 * @param {object} options collaborators
 * @param {import("mongodb").Collection} options.schedules the `agent_schedules` collection
 * @param {ReturnType<import("../runtime/runLedger.js").createRunLedger>} options.ledger run ledger
 * @param {object} options.config validated agent environment
 * @param {(level: string, message: string, context?: object) => void} [options.logger]
 * @param {() => Date} [options.now] clock; defaults to the system clock
 */
export function createAgentScheduler({
  schedules,
  ledger,
  config,
  logger = log,
  now = () => new Date(),
}) {
  const loop = createLoop({
    name: "agent_scheduler",
    intervalMs: config.schedulerIntervalMs,
    tick: () => scheduler.tick(),
    logger,
  });

  /**
   * Atomically claims the schedule that has been due longest, advancing it in the same write.
   *
   * Expressed as an aggregation pipeline so the next due time is computed from the schedule's own
   * cadence inside the update. Reading the interval first and writing second would reopen exactly
   * the race this claim exists to close.
   *
   * Agents started by the work upstream of them are left out by name. The Library is one: its row
   * here is only its on-off switch, and `library/libraryScheduler.js` reads it; an agent an event
   * starts would be another, read by `./outboxScheduler.js`. Excluding by name rather than by an absent due time
   * matters, because a row written while the Library was still weekly carries a due time that
   * would otherwise fire.
   *
   * Agents only a person starts are left out the same way: such an agent spends something a person
   * has to agree to each time, so no row in this collection may start it, whatever wrote the row.
   */
  async function claimDueSchedule(current) {
    return schedules.findOneAndUpdate(
      { enabled: true, nextRunAt: { $lte: current }, agentSlug: { $nin: [...UPSTREAM_AGENT_SLUGS, ...ON_REQUEST_AGENT_SLUGS] } },
      [
        {
          $set: {
            lastScheduledAt: current,
            nextRunAt: {
              $add: [current, { $multiply: [{ $ifNull: ["$intervalHours", 168] }, 3_600_000] }],
            },
          },
        },
      ],
      { sort: { nextRunAt: 1 }, returnDocument: "after" },
    );
  }

  const scheduler = {
    /**
     * Runs one scheduling pass and reports what it created.
     *
     * @returns {Promise<{started: object[], failed: object[]}>}
     */
    async tick() {
      const started = [];
      const failed = [];

      for (let index = 0; index < MAX_SCHEDULES_PER_PASS; index += 1) {
        const current = now();
        const schedule = await claimDueSchedule(current);
        if (!schedule) break;

        // A schedule names a slug, never a version: "audit this weekly" means with whatever the
        // agent is now. The version is recorded on the run, as a label for what it followed.
        const definition = findAgentDefinition(schedule.agentSlug);
        if (!definition) {
          // The agent was removed after somebody scheduled it. The schedule is disabled rather
          // than left to fail every week, and the reason is recorded where a user can see it.
          await schedules.updateOne({ _id: schedule._id }, { $set: { enabled: false, updatedAt: current } });
          failed.push({ scheduleId: schedule._id, reason: "AGENT_NOT_AVAILABLE" });
          logger("warn", "agent_scheduler.agent_unavailable", {
            scheduleId: schedule._id.toHexString(),
            agent: schedule.agentSlug,
          });
          continue;
        }

        // Overlap is refused for the same reason two crawls of one site are: two runs of one agent
        // over one workspace would race to write the same result, and the second adds nothing.
        const active = await ledger.countActive?.({
          workspaceId: schedule.workspaceId,
          agentSlug: schedule.agentSlug,
        });
        if (active) {
          failed.push({ scheduleId: schedule._id, reason: "ALREADY_RUNNING" });
          logger("warn", "agent_scheduler.run_skipped", {
            scheduleId: schedule._id.toHexString(),
            reason: "ALREADY_RUNNING",
          });
          continue;
        }

        // The input is the schedule's, and for every shipped agent that is an empty object: an
        // agent with a page list reads it from its setup at run time, so a page added the day
        // before a scheduled run is read by that run.
        const input = schedule.input ?? {};

        const run = await ledger.start({
          agent: AI_AGENT,
          version: 1,
          agentSlug: definition.slug,
          agentVersion: definition.version,
          trigger: "schedule",
          status: RUN_STATUS.queued,
          input,
          workspaceId: schedule.workspaceId,
          scheduleId: schedule._id,
          scheduledFor: current,
          config: { intervalHours: schedule.intervalHours ?? 168 },
        });

        started.push({ scheduleId: schedule._id, runId: run._id });
        logger("info", "agent_scheduler.run_created", {
          scheduleId: schedule._id.toHexString(),
          runId: run._id.toHexString(),
          agent: definition.slug,
          version: definition.version,
          nextRunAt: schedule.nextRunAt.toISOString(),
        });
      }

      return { started, failed };
    },

    /** Starts scheduling passes until {@link stop} is called. */
    start: loop.start,

    /** Stops scheduling and waits for the pass in progress to finish. */
    stop: loop.stop,
  };
  return scheduler;
}
