import { createHash } from "node:crypto";

import { toObjectId } from "@orbik/core";

import { AppError } from "../errors/appError.js";
import { toWorkspaceSummary } from "../repositories/workspaceRepository.js";
import { createWorkspaceAccessCheck } from "./workspaceAccess.js";

/** The hostname of an address, lower-cased: what decides whether two addresses are one site. */
function hostOf(url) {
  return new URL(url).hostname.toLowerCase();
}

/**
 * Creates workspace creation, listing, selection, change and deletion orchestration.
 *
 * @param {object} dependencies
 * @param {(subject: {ownerId: unknown, workspaceId: null}) => Promise<{maxWorkspaces: number|null}>} [dependencies.limitsFor]
 *   the creating account's plan limits; unlimited when not given
 * @param {{emit: Function}} [dependencies.events] told `workspace.created` after a new one is made
 *   and `workspace.deleted` after one is removed
 * @param {object} [dependencies.crawlRepository] the crawl site a website change moves
 * @param {object} [dependencies.erasure] `createWorkspaceErasureRepository`
 * @param {object} [dependencies.credentialRelease] lets go of MCP tokens and OAuth grants
 * @param {object} [dependencies.assetStore] the brand images, in GridFS
 * @param {{eraseWorkspace: Function}} [dependencies.indexEraser] the vector database's points
 * @param {Function} [dependencies.logger]
 * @param {() => Date} [dependencies.now]
 */
export function createWorkspaceService({
  userRepository,
  workspaceRepository,
  limitsFor = async () => ({ maxWorkspaces: null }),
  events = { emit: async () => {} },
  crawlRepository = null,
  erasure = null,
  credentialRelease = null,
  assetStore = null,
  indexEraser = null,
  logger = () => {},
  now = () => new Date(),
}) {
  const requireWorkspaceAccess = createWorkspaceAccessCheck(workspaceRepository);

  async function requireActive(userId) {
    const user = await userRepository.findActiveById(userId);
    if (!user) throw new AppError({ status: 401, code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." });
    return user;
  }

  return {
    /** Atomically creates or replays a workspace, checks payload conflicts, and persists selection. */
    async create({ userId, name, websiteUrl, idempotencyKey }) {
      await requireActive(userId);
      // Over the plan's number of workspaces, only a replay of one already made gets through: it
      // makes nothing new. Two creations racing past the limit can both land; a plan's count is a
      // ceiling a person is told about, not a lock.
      // The account's question, not any workspace's: asked with no workspace.
      const { maxWorkspaces } = await limitsFor({ ownerId: userId, workspaceId: null });
      if (maxWorkspaces !== null
        && await workspaceRepository.countOwned(userId) >= maxWorkspaces
        && !(await workspaceRepository.findByCreationKey(userId, idempotencyKey))) {
        throw new AppError({
          status: 403,
          code: "PLAN_LIMIT_REACHED",
          message: `Your plan includes ${maxWorkspaces} ${maxWorkspaces === 1 ? "workspace" : "workspaces"}, and you have that many already.`,
        });
      }
      const creationPayloadHash = createHash("sha256").update(JSON.stringify({ name, websiteUrl })).digest("hex");
      const { workspace, created } = await workspaceRepository.createIdempotent({
        ownerId: userId, name, websiteUrl, creationKey: idempotencyKey, creationPayloadHash,
      });
      if (workspace.creationPayloadHash !== creationPayloadHash) {
        throw new AppError({ status: 409, code: "IDEMPOTENCY_CONFLICT", message: "This idempotency key was already used for different workspace data." });
      }
      const selected = await userRepository.setSelectedWorkspace(userId, workspace._id);
      if (!selected) throw new AppError({ status: 401, code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." });
      if (created) {
        await events.emit("workspace.created", {
          workspace: {
            id: workspace._id.toHexString(),
            name: workspace.name,
            websiteUrl: workspace.websiteUrl,
            ownerId: workspace.ownerId.toHexString(),
          },
          userId: String(userId),
        });
      }
      return { workspace: toWorkspaceSummary({ ...workspace, role: "owner" }), selectedWorkspaceId: workspace._id.toHexString(), destination: "workspace-home", created };
    },

    /**
     * Returns every workspace the user can open — owned, or as a member — each with their role,
     * and repairs a stale or missing selection deterministically over that same list.
     */
    async list({ userId }) {
      const user = await requireActive(userId);
      const items = await workspaceRepository.listAccessible(userId);
      const selected = user.selectedWorkspaceId
        ? items.find((item) => item._id.equals(user.selectedWorkspaceId))
        : null;
      const fallback = selected ?? items[0] ?? null;
      if (String(user.selectedWorkspaceId ?? "") !== String(fallback?._id ?? "")) {
        await userRepository.setSelectedWorkspace(userId, fallback?._id ?? null);
      }
      return {
        items: items.map(toWorkspaceSummary),
        selectedWorkspaceId: fallback?._id.toHexString() ?? null,
        destination: fallback ? "workspace-home" : "workspace-onboarding",
      };
    },

    /** Selects a workspace the user can open, at any role. */
    async select({ userId, workspaceId }) {
      await requireActive(userId);
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      await userRepository.setSelectedWorkspace(userId, workspace._id);
      return { workspace: toWorkspaceSummary(workspace), selectedWorkspaceId: workspace._id.toHexString(), destination: "workspace-home" };
    },

    /**
     * Renames a workspace, changes its website, or both. Admin and up: the name and the website
     * are what the whole team, and every connected AI, knows the workspace by.
     *
     * The website is also where the crawl starts when nobody chose another start page. So a
     * change of website moves the crawl with it, by one rule — whether the new address is on the
     * hostname the crawl covers (a crawl covers exactly one, `agents/src/crawler/scope.js`):
     *
     * - **Same hostname** (`http:` to `https:`, another start path): the same site. The crawl's
     *   start address moves too when it was the old website, and is left alone when somebody chose
     *   another one on the Crawl page. Everything crawled and the Library stay as they are.
     * - **Another hostname**: another site, whose pages the crawl registry does not hold, and old
     *   pages left in it would still be fetched on every crawl. It needs `confirmSiteChange`, and
     *   is refused while a crawl runs. It then does what Clear crawled data does — every crawled
     *   page, snapshot, link and crawl run of the old site goes — moves the start address, drops
     *   the sitemaps named for the old host, and asks for a crawl of the new site at once, as
     *   setting a crawl up does (that crawl spends crawl budget). It does not touch the Library:
     *   its copies of the old pages are retired as the new crawl's pages are mirrored, and what
     *   people and agents wrote stays until it is rewritten. The brand is left as it is.
     *
     * Without a crawl site there is nothing to move: the Crawl page offers the new website as its
     * start address. The crawl site is changed before the workspace, so a change that fails half
     * way is finished by sending it again: the workspace still names the old address, and the
     * comparison above is made again against the crawl as it now stands.
     */
    async update({ userId, workspaceId, changes, confirmSiteChange = false }) {
      await requireActive(userId);
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "admin" });
      const websiteChanged = changes.websiteUrl !== undefined && changes.websiteUrl !== workspace.websiteUrl;
      let crawl = { change: "none" };

      if (websiteChanged && crawlRepository) {
        const site = await crawlRepository.findSiteByWorkspace(workspace._id);
        if (!site) {
          crawl = { change: "not-set-up" };
        } else {
          const newSite = hostOf(changes.websiteUrl) !== hostOf(site.seedUrl);
          if (newSite && !confirmSiteChange) {
            throw new AppError({
              status: 409,
              code: "SITE_CHANGE_UNCONFIRMED",
              message:
                `${hostOf(changes.websiteUrl)} is a different site from ${hostOf(site.seedUrl)}, the one this workspace crawls. ` +
                "Changing to it clears every crawled page and starts a crawl of the new address. Confirm to go ahead.",
            });
          }
          if (await crawlRepository.findActiveRun(site._id)) {
            throw new AppError({
              status: 409,
              code: "CRAWL_RUNNING",
              message: "A crawl is running. Wait for it to finish before changing the website.",
            });
          }
          const at = now();
          if (newSite) {
            const pages = await crawlRepository.clearSiteData(site._id);
            await crawlRepository.moveSeed(site._id, { seedUrl: changes.websiteUrl, newSite: true, now: at });
            await crawlRepository.requestCrawlNow(site._id, at, userId);
            crawl = { change: "new-site", pagesCleared: pages, crawlRequested: true, seedUrl: changes.websiteUrl };
          } else if (site.seedUrl === workspace.websiteUrl) {
            await crawlRepository.moveSeed(site._id, { seedUrl: changes.websiteUrl, newSite: false, now: at });
            crawl = { change: "seed-moved", seedUrl: changes.websiteUrl };
          } else {
            crawl = { change: "seed-kept", seedUrl: site.seedUrl };
          }
        }
      }

      const updated = await workspaceRepository.updateDetails(workspace._id, {
        name: changes.name,
        websiteUrl: websiteChanged ? changes.websiteUrl : undefined,
      });
      if (!updated) throw new AppError({ status: 404, code: "WORKSPACE_NOT_FOUND", message: "Workspace was not found." });
      return { workspace: toWorkspaceSummary({ ...updated, role: workspace.role }), crawl };
    },

    /**
     * Deletes a workspace and every record of it. The owner only, and only with its name typed
     * out again (`confirmName`), compared exactly after the trimming and normalisation a name is
     * stored with.
     *
     * Refused with `409 WORKSPACE_BUSY` while a worker is executing anything for it — a crawl, an
     * agent run, a claimed job — because the worker would carry on writing for a workspace that no
     * longer exists. Work that is only queued is not executing, and is removed with the rest.
     *
     * The order makes a failure half way safe to retry, by sending the same request again:
     *
     * 1. New work is stopped: the crawl site switched off, schedules, queued runs and pending jobs
     *    removed.
     * 2. The search index's points go, when anything was ever indexed. With Qdrant not answering
     *    this does not stop the deletion: the points can be found by nobody once the workspace is
     *    gone, every query being filtered by a workspace a credential can read. The leftover is
     *    recorded on the `workspace_deletions` row at once (so a retry that no longer sees the
     *    index state still has it) and reported, as indexing records `INDEX_UNAVAILABLE`.
     * 3. The brand images and their GridFS files.
     * 4. Every MongoDB record: the crawl registry, runs and their events, the Library, the
     *    index's chunks, the brand, model calls, members and invites — and the rows the workspace
     *    still has in collections left by agents earlier releases had (`RETIRED_COLLECTIONS`).
     * 5. Credentials: tokens and grants reading only this workspace are deleted, others narrowed.
     * 6. Everybody's selection of it is cleared.
     * 7. The `workspace_deletions` row, then the workspace itself — last, so until everything
     *    else is gone its owner can still open it and delete it again.
     *
     * Not removed: the owner's crawl budget for the month (what was fetched was spent), and the
     * deletion's own record.
     */
    async remove({ userId, workspaceId, confirmName }) {
      await requireActive(userId);
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "owner" });
      if (confirmName.trim().normalize("NFC") !== workspace.name) {
        throw new AppError({
          status: 400,
          code: "CONFIRMATION_MISMATCH",
          message: "That is not this workspace's name. Type it exactly as it is shown to delete the workspace.",
        });
      }
      const busy = await erasure.activeWork(workspace._id);
      if (busy.length) {
        const agents = [...new Set(busy.map((entry) => entry.agent))].join(", ");
        throw new AppError({
          status: 409,
          code: "WORKSPACE_BUSY",
          message:
            `Something is running in this workspace (${agents}). ` +
            "Stop it from Activity, or wait for it to finish, then delete the workspace.",
        });
      }

      const id = workspace._id;
      const hex = id.toHexString();
      const deletedAt = now();
      const summary = {
        name: workspace.name,
        websiteUrl: workspace.websiteUrl ?? null,
        ownerId: workspace.ownerId,
        deletedBy: toObjectId(userId),
        startedAt: deletedAt,
      };

      const stopped = await erasure.stopNewWork(id);

      let index = { status: "nothing-indexed" };
      if (await erasure.hasIndexedContent(id)) {
        try {
          await indexEraser.eraseWorkspace(hex);
          index = { status: "removed" };
        } catch (error) {
          if (!["INDEX_UNAVAILABLE", "INDEX_FAILED"].includes(error?.code)) throw error;
          index = { status: "left-behind", code: error.code, message: error.message };
          await erasure.recordDeletion(id, summary, [{ store: "qdrant", code: error.code, message: error.message, at: deletedAt }]);
          logger("warn", "workspace.delete_index_left", { workspaceId: hex, code: error.code });
        }
      }

      const brand = assetStore ? await assetStore.purgeWorkspace(id) : { assets: 0, files: 0 };
      const removed = await erasure.eraseRecords(id);
      const credentials = await credentialRelease.forgetWorkspace({ workspaceId: id });
      const selectionsCleared = await erasure.clearSelections(id);
      const remaining = await erasure.remainingFor(id);
      if (Object.keys(remaining).length) logger("warn", "workspace.delete_rows_remaining", { workspaceId: hex, remaining });

      await erasure.recordDeletion(id, {
        ...summary,
        deletedAt: now(),
        stopped,
        removed,
        brand,
        credentials,
        index: { status: index.status, ...(index.code ? { code: index.code } : {}) },
        remaining,
      });
      await erasure.removeWorkspace(id);
      logger("info", "workspace.deleted", { workspaceId: hex, index: index.status });
      await events.emit("workspace.deleted", {
        workspace: { id: hex, name: workspace.name, websiteUrl: workspace.websiteUrl ?? null, ownerId: workspace.ownerId.toHexString() },
        userId: String(userId),
      });

      return {
        deleted: true,
        workspace: { id: hex, name: workspace.name },
        removed: { ...removed, ...stoppedCounts(stopped) },
        brand,
        credentials,
        index,
        selectionsCleared,
      };
    },
  };
}

/** The counts `stopNewWork` reports, under the names the response uses. */
function stoppedCounts(stopped) {
  return Object.fromEntries(Object.entries(stopped).filter(([, count]) => count > 0));
}
