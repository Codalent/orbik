import { toObjectId } from "@orbik/core";
import { ObjectId } from "mongodb";

/**
 * The fields an access check hands a service: the public ones `listOwned` always returned, plus
 * the owner (whom everything a member does is charged to) and the plan's limits. `ownerId` and
 * `limits` stay on the record; `toWorkspaceSummary` never puts them in a response.
 */
const ACCESSIBLE_PROJECTION = Object.freeze({ name: 1, websiteUrl: 1, createdAt: 1, ownerId: 1, limits: 1 });

/** Converts a workspace persistence record to its public summary, with the caller's role when known. */
export function toWorkspaceSummary(workspace) {
  return {
    id: workspace._id.toHexString(),
    name: workspace.name,
    websiteUrl: workspace.websiteUrl,
    createdAt: workspace.createdAt.toISOString(),
    ...(workspace.role ? { role: workspace.role } : {}),
  };
}

/**
 * Creates workspace persistence operations.
 *
 * @param {import("mongodb").Collection} collection `workspaces`
 * @param {import("mongodb").Collection} members `workspace_members`: who besides the owner may
 *   open a workspace, and as what
 */
export function createWorkspaceRepository(collection, members) {
  return {
    /** Atomically inserts one workspace per owner/key and identifies idempotent replays. */
    async createIdempotent({ ownerId, name, websiteUrl, creationKey, creationPayloadHash }) {
      const now = new Date();
      let result;
      try {
        result = await collection.updateOne(
          { ownerId: toObjectId(ownerId), creationKey },
          { $setOnInsert: { ownerId: toObjectId(ownerId), name, websiteUrl, creationKey, creationPayloadHash, createdAt: now, updatedAt: now } },
          { upsert: true },
        );
      } catch (error) {
        if (error.code !== 11000) throw error;
        result = { upsertedCount: 0 };
      }
      const workspace = await collection.findOne({ ownerId: toObjectId(ownerId), creationKey });
      return { workspace, created: result.upsertedCount === 1 };
    },

    /**
     * Changes a workspace's name, website, or both, and returns the record as `findAccessibleById`
     * reads it (without a role). The creation key and its payload hash are left alone: they record
     * what the creation request carried, so a replay of it is still recognised as that request.
     */
    async updateDetails(workspaceId, changes) {
      const set = { updatedAt: new Date() };
      if (changes.name !== undefined) set.name = changes.name;
      if (changes.websiteUrl !== undefined) set.websiteUrl = changes.websiteUrl;
      return collection.findOneAndUpdate(
        { _id: toObjectId(workspaceId) },
        { $set: set },
        { returnDocument: "after", projection: ACCESSIBLE_PROJECTION },
      );
    },

    /** How many workspaces an account owns: what a plan's `maxWorkspaces` counts. */
    countOwned(ownerId) {
      return collection.countDocuments({ ownerId: toObjectId(ownerId) });
    },

    /** The workspace an owner made under one creation key, if any: an idempotent replay's. */
    findByCreationKey(ownerId, creationKey) {
      return collection.findOne({ ownerId: toObjectId(ownerId), creationKey }, { projection: { _id: 1 } });
    },

    /** Lists only an owner's workspaces, newest first with a stable identifier tie-break. */
    listOwned(ownerId) {
      return collection
        .find({ ownerId: toObjectId(ownerId) })
        .sort({ createdAt: -1, _id: -1 })
        .project({ name: 1, websiteUrl: 1, createdAt: 1 })
        .toArray();
    },

    /** Finds a workspace only when both its identifier and owner match. */
    findOwnedById(ownerId, workspaceId) {
      if (!ObjectId.isValid(workspaceId)) return null;
      return collection.findOne(
        { _id: toObjectId(workspaceId), ownerId: toObjectId(ownerId) },
        { projection: { name: 1, websiteUrl: 1, createdAt: 1 } },
      );
    },

    /**
     * Lists every workspace the user can open — the ones they own and the ones they are a member
     * of — each with their `role` in it, in `listOwned`'s order across both kinds.
     *
     * Two indexed reads: the user's membership rows, then one query over `workspaces`. With no
     * membership rows the second is `listOwned`'s own query, so a single-owner account gets the
     * same list it always did, plus `role: "owner"` on each.
     */
    async listAccessible(userId) {
      const user = toObjectId(userId);
      const rows = await members
        .find({ userId: user })
        .project({ workspaceId: 1, role: 1 })
        .toArray();
      const memberRoles = new Map(rows
        .filter((row) => STORED_MEMBER_ROLES.has(row.role))
        .map((row) => [row.workspaceId.toHexString(), row.role]));
      const memberOf = rows.filter((row) => STORED_MEMBER_ROLES.has(row.role)).map((row) => row.workspaceId);
      const filter = memberOf.length
        ? { $or: [{ ownerId: user }, { _id: { $in: memberOf } }] }
        : { ownerId: user };
      const workspaces = await collection
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .project(ACCESSIBLE_PROJECTION)
        .toArray();
      return workspaces.map((workspace) => ({
        ...workspace,
        role: roleOf(workspace, user, memberRoles.get(workspace._id.toHexString())),
      }));
    },

    /**
     * Finds a workspace the user owns or is a member of, with their `role` in it; null for an
     * invalid identifier, a missing workspace, or one the user has no access to.
     */
    async findAccessibleById(userId, workspaceId) {
      if (!ObjectId.isValid(workspaceId)) return null;
      const user = toObjectId(userId);
      const id = toObjectId(workspaceId);
      // Both reads always run, together, so a foreign workspace and a missing one cost the same.
      const [workspace, row] = await Promise.all([
        collection.findOne({ _id: id }, { projection: ACCESSIBLE_PROJECTION }),
        members.findOne({ workspaceId: id, userId: user }, { projection: { role: 1 } }),
      ]);
      if (!workspace) return null;
      if (workspace.ownerId?.equals(user)) return { ...workspace, role: "owner" };
      return STORED_MEMBER_ROLES.has(row?.role) ? { ...workspace, role: row.role } : null;
    },
  };
}

/**
 * The roles a membership row may hold. Anything else on a row — `owner` written by hand, a typo —
 * grants nothing: ownership is only ever the workspace's `ownerId`.
 */
const STORED_MEMBER_ROLES = new Set(["admin", "member", "read-only"]);

/** The owner is the workspace's `ownerId`; anyone else holds the role on their membership row. */
function roleOf(workspace, userId, memberRole) {
  return workspace.ownerId?.equals(userId) ? "owner" : memberRole;
}
