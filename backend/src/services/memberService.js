import { log as defaultLog } from "@orbik/core";

import { AppError } from "../errors/appError.js";
import { createWorkspaceAccessCheck, hasRole } from "./workspaceAccess.js";

/**
 * The public shape of one person in a workspace. The owner joined when the workspace was made;
 * everyone else when their row was.
 */
function toMember({ userId, email, role, joinedAt }, callerId) {
  return {
    userId: userId.toHexString(),
    email: email ?? null,
    role,
    joinedAt: joinedAt.toISOString(),
    isYou: userId.equals(callerId),
  };
}

function ownerImmutable() {
  return new AppError({ status: 403, code: "OWNER_IMMUTABLE", message: "The workspace's owner cannot be changed or removed." });
}

function memberNotFound() {
  return new AppError({ status: 404, code: "MEMBER_NOT_FOUND", message: "That person is not a member of this workspace." });
}

/**
 * Creates the use cases behind a workspace's Members list: who belongs, as what, and how that
 * changes.
 *
 * Every one starts from the access check, so somebody with no access to the workspace gets the
 * same 404 as for a workspace that does not exist, and only then is their role weighed. The owner
 * is the workspace's `ownerId` and has no member row: nobody, admins included, can change or
 * remove them, and they cannot leave — a workspace always has exactly one owner.
 *
 * An invite carries the authority of whoever issued it, so the invites a person issued here are
 * revoked when they are removed, leave, or are given a role below admin.
 *
 * @param {object} dependencies
 * @param {object} dependencies.workspaceRepository access by owner or membership
 * @param {object} dependencies.memberRepository `workspace_members`
 * @param {object} dependencies.inviteRepository `workspace_invites`, to revoke a person's invites
 * @param {object} dependencies.credentialRelease lets go of the MCP tokens and OAuth grants of a
 *   person who can no longer open the workspace (`mcp/credentialRelease.js`)
 * @param {object} dependencies.userRepository addresses of the people listed
 * @param {Function} [dependencies.logger]
 */
export function createMemberService({
  workspaceRepository,
  memberRepository,
  inviteRepository,
  userRepository,
  credentialRelease,
  limitsFor,
  logger = defaultLog,
}) {
  const requireWorkspaceAccess = createWorkspaceAccessCheck(workspaceRepository);

  /** Revokes the pending invites a person issued in a workspace, and says so when there were any. */
  async function revokeInvitesBy(workspace, inviterId, reason) {
    const revoked = await inviteRepository.revokePendingByInviter(workspace._id, inviterId);
    if (revoked) {
      logger("info", "workspace.invites_revoked_with_inviter", {
        workspaceId: workspace._id.toHexString(),
        inviterId: String(inviterId),
        reason,
        revoked,
      });
    }
  }

  async function emailOf(userId) {
    const [user] = await userRepository.listEmailsByIds([userId]);
    return user?.email ?? null;
  }

  /** Refuses the owner as a target before anything is looked up about them as a member. */
  function refuseOwner(workspace, targetId) {
    if (workspace.ownerId?.toHexString() === String(targetId).toLowerCase()) throw ownerImmutable();
  }

  return {
    /** The owner first, then every member by when they joined, with the caller's own role. */
    async list({ userId, workspaceId }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      const rows = await memberRepository.listForWorkspace(workspace._id, workspace.ownerId);
      const users = await userRepository.listEmailsByIds([workspace.ownerId, ...rows.map((row) => row.userId)]);
      const emails = new Map(users.map((user) => [user._id.toHexString(), user.email]));
      const members = [
        { userId: workspace.ownerId, role: "owner", joinedAt: workspace.createdAt },
        ...rows.map((row) => ({ userId: row.userId, role: row.role, joinedAt: row.createdAt })),
      ].map((entry) => toMember({ ...entry, email: emails.get(entry.userId.toHexString()) }, userId));
      return {
        members,
        role: workspace.role,
        // From the owner's plan; null — no limit — in the open-source edition.
        limits: { maxMembers: (await limitsFor({ ownerId: workspace.ownerId, workspaceId: workspace._id })).maxMembersPerWorkspace },
      };
    },

    /** Gives a member another role. An admin may change any member, themselves included. */
    async changeRole({ userId, workspaceId, targetUserId, role }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "admin" });
      refuseOwner(workspace, targetUserId);
      const before = await memberRepository.find(workspace._id, targetUserId);
      if (!before) throw memberNotFound();
      const row = await memberRepository.updateRole(workspace._id, targetUserId, role);
      if (!row) throw memberNotFound();
      if (!hasRole(role, "admin")) await revokeInvitesBy(workspace, row.userId, "role_changed");
      if (before.role !== role) {
        logger("info", "workspace.member_role_changed", {
          workspaceId: workspace._id.toHexString(),
          memberId: row.userId.toHexString(),
          changedBy: String(userId),
          from: before.role,
          to: role,
        });
      }
      return {
        member: toMember({ userId: row.userId, email: await emailOf(row.userId), role: row.role, joinedAt: row.createdAt }, userId),
      };
    },

    /**
     * Removes a member. Their access ends with this write: every check reads the row, so their
     * next request — through the web app or a credential they minted — no longer finds the
     * workspace.
     */
    async remove({ userId, workspaceId, targetUserId }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "admin" });
      refuseOwner(workspace, targetUserId);
      if (!(await memberRepository.remove(workspace._id, targetUserId))) throw memberNotFound();
      // Only once the row is gone: the release is for a workspace the person can no longer open.
      await credentialRelease.release({ userId: targetUserId, workspaceId: workspace._id });
      await revokeInvitesBy(workspace, targetUserId, "removed");
      logger("info", "workspace.member_removed", {
        workspaceId: workspace._id.toHexString(),
        memberId: String(targetUserId),
        removedBy: String(userId),
      });
      return { removed: true };
    },

    /** Leaves a workspace, at any role but owner. */
    async leave({ userId, workspaceId }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      if (workspace.role === "owner") {
        throw new AppError({ status: 403, code: "OWNER_CANNOT_LEAVE", message: "The owner cannot leave their own workspace." });
      }
      // Removed already by someone else between the check and here is the same outcome: gone.
      await memberRepository.remove(workspace._id, userId);
      await credentialRelease.release({ userId, workspaceId: workspace._id });
      await revokeInvitesBy(workspace, userId, "left");
      logger("info", "workspace.member_left", { workspaceId: workspace._id.toHexString(), memberId: String(userId) });
      return { left: true };
    },
  };
}
