import { toObjectId } from "@orbik/core";

import { AppError } from "../errors/appError.js";
import { hasRole } from "../services/workspaceAccess.js";

/**
 * The set of workspaces one MCP credential may read, and the rules for reading it.
 *
 * A pasted token and an OAuth grant both carry the same field, `workspaces`, in one of two shapes:
 * `{mode: "all"}` — every workspace the person can read, now and later: the ones they own and the
 * ones they are a member of — or `{mode: "selected", ids: ObjectId[]}`. Rows written before the field existed carry a single
 * `workspaceId` instead, and are read as a selection of that one workspace. Nothing migrates them:
 * the reading is done here, once, and every caller sees the new shape.
 *
 * What makes a set as safe as the single workspace it replaced is where it is turned into
 * workspaces. The stored value is never trusted on its own: on every request it is intersected with
 * the workspaces the person can read *now* (`materialise`, over `workspaceRepository.listAccessible`),
 * so a workspace that was deleted, changed hands, or that the person was removed from drops out
 * without anybody revoking anything, and "all" can never mean a workspace they cannot open. A
 * client may then pick one member of that set by naming it, but nothing it sends can add to the set.
 *
 * Writing is the person's role as well as the credential's scope. `orbik:write` is issued only when
 * the person is a member or above in every workspace the credential covers at that moment
 * (`requireWriteRole`), and since a role can be lowered afterwards, each write is checked again
 * against the role the person holds on that request (`mayWriteIn`).
 */

/** Most workspaces one selection may name. A guard on the request body, not a product limit. */
export const MAX_SELECTED_WORKSPACES = 100;

/**
 * Reads a stored credential's set, whichever shape the row was written in.
 *
 * @param {{workspaces?: object, workspaceId?: unknown}} row an `mcp_tokens` or `oauth_grants` row
 * @returns {{mode: "all"} | {mode: "selected", ids: import("mongodb").ObjectId[]}}
 */
export function workspacesOf(row) {
  const stored = row?.workspaces;
  if (stored?.mode === "all") return { mode: "all" };
  if (stored?.mode === "selected") return { mode: "selected", ids: (stored.ids ?? []).map(toObjectId) };
  return { mode: "selected", ids: row?.workspaceId ? [toObjectId(row.workspaceId)] : [] };
}

/**
 * Converts a validated selection from a request body into the shape that is stored.
 *
 * @param {{mode: "all"} | {mode: "selected", ids: string[]}} selection
 */
export function toStoredWorkspaces(selection) {
  return selection.mode === "all"
    ? { mode: "all" }
    : { mode: "selected", ids: selection.ids.map(toObjectId) };
}

/**
 * Whether a credential roams: may read more than one workspace, and so has to be told which.
 *
 * Decided by what was granted rather than by how many workspaces exist today, so a client's tool
 * list does not change shape under it when a workspace is created or deleted. "All" roams even for
 * a person with one workspace, because it will cover the next one without asking again.
 */
export function isRoaming(workspaces) {
  return workspaces.mode === "all" || workspaces.ids.length > 1;
}

/**
 * Turns a stored set into the workspaces it covers now, from the workspaces the person can read.
 *
 * @param {Array<{_id: import("mongodb").ObjectId, role?: string}>} accessible
 *   `workspaceRepository.listAccessible(userId)`, each carrying the person's `role`
 * @param {{mode: string, ids?: import("mongodb").ObjectId[]}} workspaces the stored set
 * @returns {Array<object>} the accessible workspaces in the set, in `listAccessible`'s order, each
 *   with its `role`
 */
export function materialise(accessible, workspaces) {
  if (workspaces.mode === "all") return accessible;
  const wanted = new Set(workspaces.ids.map((id) => id.toHexString()));
  return accessible.filter((workspace) => wanted.has(workspace._id.toHexString()));
}

/**
 * Whether the person may write to one workspace's Library, by the role they hold in it now.
 *
 * `member` or above, as on the Library page. A workspace whose record carries no role is treated
 * as one they may not write to: the role is what grants it, never its absence.
 *
 * @param {{role?: string}} workspace a materialised member of a credential's set
 */
export function mayWriteIn(workspace) {
  return hasRole(workspace?.role, "member");
}

/**
 * Refuses `orbik:write` for a set that covers any workspace where the person may not write.
 *
 * Asked when a token is minted and when an app is approved, over the workspaces the set covers at
 * that moment — for "all", every workspace the person can read now. A read-only person may still
 * mint a token or approve an app that only reads; it is the write box that is refused, with the
 * same `403 ROLE_INSUFFICIENT` as any other action their role does not allow.
 *
 * @param {Array<{_id: import("mongodb").ObjectId, name: string, role?: string}>} covered
 *   `materialise(accessible, set)`
 * @throws {AppError} `403 ROLE_INSUFFICIENT`, naming the workspaces that stand in the way
 */
export function requireWriteRole(covered) {
  const readOnly = covered.filter((workspace) => !mayWriteIn(workspace));
  if (!readOnly.length) return;
  const names = readOnly.map((workspace) => workspace.name).join(", ");
  throw new AppError({
    status: 403,
    code: "ROLE_INSUFFICIENT",
    message:
      `Writing to the Library needs the member role or above in every workspace this covers, and you are read-only in ${names}. ` +
      "Leave writing off, or choose only workspaces you can edit.",
  });
}

/**
 * The Mongo filter for "rows whose set includes this workspace".
 *
 * Three cases: a set of every workspace the person can read, a selection naming it, and a row written
 * before sets existed whose single workspace is this one. The last is guarded by `workspaces`
 * being absent, because a legacy row that has since been re-approved keeps its old `workspaceId`
 * beside the new set, and the set is what it means now.
 */
export function coversWorkspace(workspaceId) {
  const id = toObjectId(workspaceId);
  return {
    $or: [
      { "workspaces.mode": "all" },
      { "workspaces.ids": id },
      { workspaces: { $exists: false }, workspaceId: id },
    ],
  };
}

/**
 * Says what a credential reads, for the line beside it on the settings page.
 *
 * Names come from the workspaces the person can read, so a selection that names one they can no
 * longer open simply does not mention it.
 *
 * @param {{mode: string, ids?: import("mongodb").ObjectId[]}} workspaces the stored set
 * @param {Array<object>} accessible `workspaceRepository.listAccessible(userId)`
 */
export function describeReads(workspaces, accessible) {
  if (workspaces.mode === "all") return { mode: "all" };
  return {
    mode: "selected",
    workspaces: materialise(accessible, workspaces).map((workspace) => ({
      id: workspace._id.toHexString(),
      name: workspace.name,
    })),
  };
}

/** The hostname of a workspace's website, or null when it has none that parses. */
export function hostOf(websiteUrl) {
  if (!websiteUrl) return null;
  try {
    return new URL(websiteUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}
