import { toObjectId } from "@orbik/core";

/** Canonicalizes an email address for unique lookup and storage. */
export function canonicalizeEmail(email) {
  return email.trim().normalize("NFC").toLowerCase();
}

/**
 * Creates the persistence adapter for pre-provisioned users.
 * Password hashes are returned only by the dedicated authentication lookup.
 */
export function createUserRepository(collection) {
  return {
    /**
     * Creates a validated operational user record. `passwordHash` is null for an account made by
     * signing in with Google, which has none until a password reset gives it one; `googleSub` links
     * that Google account.
     */
    async create({ email, passwordHash, status = "active", googleSub = null }) {
      const now = new Date();
      const document = {
        email: canonicalizeEmail(email),
        passwordHash,
        status,
        selectedWorkspaceId: null,
        ...(googleSub ? { google: { sub: googleSub, linkedAt: now } } : {}),
        createdAt: now,
        updatedAt: now,
      };
      const result = await collection.insertOne(document);
      return { ...document, _id: result.insertedId };
    },

    /** Finds an active user for password verification, including only required private fields. */
    findActiveForAuthentication(email) {
      return collection.findOne(
        { email: canonicalizeEmail(email), status: "active" },
        { projection: { email: 1, passwordHash: 1, status: 1, selectedWorkspaceId: 1 } },
      );
    },

    /**
     * Resolves a session user without exposing the password hash: only `hasPassword`, whether it
     * has one (an account made by signing in with Google has none until it sets one).
     */
    findActiveById(userId) {
      return collection.findOne(
        { _id: toObjectId(userId), status: "active" },
        { projection: { email: 1, status: 1, selectedWorkspaceId: 1, hasPassword: { $eq: [{ $type: "$passwordHash" }, "string"] } } },
      );
    },

    /** An active account's password hash, to check the current password before changing it. */
    findPasswordHashById(userId) {
      return collection.findOne(
        { _id: toObjectId(userId), status: "active" },
        { projection: { email: 1, passwordHash: 1 } },
      );
    },

    /**
     * Finds the account an address belongs to, whatever its status, without the password hash.
     * An invite asks this to decide between "sign in" and "set a password": an account that exists
     * but is not active still owns its address, so a second one is never created for it.
     */
    findByEmail(email) {
      return collection.findOne(
        { email: canonicalizeEmail(email) },
        { projection: { email: 1, status: 1, selectedWorkspaceId: 1 } },
      );
    },

    /** The account a Google account is linked to, whatever its status, without the password hash. */
    findByGoogleSub(sub) {
      return collection.findOne(
        { "google.sub": String(sub) },
        { projection: { email: 1, status: 1, selectedWorkspaceId: 1 } },
      );
    },

    /**
     * Links a Google account to an active account that has none linked (or this one already).
     * False when the account is linked to another Google account, or is not active.
     */
    async linkGoogle(userId, sub) {
      const now = new Date();
      const result = await collection.updateOne(
        { _id: toObjectId(userId), status: "active", $or: [{ "google.sub": { $exists: false } }, { "google.sub": String(sub) }] },
        { $set: { "google.sub": String(sub), updatedAt: now } },
      );
      if (result.matchedCount === 1) {
        await collection.updateOne({ _id: toObjectId(userId), "google.linkedAt": { $exists: false } }, { $set: { "google.linkedAt": now } });
      }
      return result.matchedCount === 1;
    },

    /**
     * Deletes one account by identifier. Only for undoing an account the same request created —
     * an invite acceptance refused after the account was made — never for an account in use.
     */
    async removeJustCreated(userId) {
      await collection.deleteOne({ _id: toObjectId(userId) });
    },

    /** Reads the addresses of several users at once, for lists that name people. */
    listEmailsByIds(userIds) {
      const ids = [...new Set(userIds.filter(Boolean).map(String))].map((id) => toObjectId(id));
      if (!ids.length) return Promise.resolve([]);
      return collection.find({ _id: { $in: ids } }).project({ email: 1 }).toArray();
    },

    /** Replaces an active account's password hash: a password reset, or a change by its owner. */
    async setPasswordHash(userId, passwordHash) {
      const result = await collection.updateOne(
        { _id: toObjectId(userId), status: "active" },
        { $set: { passwordHash, updatedAt: new Date() } },
      );
      return result.matchedCount === 1;
    },

    /** Persists a workspace selection for an already-authorized user. */
    async setSelectedWorkspace(userId, workspaceId) {
      const result = await collection.updateOne(
        { _id: toObjectId(userId), status: "active" },
        { $set: { selectedWorkspaceId: workspaceId ? toObjectId(workspaceId) : null, updatedAt: new Date() } },
      );
      return result.matchedCount === 1;
    },
  };
}
