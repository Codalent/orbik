import { AGENT_COLLECTIONS, COLLECTIONS, RETIRED_COLLECTIONS, toObjectId } from "@orbik/core";

import { HOME_PREFERENCES_COLLECTION } from "./homePreferenceRepository.js";

/**
 * Collections whose every row belongs to exactly one workspace, by its `workspaceId`, and which
 * are emptied of a deleted workspace's rows with a plain `deleteMany`.
 *
 * Listed by hand rather than by sweeping every collection for `workspaceId`, because in two
 * collections the field means something else: on `mcp_tokens` and `oauth_grants` it is the single
 * workspace a credential written before sets existed reads, and a re-approved legacy grant keeps
 * it beside a set of several (see `credentialWorkspaces.js`). Those are released, below, not
 * swept. A collection added for per-workspace data belongs on this list.
 *
 * Not here, on purpose:
 * - `crawl_budget_periods` is kept as the record of what the workspace spent, with the owner it
 *   belonged to (`userId`). Nothing reads a deleted workspace's months again.
 * - `rate_limits`, `sessions`, `system_state`, `migrations` and the `oauth_clients`, `_requests`
 *   and `_codes` rows belong to people, clients or the install. A pending authorization request
 *   that named this workspace expires in minutes, and what it issues is intersected with the
 *   workspaces the person can read on every request, which no longer include this one.
 * - The deployment-wide crawl lock (`crawl_queue_locks`) names a worker, not a workspace.
 * - `crawl_sites`, `agent_runs` and `brand_assets` are also per workspace, but other rows are
 *   found through them, so each is removed in its own step after those.
 *
 * The collections agents of earlier releases wrote (`RETIRED_COLLECTIONS`) are on it too: nothing
 * writes them now, but a database that ran those agents still holds the workspace's rows there.
 */
const WORKSPACE_COLLECTIONS = Object.freeze([
  AGENT_COLLECTIONS.schedules,
  AGENT_COLLECTIONS.agentSetups,
  AGENT_COLLECTIONS.designObservations,
  AGENT_COLLECTIONS.designSystems,
  AGENT_COLLECTIONS.designSystemRevisions,
  AGENT_COLLECTIONS.brandChanges,
  AGENT_COLLECTIONS.libraryNodes,
  AGENT_COLLECTIONS.libraryRevisions,
  AGENT_COLLECTIONS.libraryStructures,
  AGENT_COLLECTIONS.sourceDocuments,
  AGENT_COLLECTIONS.knowledgeSources,
  AGENT_COLLECTIONS.llmsDocuments,
  AGENT_COLLECTIONS.knowledgeChunks,
  AGENT_COLLECTIONS.indexState,
  AGENT_COLLECTIONS.sourceNotes,
  AGENT_COLLECTIONS.conversations,
  AGENT_COLLECTIONS.events,
  AGENT_COLLECTIONS.aiCalls,
  COLLECTIONS.workspaceInvites,
  COLLECTIONS.workspaceMembers,
  COLLECTIONS.mcpCalls,
  HOME_PREFERENCES_COLLECTION,
  ...RETIRED_COLLECTIONS.workspace,
]);

/**
 * Collections written by the crawler under the crawl site's identifier, with no `workspaceId` of
 * their own: the URL registry, robots.txt history, snapshots, link graph and page Markdown.
 */
const SITE_COLLECTIONS = Object.freeze([
  AGENT_COLLECTIONS.urls,
  AGENT_COLLECTIONS.robots,
  AGENT_COLLECTIONS.snapshots,
  AGENT_COLLECTIONS.links,
  AGENT_COLLECTIONS.markdown,
]);

/**
 * Collections where some rows are found by the workspace and some only by its crawl site or one
 * of its runs, because the field was optional when they were written (a crawl's events and jobs
 * carry the site; a run's own model calls carry the run), with the retired collections that were
 * written the same way.
 */
const SITE_OR_RUN_COLLECTIONS = Object.freeze([
  AGENT_COLLECTIONS.jobs,
  AGENT_COLLECTIONS.events,
  AGENT_COLLECTIONS.aiCalls,
  ...RETIRED_COLLECTIONS.siteOrRun,
]);

/**
 * The persistence behind deleting a workspace: finding what is still at work in it, and removing
 * every record of it from MongoDB.
 *
 * Every step is a `deleteMany` (or an update that is a no-op the second time), so the whole thing
 * is idempotent: a deletion that fails half way is finished by asking again. The order is what
 * keeps that true. Rows that are only found through another row — the crawler's pages through the
 * crawl site, a run's events through the run — go before the row that finds them; and the caller
 * removes the `workspaces` row itself last, so the workspace stays visible to its owner, and
 * deletable, until everything else is gone.
 *
 * @param {import("mongodb").Db} database
 */
export function createWorkspaceErasureRepository(database) {
  const collection = (name) => database.collection(name);
  const runs = collection(AGENT_COLLECTIONS.runs);
  const jobs = collection(AGENT_COLLECTIONS.jobs);
  const sites = collection(AGENT_COLLECTIONS.sites);

  /** The workspace's crawl sites and runs: what the rows written without a `workspaceId` name. */
  async function scopeOf(workspaceId) {
    const workspace = toObjectId(workspaceId);
    const siteIds = (await sites.find({ workspaceId: workspace }, { projection: { _id: 1 } }).toArray()).map((row) => row._id);
    const runIds = (await runs
      .find({ $or: [{ workspaceId: workspace }, ...(siteIds.length ? [{ siteId: { $in: siteIds } }] : [])] }, { projection: { _id: 1 } })
      .toArray()).map((row) => row._id);
    return { workspace, siteIds, runIds };
  }

  /** `workspaceId` or any of the workspace's sites or runs, for the collections that need it. */
  function anyOf({ workspace, siteIds, runIds }) {
    return {
      $or: [
        { workspaceId: workspace },
        ...(siteIds.length ? [{ siteId: { $in: siteIds } }] : []),
        ...(runIds.length ? [{ runId: { $in: runIds } }] : []),
      ],
    };
  }

  return {
    /**
     * What is being executed for the workspace right now: runs a worker is executing and jobs a
     * worker has claimed. Deleting under them would leave a worker writing pages, notes or
     * reports for a workspace that no longer exists. Queued runs and pending jobs are not
     * counted: nothing is executing them, and the deletion removes them.
     *
     * @returns {Promise<Array<{id: string, agent: string}>>}
     */
    async activeWork(workspaceId) {
      const scope = await scopeOf(workspaceId);
      const [running, claimed] = await Promise.all([
        runs.find({ ...anyOf({ ...scope, runIds: [] }), status: "running" }, { projection: { agent: 1, agentSlug: 1 } }).limit(20).toArray(),
        jobs.find({ ...anyOf(scope), status: "running" }, { projection: { agent: 1, runId: 1 } }).limit(20).toArray(),
      ]);
      const seen = new Set(running.map((run) => String(run._id)));
      return [
        ...running.map((run) => ({ id: String(run._id), agent: run.agentSlug ?? run.agent ?? "agent" })),
        ...claimed
          .filter((job) => !job.runId || !seen.has(String(job.runId)))
          .map((job) => ({ id: String(job.runId ?? job._id), agent: job.agent ?? "agent" })),
      ];
    },

    /** Whether anything of the workspace was ever written to the search index. */
    async hasIndexedContent(workspaceId) {
      const workspace = toObjectId(workspaceId);
      const [state, chunk] = await Promise.all([
        collection(AGENT_COLLECTIONS.indexState).findOne({ workspaceId: workspace }, { projection: { _id: 1 } }),
        collection(AGENT_COLLECTIONS.knowledgeChunks).findOne({ workspaceId: workspace }, { projection: { _id: 1 } }),
      ]);
      return Boolean(state || chunk);
    },

    /**
     * Stops new work from starting while the rest is removed: the crawl site is switched off and
     * its queued request withdrawn, the agent schedules go, and queued runs and pending jobs are
     * removed before a worker can claim them. The schedulers read these rows to start anything,
     * so with them gone or off nothing new begins for the workspace.
     */
    async stopNewWork(workspaceId) {
      const scope = await scopeOf(workspaceId);
      await sites.updateMany(
        { workspaceId: scope.workspace },
        { $set: { enabled: false }, $unset: { crawlRequestedAt: "", crawlRequestedBy: "" } },
      );
      const [schedules, pendingJobs, queuedRuns] = await Promise.all([
        collection(AGENT_COLLECTIONS.schedules).deleteMany({ workspaceId: scope.workspace }),
        jobs.deleteMany({ ...anyOf(scope), status: "pending" }),
        runs.deleteMany({ ...anyOf({ ...scope, runIds: [] }), status: "queued" }),
      ]);
      return {
        [AGENT_COLLECTIONS.schedules]: schedules.deletedCount,
        pendingJobs: pendingJobs.deletedCount,
        queuedRuns: queuedRuns.deletedCount,
      };
    },

    /**
     * Removes every MongoDB record of the workspace except the `workspaces` row, its brand images
     * (the asset store's) and the credentials (released separately). Returns how many rows went
     * from each collection; a collection with none is left out.
     *
     * @returns {Promise<Record<string, number>>}
     */
    async eraseRecords(workspaceId) {
      const scope = await scopeOf(workspaceId);
      const removed = {};
      const count = (name, result) => {
        if (result.deletedCount) removed[name] = (removed[name] ?? 0) + result.deletedCount;
      };

      // Found through the sites and runs, so first.
      if (scope.siteIds.length) {
        for (const name of SITE_COLLECTIONS) count(name, await collection(name).deleteMany({ siteId: { $in: scope.siteIds } }));
      }
      if (scope.runIds.length) {
        count(AGENT_COLLECTIONS.runEvents, await collection(AGENT_COLLECTIONS.runEvents).deleteMany({ runId: { $in: scope.runIds } }));
      }
      for (const name of SITE_OR_RUN_COLLECTIONS) count(name, await collection(name).deleteMany(anyOf(scope)));
      for (const name of WORKSPACE_COLLECTIONS) count(name, await collection(name).deleteMany({ workspaceId: scope.workspace }));

      // What found the rows above, last.
      count(AGENT_COLLECTIONS.runs, await runs.deleteMany(anyOf({ ...scope, runIds: [] })));
      count(AGENT_COLLECTIONS.sites, await sites.deleteMany({ workspaceId: scope.workspace }));
      return removed;
    },

    /**
     * Rows that still name the workspace, by collection: the deletion's own check that it got
     * everything, logged when anything is found. Only collections keyed by `workspaceId`; the
     * site- and run-keyed ones cannot be found once the site and runs are gone, which is why they
     * are removed first.
     */
    async remainingFor(workspaceId) {
      const workspace = toObjectId(workspaceId);
      const left = {};
      for (const name of [...WORKSPACE_COLLECTIONS, AGENT_COLLECTIONS.runs, AGENT_COLLECTIONS.sites, AGENT_COLLECTIONS.brandAssets]) {
        const count = await collection(name).countDocuments({ workspaceId: workspace });
        if (count) left[name] = count;
      }
      return left;
    },

    /** Unsets the selection of everyone who had this workspace selected; the list repairs it. */
    async clearSelections(workspaceId) {
      const result = await collection(COLLECTIONS.users).updateMany(
        { selectedWorkspaceId: toObjectId(workspaceId) },
        { $set: { selectedWorkspaceId: null, updatedAt: new Date() } },
      );
      return result.modifiedCount;
    },

    /**
     * Writes the record that the workspace was deleted, or adds to it: one row per workspace, so a
     * retried deletion completes the row its first attempt started. `leftovers` are added to what
     * the row holds rather than replacing it, which is what lets something left behind by a failed
     * attempt survive a retry that no longer knows about it.
     */
    recordDeletion(workspaceId, fields, leftovers = []) {
      return collection(COLLECTIONS.workspaceDeletions).updateOne(
        { workspaceId: toObjectId(workspaceId) },
        {
          $set: fields,
          $addToSet: { leftovers: { $each: leftovers } },
          $setOnInsert: { workspaceId: toObjectId(workspaceId) },
        },
        { upsert: true },
      );
    },

    /** Removes the `workspaces` row: the last step, after which the workspace answers 404. */
    async removeWorkspace(workspaceId) {
      const result = await collection(COLLECTIONS.workspaces).deleteOne({ _id: toObjectId(workspaceId) });
      return result.deletedCount === 1;
    },
  };
}
