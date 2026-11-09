"use client";

import { useParams } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";

import { WORKSPACES_PATH } from "@/lib/api/workspaces";

/**
 * A person's role in a workspace, as the API names it, lowest first. The order is the API's own
 * (`WORKSPACE_ROLES` in `backend/src/services/workspaceAccess.js`): a check names a minimum and
 * every role at or above it passes.
 */
export const WORKSPACE_ROLES = Object.freeze(["read-only", "member", "admin", "owner"]);

/** The roles somebody can be invited as or given; never the owner, of whom there is one. */
export const MEMBER_ROLES = Object.freeze(["admin", "member", "read-only"]);

/** How each role is written for a person. */
export const ROLE_LABELS = Object.freeze({
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  "read-only": "Read-only",
});

/** A role as a person reads it, or null for one this app does not know. */
export function roleLabel(role) {
  return ROLE_LABELS[role] ?? null;
}

/**
 * Whether `role` is at or above `minimum`. False for an unknown or missing role, so a control is
 * hidden rather than shown while the role is not known.
 *
 * This is presentation only. The API checks every request against the same order and answers 403
 * `ROLE_INSUFFICIENT` when the role is too low; hiding a control only spares somebody a button that
 * would be refused.
 *
 * @param {string|null|undefined} role
 * @param {"read-only"|"member"|"admin"|"owner"} minimum
 */
export function can(role, minimum) {
  const held = WORKSPACE_ROLES.indexOf(role);
  const needed = WORKSPACE_ROLES.indexOf(minimum);
  return held >= 0 && needed >= 0 && held >= needed;
}

/**
 * A workspace's role as the list gives it. A workspace in the list without a `role` is the
 * person's own: before members existed the list held only owned workspaces, and an API that
 * predates them answers without the field. Null for no workspace at all.
 *
 * @param {{role?: string}|null|undefined} workspace an item of `GET /v1/workspaces`
 */
export function roleOf(workspace) {
  if (!workspace) return null;
  return workspace.role ?? "owner";
}

/**
 * The signed-in person's role in a workspace — the address's when none is named — or null while
 * the list is loading or when the workspace is not in it.
 *
 * Read from the workspace list the shell already loaded, from the same cache, so this asks for
 * nothing; and a role changed by somebody else arrives with the list's next read, which the API
 * client asks for whenever a request is refused for its role. Only when nothing has read the list
 * yet does this read it itself: dozens of controls ask for a role, and each asking the API again on
 * mounting would repeat a read the shell and the gate already keep fresh.
 *
 * @param {string} [workspaceId]
 * @returns {"owner"|"admin"|"member"|"read-only"|null}
 */
export function useWorkspaceRole(workspaceId) {
  const params = useParams();
  const id = workspaceId ?? (typeof params?.workspaceId === "string" ? params.workspaceId : null);
  const { cache } = useSWRConfig();
  const loaded = cache.get(WORKSPACES_PATH)?.data !== undefined;
  const { data } = useSWR(WORKSPACES_PATH, { revalidateOnMount: !loaded, revalidateIfStale: false });
  if (!id) return null;
  return roleOf(data?.items?.find((workspace) => workspace.id === id));
}

/**
 * Whether the signed-in person's role in a workspace reaches `minimum`. The shorthand every page
 * uses to decide whether to draw a control that changes something.
 *
 * @param {"read-only"|"member"|"admin"|"owner"} minimum
 * @param {string} [workspaceId]
 */
export function useCan(minimum, workspaceId) {
  return can(useWorkspaceRole(workspaceId), minimum);
}
