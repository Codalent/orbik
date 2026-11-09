import { apiFetch } from "./client";
import { requireId } from "./ids";

/**
 * Where the person's workspace list is read from — those they own and those they are a member of,
 * each with their `role` in it — also its cache key.
 */
export const WORKSPACES_PATH = "/v1/workspaces";

/** Lists the workspaces the signed-in person can open, each with their role in it. */
export function listWorkspaces() {
  return apiFetch(WORKSPACES_PATH);
}

/** Creates and selects one workspace using a stable completion-attempt key. */
export function createWorkspace(payload, idempotencyKey) {
  return apiFetch("/v1/workspaces", {
    method: "POST", body: JSON.stringify(payload), idempotencyKey,
  });
}

/** Selects a workspace the person can open; foreign and missing identifiers share one failure. */
export function selectWorkspace(workspaceId) {
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/selection`, { method: "POST", body: "{}" });
}

/** Where one workspace is changed and deleted. */
function workspacePath(workspaceId) {
  return `/v1/workspaces/${requireId(workspaceId, "Workspace")}`;
}

/**
 * Renames a workspace, changes its website, or both; admins and the owner. Returns the workspace
 * and what happened to its crawl: `crawl.change` is `none`, `not-set-up`, `seed-moved` (same site,
 * the crawl starts from the new address), `seed-kept` (same site, the crawl keeps the start page
 * somebody chose) or `new-site` (another hostname: crawled pages cleared, a crawl requested).
 *
 * A website on another hostname is refused with `409 SITE_CHANGE_UNCONFIRMED` until it is sent
 * again with `confirmSiteChange`.
 */
export function updateWorkspace(workspaceId, changes, { confirmSiteChange = false } = {}) {
  return apiFetch(workspacePath(workspaceId), {
    method: "PATCH",
    body: JSON.stringify(confirmSiteChange ? { ...changes, confirmSiteChange: true } : changes),
  });
}

/**
 * Deletes a workspace and everything in it; the owner only, with the workspace's name typed out
 * again. Answers with what was removed.
 */
export function deleteWorkspace(workspaceId, confirmName) {
  return apiFetch(workspacePath(workspaceId), { method: "DELETE", body: JSON.stringify({ confirmName }) });
}
