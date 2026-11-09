import { toObjectId } from "@orbik/core";
import { ObjectId } from "mongodb";

/** What makes an invite pending at a given moment: neither accepted, nor revoked, nor expired. */
function pendingAt(now) {
  return { acceptedAt: null, revokedAt: null, expiresAt: { $gt: now } };
}

/**
 * Creates persistence operations for `workspace_invites`.
 *
 * A row is found by the SHA-256 of its link's token, which is all that is stored of it: a copy of
 * this collection names who was invited, and lets nobody in. Rows are never deleted. Accepting and
 * revoking set a date, so a used or revoked link can still say what it was.
 *
 * It also reads the one thing about a workspace an invite needs and the access check cannot give —
 * the workspace behind a link opened by somebody who does not belong to it yet: its name, its
 * owner and its limits.
 *
 * @param {import("mongodb").Collection} collection `workspace_invites`
 * @param {import("mongodb").Collection} workspaces `workspaces`, read only
 */
export function createWorkspaceInviteRepository(collection, workspaces) {
  return {
    /** Stores a new invite, pending until it is accepted, revoked or seven days old. */
    async create({ workspaceId, email, role, tokenHash, invitedBy, createdAt = new Date(), expiresAt }) {
      const document = {
        workspaceId: toObjectId(workspaceId),
        email,
        role,
        tokenHash,
        invitedBy: invitedBy ? toObjectId(invitedBy) : null,
        createdAt,
        expiresAt,
        acceptedAt: null,
        acceptedBy: null,
        revokedAt: null,
      };
      const result = await collection.insertOne(document);
      return { ...document, _id: result.insertedId };
    },

    /** The invite a link's token hash names, in whatever state it is. */
    findByTokenHash(tokenHash) {
      return collection.findOne({ tokenHash });
    },

    /** A workspace's pending invites, newest first. */
    listPending(workspaceId, now = new Date()) {
      return collection
        .find({ workspaceId: toObjectId(workspaceId), ...pendingAt(now) })
        .sort({ createdAt: -1, _id: -1 })
        .toArray();
    },

    /** Revokes one pending invite of a workspace; the revoked row, or null when there was none. */
    revokePending(workspaceId, inviteId, now = new Date()) {
      if (!ObjectId.isValid(inviteId)) return Promise.resolve(null);
      return collection.findOneAndUpdate(
        { _id: toObjectId(inviteId), workspaceId: toObjectId(workspaceId), ...pendingAt(now) },
        { $set: { revokedAt: now } },
        { returnDocument: "after" },
      );
    },

    /**
     * Revokes the pending invites to one address in one workspace that were made before `newerId`;
     * how many there were. Run after the new invite is stored, so of two made at once the newer
     * one is the one left pending, whichever finishes first.
     */
    async revokeOlderPending(workspaceId, email, newerId, now = new Date()) {
      const result = await collection.updateMany(
        { workspaceId: toObjectId(workspaceId), email, _id: { $lt: toObjectId(newerId) }, ...pendingAt(now) },
        { $set: { revokedAt: now } },
      );
      return result.modifiedCount;
    },

    /**
     * Revokes the pending invites one person issued in one workspace; how many there were. An
     * invite carries its inviter's authority, so it ends with that authority: when they are
     * removed, leave, or stop being an admin.
     */
    async revokePendingByInviter(workspaceId, inviterId, now = new Date()) {
      const result = await collection.updateMany(
        { workspaceId: toObjectId(workspaceId), invitedBy: toObjectId(inviterId), ...pendingAt(now) },
        { $set: { revokedAt: now } },
      );
      return result.modifiedCount;
    },

    /**
     * Marks an invite accepted if, and only if, it is still pending: the single write that makes a
     * link accept once. Two acceptances racing both reach here and exactly one gets the row back.
     *
     * @returns {Promise<object | null>} the accepted invite, or null when it was not pending
     */
    claim(inviteId, { acceptedBy = null, now = new Date() } = {}) {
      return collection.findOneAndUpdate(
        { _id: toObjectId(inviteId), ...pendingAt(now) },
        { $set: { acceptedAt: now, acceptedBy: acceptedBy ? toObjectId(acceptedBy) : null } },
        { returnDocument: "after" },
      );
    },

    /** Records who a claim was for, once the account it was claimed for exists. */
    async setAcceptedBy(inviteId, acceptedBy) {
      await collection.updateOne({ _id: toObjectId(inviteId) }, { $set: { acceptedBy: toObjectId(acceptedBy) } });
    },

    /**
     * Gives a claimed invite back when what the claim was for could not be finished, so the link
     * still works. Only the claim made at `acceptedAt` is undone, never a later one.
     */
    async release(inviteId, acceptedAt) {
      await collection.updateOne(
        { _id: toObjectId(inviteId), acceptedAt },
        { $set: { acceptedAt: null, acceptedBy: null } },
      );
    },

    /** The fields of a workspace an invite needs, or null when it no longer exists. */
    findWorkspace(workspaceId) {
      return workspaces.findOne(
        { _id: toObjectId(workspaceId) },
        { projection: { name: 1, ownerId: 1, limits: 1 } },
      );
    },
  };
}
