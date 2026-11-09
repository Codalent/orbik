import { AppError } from "../errors/appError.js";

/**
 * The roles a person can hold in a workspace, lowest first. A check names a minimum and every
 * role at or above it passes, so the order *is* the permission model: what a member may do, an
 * admin and the owner may do too.
 */
export const WORKSPACE_ROLES = Object.freeze(["read-only", "member", "admin", "owner"]);

/**
 * The roles a `workspace_members` row or an invite may hold. Never `owner`: the owner is the
 * workspace's `ownerId`, there is exactly one, and nobody can be invited or promoted into it.
 */
export const MEMBER_ROLES = Object.freeze(["admin", "member", "read-only"]);

/** True when `role` is at or above `minimum`; false for an unknown or missing role. */
export function hasRole(role, minimum) {
  const held = WORKSPACE_ROLES.indexOf(role);
  const needed = WORKSPACE_ROLES.indexOf(minimum);
  return held !== -1 && needed !== -1 && held >= needed;
}

/**
 * Builds the check every workspace-scoped use case starts from: resolve a workspace the caller can
 * open — as its owner or through a `workspace_members` row — and hold them to the minimum role the
 * operation needs.
 *
 * Two different refusals, on purpose. A workspace the caller has no access to — somebody else's,
 * one that does not exist, an identifier that is not one — produces the same 404, so the API never
 * confirms that an identifier is real to someone not entitled to it. `404` rather than `403`
 * because the two answers together would tell an outsider which workspace identifiers exist. A
 * caller who *can* open the workspace already knows it exists, so for them a role too low for the
 * operation is a `403 ROLE_INSUFFICIENT`, which the web app can explain. This is the
 * session-authenticated path; the MCP endpoint itself answers `401` for the same reason.
 *
 * The minimum is required. Calling the check without one throws a `TypeError` — a programming
 * error, never an answer to a request — so no call site can fall back to a default by omission.
 *
 * @param {object} workspaceRepository workspace access by owner or membership
 * @returns {(userId: string, workspaceId: string, options: {role: string}) => Promise<object>} the
 *   workspace, with the caller's `role` on it
 */
export function createWorkspaceAccessCheck(workspaceRepository) {
  return async function requireWorkspaceAccess(userId, workspaceId, { role: minimum } = {}) {
    if (!WORKSPACE_ROLES.includes(minimum)) {
      throw new TypeError(`requireWorkspaceAccess needs a minimum role (${WORKSPACE_ROLES.join(", ")}); got ${String(minimum)}.`);
    }
    const workspace = await workspaceRepository.findAccessibleById(userId, workspaceId);
    if (!workspace) {
      throw new AppError({ status: 404, code: "WORKSPACE_NOT_FOUND", message: "Workspace was not found." });
    }
    if (!hasRole(workspace.role, minimum)) {
      throw new AppError({
        status: 403,
        code: "ROLE_INSUFFICIENT",
        message: "Your role in this workspace does not allow this.",
      });
    }
    return workspace;
  };
}

/**
 * The owner-only check: `createWorkspaceAccessCheck` with `{role: "owner"}`. An outsider still gets
 * the 404; a member, of any role, gets the 403.
 *
 * @param {object} workspaceRepository workspace access by owner or membership
 * @returns {(userId: string, workspaceId: string) => Promise<object>} the owned workspace
 */
export function createOwnedWorkspaceCheck(workspaceRepository) {
  const requireWorkspaceAccess = createWorkspaceAccessCheck(workspaceRepository);
  return function requireOwnedWorkspace(userId, workspaceId) {
    return requireWorkspaceAccess(userId, workspaceId, { role: "owner" });
  };
}
