import { apiFetch } from "./client";
import { requireId } from "./ids";

/**
 * The people in a workspace and the invitations to it.
 *
 * Every route is the API's `/v1/workspaces/:workspaceId/members`, which answers by the caller's
 * role: anybody in the workspace reads who is in it; inviting, changing a role and removing
 * somebody are an admin's and the owner's; nobody changes or removes the owner.
 */

/**
 * Rejects anything that is not an invite token before it reaches a URL, the way the API refuses an
 * unknown one — `404 INVITE_NOT_FOUND` — so a page shows the two the same.
 */
function requireInviteToken(token) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token ?? "")) {
    const error = new Error("This invite link is not valid.");
    error.status = 404;
    error.code = "INVITE_NOT_FOUND";
    throw error;
  }
  return token;
}

/** Where the workspace's people are read from; also their cache key. */
export function membersPath(workspaceId) {
  return `/v1/workspaces/${requireId(workspaceId, "Workspace")}/members`;
}

/** Where the workspace's pending invites are read from; also their cache key. Admin and owner only. */
export function invitesPath(workspaceId) {
  return `${membersPath(workspaceId)}/invites`;
}

/**
 * Invites an address as `role` and returns `{invite, url, emailed}`.
 *
 * `url` is the link the person is sent, and this is the only time it exists anywhere but in the
 * invitee's hands: the server keeps only a hash of its token. `emailed` says whether the install
 * also emailed it, which it does only when it is configured to send email.
 */
export function inviteMember(workspaceId, { email, role }) {
  return apiFetch(invitesPath(workspaceId), { method: "POST", body: JSON.stringify({ email, role }) });
}

/** Withdraws a pending invite: its link stops working. */
export function revokeInvite(workspaceId, inviteId) {
  return apiFetch(`${invitesPath(workspaceId)}/${requireId(inviteId, "Invite")}`, { method: "DELETE" });
}

/** Changes one member's role. Never the owner's. */
export function changeMemberRole(workspaceId, userId, role) {
  return apiFetch(`${membersPath(workspaceId)}/${requireId(userId, "Member")}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

/** Takes one member out of the workspace. Never the owner. */
export function removeMember(workspaceId, userId) {
  return apiFetch(`${membersPath(workspaceId)}/${requireId(userId, "Member")}`, { method: "DELETE" });
}

/** Leaves the workspace. Refused for its owner. */
export function leaveWorkspace(workspaceId) {
  return apiFetch(`${membersPath(workspaceId)}/me`, { method: "DELETE" });
}

/** Describes one invite from its link: the workspace, the address, the role and whether it still works. Public. */
export function readInvite(token) {
  return apiFetch(`/v1/invites/${requireInviteToken(token)}`);
}

/**
 * Accepts an invite: as the signed-in person when `password` is not given, or — for an address
 * with no account yet — creating the account with `password` and signing it in.
 */
export function acceptInvite(token, { password } = {}) {
  return apiFetch(`/v1/invites/${requireInviteToken(token)}/accept`, {
    method: "POST",
    body: JSON.stringify(password === undefined ? {} : { password }),
  });
}

/**
 * The API's refusals on this surface, as sentences a person reads. Anything else falls back to the
 * message the API sent.
 */
const MEMBER_ERRORS = Object.freeze({
  INVITE_OWNER: "That address belongs to the owner of this workspace, who is already in it.",
  ALREADY_MEMBER: "That person is already a member of this workspace.",
  MEMBER_LIMIT_REACHED: "This workspace has as many members as it can have.",
  OWNER_IMMUTABLE: "Nobody can change or remove the owner of a workspace.",
  OWNER_CANNOT_LEAVE: "The owner of a workspace cannot leave it.",
  ROLE_INSUFFICIENT: "Your role in this workspace does not allow this.",
  MEMBER_NOT_FOUND: "That person is no longer a member of this workspace.",
  INVITE_NOT_FOUND: "That invite is no longer pending.",
  INVITE_EXPIRED: "This invite has expired.",
  INVITE_USED: "This invite has already been used.",
  INVITE_REVOKED: "This invite was withdrawn.",
  INVITE_EMAIL_MISMATCH: "This invite is for a different email address.",
  AUTHENTICATION_REQUIRED: "Sign in to accept this invite.",
  WORKSPACE_NOT_FOUND: "This workspace is no longer available to you.",
  RATE_LIMITED: "Too many attempts. Wait a minute and try again.",
});

/** A failure from the members or invites routes as one sentence. */
export function describeMemberError(failure, fallback = "That did not work. Try again.") {
  if (!failure) return fallback;
  if (failure.code === "VALIDATION_FAILED") return failure.fields?.[0]?.message ?? failure.message ?? fallback;
  return MEMBER_ERRORS[failure.code] ?? failure.message ?? fallback;
}
