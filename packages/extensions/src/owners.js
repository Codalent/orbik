import { COLLECTIONS, toObjectId } from "@orbik/core";

/** How long a workspace's owner is remembered. Ownership does not change in today's product. */
const OWNER_TTL_MS = 60_000;

/**
 * Finds a workspace's owner, whoever acts in it. Plan limits are asked with the owner beside the
 * workspace, so a deployment whose plans are the account's can answer by owner.
 *
 * @param {import("mongodb").Db} database
 * @param {{now?: () => number}} [options]
 * @returns {(workspaceId: unknown) => Promise<import("mongodb").ObjectId|null>}
 */
export function createOwnerLookup(database, { now = () => Date.now() } = {}) {
  const workspaces = database.collection(COLLECTIONS.workspaces);
  const cache = new Map();
  return async function ownerOf(workspaceId) {
    if (!workspaceId) return null;
    let id;
    try { id = toObjectId(workspaceId); } catch { return null; }
    const key = id.toHexString();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.ownerId;
    const workspace = await workspaces.findOne({ _id: id }, { projection: { ownerId: 1 } });
    const ownerId = workspace?.ownerId ?? null;
    cache.set(key, { ownerId, expiresAt: now() + OWNER_TTL_MS });
    return ownerId;
  };
}
