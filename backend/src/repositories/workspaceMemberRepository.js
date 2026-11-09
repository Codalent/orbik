import { toObjectId } from "@orbik/core";

import { MEMBER_ROLES } from "../services/workspaceAccess.js";

/**
 * The rows the access check honours: a member role, and not the owner (whose access is the
 * workspace's `ownerId`, never a row). A row outside this grants nothing, so it is not listed, not
 * counted against the limit, and does not make its person "already a member".
 */
function validRows(workspaceId, ownerId) {
  return {
    workspaceId: toObjectId(workspaceId),
    role: { $in: [...MEMBER_ROLES] },
    ...(ownerId ? { userId: { $ne: toObjectId(ownerId) } } : {}),
  };
}

/**
 * Creates persistence operations for `workspace_members`: who besides the owner may open a
 * workspace, and as what.
 *
 * The owner never has a row here, so nothing in this file can make, change or remove one. The
 * unique `(workspaceId, userId)` index is what keeps a person to one role per workspace however
 * many invites they accept and however often a request is retried.
 *
 * @param {import("mongodb").Collection} collection `workspace_members`
 */
export function createWorkspaceMemberRepository(collection) {
  return {
    /** Every valid member row of a workspace, first to join first. */
    listForWorkspace(workspaceId, ownerId) {
      return collection
        .find(validRows(workspaceId, ownerId))
        .sort({ createdAt: 1, _id: 1 })
        .toArray();
    },

    /** One person's row in one workspace, whatever it holds, or null. */
    find(workspaceId, userId) {
      return collection.findOne({ workspaceId: toObjectId(workspaceId), userId: toObjectId(userId) });
    },

    /** One person's row in one workspace when it is one the access check honours, or null. */
    findValid(workspaceId, ownerId, userId) {
      return collection.findOne({ ...validRows(workspaceId, ownerId), userId: toObjectId(userId) });
    },

    /** How many people besides the owner belong to a workspace: what `limits.maxMembers` counts. */
    count(workspaceId, ownerId) {
      return collection.countDocuments(validRows(workspaceId, ownerId));
    },

    /**
     * Whether a row is among the first `limit` valid rows of its workspace, in the order they were
     * made. Of several acceptances racing past the limit, the earliest rows are the ones kept.
     */
    async isWithinLimit(workspaceId, ownerId, rowId, limit) {
      const first = await collection
        .find(validRows(workspaceId, ownerId))
        .sort({ _id: 1 })
        .limit(limit)
        .project({ _id: 1 })
        .toArray();
      return first.some((row) => row._id.equals(rowId));
    },

    /**
     * Adds a person with a role unless they already belong, in which case their role is left as
     * it is. A row the access check would ignore — an unknown role — is replaced by a new one with
     * the role given. Returns the row as it stands and whether this call made it.
     */
    async addIfAbsent({ workspaceId, userId, role, invitedBy }) {
      const filter = { workspaceId: toObjectId(workspaceId), userId: toObjectId(userId) };
      await collection.deleteOne({ ...filter, role: { $nin: [...MEMBER_ROLES] } });
      const now = new Date();
      let created = false;
      try {
        const result = await collection.updateOne(
          filter,
          {
            $setOnInsert: {
              ...filter,
              role,
              invitedBy: invitedBy ? toObjectId(invitedBy) : null,
              createdAt: now,
              updatedAt: now,
            },
          },
          { upsert: true },
        );
        created = result.upsertedCount === 1;
      } catch (error) {
        // Two upserts racing on the unique index: the other one made the row, which is the outcome.
        if (error.code !== 11000) throw error;
      }
      return { member: await collection.findOne(filter), created };
    },

    /** Sets a member's role; the updated row, or null when they are not a member. */
    updateRole(workspaceId, userId, role) {
      return collection.findOneAndUpdate(
        { workspaceId: toObjectId(workspaceId), userId: toObjectId(userId) },
        { $set: { role, updatedAt: new Date() } },
        { returnDocument: "after" },
      );
    },

    /** Removes a member; whether there was one to remove. */
    async remove(workspaceId, userId) {
      const result = await collection.deleteOne({ workspaceId: toObjectId(workspaceId), userId: toObjectId(userId) });
      return result.deletedCount === 1;
    },

    /** Removes exactly the row a failed acceptance just made, and nothing a later one did. */
    async removeRow(rowId) {
      await collection.deleteOne({ _id: toObjectId(rowId) });
    },
  };
}
