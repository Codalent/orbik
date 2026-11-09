import { apiFetch } from "./client";
import { requireId } from "./ids";

/**
 * Where a workspace's Home page is read from — every step of its setup checklist, for the signed-in
 * person, and the workspace at a glance — and also its cache key.
 *
 * The same read decides where the workspace opens (`landing`), so the arrival route and the page
 * share one cached answer: arriving on Home finds it already loaded.
 */
export function homePath(workspaceId) {
  return `/v1/workspaces/${requireId(workspaceId, "Workspace")}/home`;
}

/**
 * Saves one change to the person's Home page and returns their preferences: `skip` or `unskip`
 * recommended steps by identifier, or set `hidden` for the checklist. Stored on the server, so it
 * follows the person to another browser.
 *
 * @param {string} workspaceId
 * @param {{skip?: string[], unskip?: string[], hidden?: boolean}} change
 */
export function updateHomePreferences(workspaceId, change) {
  return apiFetch(`${homePath(workspaceId)}/preferences`, { method: "PATCH", body: JSON.stringify(change) });
}
