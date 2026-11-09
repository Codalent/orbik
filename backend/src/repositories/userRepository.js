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
    /** Creates a validated operational user record. */
    async create({ email, passwordHash, status = "active" }) {
      const now = new Date();
      const document = {
        email: canonicalizeEmail(email),
        passwordHash,
        status,
        selectedWorkspaceId: null,
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

    /** Resolves a session user without exposing the password hash. */
    findActiveById(userId) {
      return collection.findOne(
        { _id: toObjectId(userId), status: "active" },
        { projection: { email: 1, status: 1, selectedWorkspaceId: 1 } },
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

    /** Replaces an active account's password hash, for a password reset. */
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
