/**
 * Every data migration, oldest first.
 *
 * A migration is a change to what is already stored that new code depends on: a field renamed, a
 * shape changed, a collection split. Indexes are not migrations — each process creates its own at
 * start (`ensureIndexes`, `ensureAgentIndexes`) — and neither is anything the code already reads
 * both ways.
 *
 * To add one, append an entry:
 *
 * ```js
 * {
 *   id: "2026-11-02-rename-crawl-site-seed",   // a date, then what it does; never reused or renamed
 *   description: "Rename crawl_sites.seed to seedUrl.",
 *   async up({ database, logger }) {
 *     await database.collection("crawl_sites").updateMany(
 *       { seed: { $exists: true }, seedUrl: { $exists: false } },
 *       [{ $set: { seedUrl: "$seed" } }, { $unset: "seed" }],
 *     );
 *   },
 * }
 * ```
 *
 * `up` must be safe to run twice: a process that dies after the change and before it is recorded
 * runs it again on its next start. Filter on the old shape, as above, rather than assuming it.
 * A migration is never edited once released — a mistake is corrected by a new one — because an
 * install that already ran it will not run it again.
 *
 * @type {Array<{id: string, description: string,
 *   up: (context: {database: import("mongodb").Db, logger: Function}) => Promise<void>}>}
 */
export const MIGRATIONS = [
  {
    id: "2026-11-09-retire-seo-agents",
    description: "Remove the schedules, setups, queued runs and pending sync jobs of the SEO agents that left the open-source release.",
    async up({ database, logger }) {
      const agentSlug = { $in: RETIRED_AGENT_SLUGS };
      const [schedules, setups, runs, jobs] = await Promise.all([
        database.collection("agent_schedules").deleteMany({ agentSlug }),
        database.collection("agent_setups").deleteMany({ agentSlug }),
        // Only queued runs: one already running is left to finish or fail on its own, and every
        // finished run stays in Activity and the AI call log as the record of what happened.
        database.collection("agent_runs").deleteMany({ agentSlug, status: "queued" }),
        // The Search Console sync was a queue agent of its own; nothing claims its jobs now.
        database.collection("agent_jobs").deleteMany({ agent: "search-console", status: "pending" }),
      ]);
      logger("info", "migrations.retired_seo_agents", {
        schedules: schedules.deletedCount,
        setups: setups.deletedCount,
        queuedRuns: runs.deletedCount,
        pendingJobs: jobs.deletedCount,
      });
    },
  },
  {
    id: "2026-11-13-crawl-budget-per-workspace",
    description: "Keep the crawl budget per workspace: drop the per-account index, and give the months of an account that owns one workspace to it.",
    async up({ database, logger }) {
      const periods = database.collection("crawl_budget_periods");
      try {
        await periods.dropIndex("crawl_budget_periods_user_period_unique");
      } catch (error) {
        // IndexNotFound (27) and NamespaceNotFound (26): dropped already, or never made.
        if (error?.code !== 27 && error?.code !== 26) throw error;
      }

      // An account with one workspace spent its months on that workspace, so they become its
      // months and the current one keeps what is left of it. An account with several cannot be
      // split after the fact: its months stay as they are, readable as the account's history, and
      // each of its workspaces starts the current month afresh with its plan's allowance.
      let moved = 0;
      let kept = 0;
      // An aggregation, not `distinct`: the connection uses MongoDB's strict API version 1, which
      // does not include `distinct`.
      const owners = await periods.aggregate([
        { $match: { workspaceId: { $exists: false } } },
        { $group: { _id: "$userId" } },
      ]).toArray();
      for (const { _id: ownerId } of owners) {
        const owned = await database.collection("workspaces")
          .find({ ownerId }, { projection: { _id: 1 } })
          .limit(2)
          .toArray();
        const months = await periods.find({ userId: ownerId, workspaceId: { $exists: false } }, { projection: { _id: 1 } }).toArray();
        if (owned.length !== 1) {
          kept += months.length;
          continue;
        }
        for (const { _id } of months) {
          try {
            await periods.updateOne({ _id, workspaceId: { $exists: false } }, { $set: { workspaceId: owned[0]._id } });
            moved += 1;
          } catch (error) {
            // The workspace has that month already (a process wrote it before this ran): the
            // older row stays as history.
            if (error?.code !== 11000) throw error;
            kept += 1;
          }
        }
      }
      logger("info", "migrations.crawl_budget_per_workspace", { moved, kept });
    },
  },
];

/**
 * The agents that left the open-source release in November 2026, by slug, as their schedules,
 * setups and runs were stored. Their collections are not dropped (see `RETIRED_COLLECTIONS` in
 * `@orbik/core` and docs/self-hosting/backups-and-upgrades.md).
 */
const RETIRED_AGENT_SLUGS = Object.freeze([
  "change-watch",
  "technical-seo-audit",
  "title-meta-rewriter",
  "internal-linking",
  "redirect-map",
  "structured-data",
  "cannibalisation",
  "ai-crawler-readiness",
  "competitor-topic-gap",
  "image-alt-text",
  "search-console",
  "lighthouse-page-speed",
]);
