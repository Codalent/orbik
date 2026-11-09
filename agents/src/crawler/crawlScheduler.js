import { log } from "@orbik/core";

import { CRAWLER_AGENT, CRAWLER_JOBS } from "../jobs.js";
import { createLoop } from "../runtime/loop.js";
import { RUN_STATUS } from "../runtime/runLedger.js";

/** How many sites one scheduler pass may start, so a backlog cannot flood the queue at once. */
const MAX_SITES_PER_PASS = 50;

/** Cadence used when a site does not specify one. */
const DEFAULT_CRAWL_INTERVAL_HOURS = 168;

/**
 * Creates the loop that turns "this site is crawled weekly" into queued work.
 *
 * Claiming is what makes this safe to run more than once. A due site is claimed by a single
 * `findOneAndUpdate` that moves its `nextCrawlAt` forward in the same operation that reads it, so
 * two schedulers racing on the same site cannot both start a crawl — the loser finds nothing due.
 * There is no leader election and no lock that could expire while held.
 *
 * The next due time is set **before** the crawl is queued rather than after it finishes. Setting
 * it afterwards would let a crawl that crashed mid-run block its site forever, because nothing
 * would remain to move the schedule forward.
 *
 * @param {object} options collaborators
 * @param {import("mongodb").Collection} options.sites the `crawl_sites` collection
 * @param {import("mongodb").Collection} options.runs the `agent_runs` collection
 * @param {ReturnType<import("../runtime/queue.js").createJobQueue>} options.queue job queue
 * @param {ReturnType<import("../runtime/runLedger.js").createRunLedger>} options.ledger run ledger
 * @param {object} options.config validated agent environment
 * @param {(level: string, message: string, context?: object) => void} [options.logger]
 * @param {() => Date} [options.now] clock; defaults to the system clock
 */
export function createCrawlScheduler({ sites, runs, queue, ledger, config, logger = log, now = () => new Date() }) {
  // A scheduling failure must not stop the daemon: the next pass reconsiders every site, so one
  // bad site delays its own crawl rather than every site's.
  const loop = createLoop({
    name: "scheduler",
    intervalMs: config.schedulerIntervalMs,
    tick: () => scheduler.tick(),
    logger,
  });

  /**
   * Atomically claims the site that has been due longest, or returns null when none is.
   *
   * The update is expressed as an aggregation pipeline so the new `nextCrawlAt` can be computed
   * from the site's own cadence inside the same write. Reading the interval first and updating
   * second would reopen exactly the race this claim exists to close.
   */
  async function claimDueSite(current) {
    return sites.findOneAndUpdate(
      { enabled: { $ne: false }, nextCrawlAt: { $lte: current } },
      [{
        $set: {
          lastScheduledAt: current,
          // Who pressed "Crawl now" or asked for a page, read before the request is cleared
          // below, so the run can say who started it. Removed when the schedule did, so a pass
          // nobody asked for leaves no field and clears the last one's.
          lastScheduledBy: { $ifNull: ["$crawlRequestedBy", "$$REMOVE"] },
          nextCrawlAt: {
            $add: [
              current,
              { $multiply: [{ $ifNull: ["$discoveryIntervalHours", { $ifNull: ["$crawlIntervalHours", DEFAULT_CRAWL_INTERVAL_HOURS] }] }, 3_600_000] },
            ],
          },
        },
      }, {
        // A "Crawl now" is satisfied the moment its site is claimed; the run that follows is
        // what the page shows from here on.
        $unset: ["crawlRequestedAt", "crawlRequestedBy"],
      }],
      { sort: { nextCrawlAt: 1 }, returnDocument: "after" },
    );
  }

  const scheduler = {
    /**
     * Runs one scheduling pass and reports what it started.
     *
     * Exposed separately from {@link start} so an operator can trigger a pass without running the
     * daemon.
     *
     * @returns {Promise<{started: Array<object>, skipped: Array<object>}>}
     */
    async tick() {
      const started = [];
      const skipped = [];

      for (let index = 0; index < MAX_SITES_PER_PASS; index += 1) {
        const current = now();
        const site = await claimDueSite(current);
        if (!site) break;

        // Two overlapping crawls of one site would double its outbound request rate and produce
        // two runs competing to write the same snapshots. The schedule has already moved on, so
        // skipping costs this site one cycle rather than blocking it.
        const active = await runs.countDocuments({
          siteId: site._id,
          agent: CRAWLER_AGENT,
          status: RUN_STATUS.running,
        });
        if (active > 0) {
          skipped.push({ siteId: site._id, reason: "ALREADY_RUNNING" });
          logger("warn", "scheduler.crawl_skipped", { siteId: site._id.toHexString(), reason: "ALREADY_RUNNING" });
          continue;
        }

        const run = await ledger.start({
          agent: CRAWLER_AGENT,
          version: 1,
          trigger: "schedule",
          siteId: site._id,
          workspaceId: site.workspaceId,
          ...(site.lastScheduledBy ? { startedBy: site.lastScheduledBy } : {}),
          config: {
            seedUrl: site.seedUrl,
            crawlIntervalHours: site.crawlIntervalHours ?? DEFAULT_CRAWL_INTERVAL_HOURS,
          },
        });

        await queue.enqueue({
          agent: CRAWLER_AGENT,
          type: CRAWLER_JOBS.discover,
          payload: { siteId: site._id.toHexString() },
          runId: run._id,
          siteId: site._id,
          workspaceId: site.workspaceId,
          priority: 0,
          idempotencyKey: `discover:${run._id.toHexString()}`,
        });

        started.push({ siteId: site._id, runId: run._id });
        logger("info", "scheduler.crawl_started", {
          siteId: site._id.toHexString(),
          runId: run._id.toHexString(),
          nextCrawlAt: site.nextCrawlAt.toISOString(),
        });
      }

      return { started, skipped };
    },

    /** Starts scheduling passes until {@link stop} is called. */
    start: loop.start,

    /** Stops scheduling and waits for the pass in progress to finish. */
    stop: loop.stop,
  };
  return scheduler;
}
