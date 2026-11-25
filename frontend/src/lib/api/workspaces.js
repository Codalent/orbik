import { apiFetch, apiUpload, getApiBaseUrl } from "./client";
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

/**
 * The address of a workspace's icon, for an `<img>`: the one it is shown with, or by `origin` the
 * website's (`site`) or the uploaded one (`upload`). Absolute, because the API may be on another
 * origin; the session cookie travels with it as with a brand image. `version` is the picture's, from
 * the workspace list's `icon`, so a new picture is a new address and a kept copy is never stale.
 *
 * @param {string} workspaceId
 * @param {string} version
 * @param {"site"|"upload"|null} [origin]
 */
export function workspaceIconUrl(workspaceId, version, origin = null) {
  const query = new URLSearchParams({ ...(origin ? { origin } : {}), v: version });
  return `${getApiBaseUrl()}${workspacePath(workspaceId)}/icon?${query}`;
}

/**
 * Uploads a picture as the workspace's icon and shows it from then on; admins and the owner. The
 * API reads what it is from its bytes. Returns the workspace's `icon` as the list carries it.
 */
export function uploadWorkspaceIcon(workspaceId, file) {
  return apiUpload(`${workspacePath(workspaceId)}/icon/upload`, file, { name: file.name });
}

/**
 * Chooses what the workspace is shown with: `site`, the website's icon as the crawler finds it;
 * `upload`, the uploaded one; or `none`, the first letter of its name. Admins and the owner.
 */
export function chooseWorkspaceIcon(workspaceId, choice) {
  return apiFetch(`${workspacePath(workspaceId)}/icon`, { method: "PUT", body: JSON.stringify({ choice }) });
}
