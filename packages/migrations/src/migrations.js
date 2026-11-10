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
