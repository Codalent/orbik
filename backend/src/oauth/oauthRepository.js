import { toObjectId } from "@orbik/core";
import { ObjectId } from "mongodb";

import { coversWorkspace, describeReads, workspacesOf } from "../mcp/credentialWorkspaces.js";
import { normaliseScopes } from "../mcp/scopes.js";

/**
 * Creates the persistence adapter for Orbik acting as an OAuth authorization server.
 *
 * One adapter rather than five, because the five collections are one object graph with one
 * lifetime: a request becomes a code, a code becomes a grant, a grant owns its tokens, and every
 * one of them is read by the same two endpoints. Splitting them would mean a service that joins
 * them by hand and five files that only ever change together.
 *
 * Nothing here holds a usable credential. Codes and tokens are stored as SHA-256 digests of
 * 256-bit random secrets and looked up by identifier, never by the digest — a digest you can query
 * for is a digest an attacker who read the collection can use.
 *
 * @param {object} collections handles from `getCollections`
 * @param {() => Date} [now] clock; defaults to the system clock
 */
export function createOauthRepository(collections, now = () => new Date()) {
  const clients = collections.oauthClients;
  const requests = collections.oauthRequests;
  const codes = collections.oauthCodes;
  const grants = collections.oauthGrants;
  const tokens = collections.oauthTokens;

  return {
    // ---------------------------------------------------------------------------------------
    // Clients

    /** Finds a client by the identifier it presents, registered or published. */
    findClient(clientId) {
      return clients.findOne({ clientId });
    },

    /**
     * Stores what a client says about itself, replacing any earlier copy.
     *
     * An upsert rather than an insert because a published metadata document is re-read when the
     * cached copy goes stale, and a client that changed its redirect URIs should take effect on
     * the next authorization rather than on the next deployment.
     */
    async saveClient({ clientId, kind, metadata }) {
      const current = now();
      await clients.updateOne(
        { clientId },
        {
          $set: { kind, ...metadata, updatedAt: current },
          $setOnInsert: { clientId, createdAt: current },
        },
        { upsert: true },
      );
      return clients.findOne({ clientId });
    },

    // ---------------------------------------------------------------------------------------
    // Authorization requests

    /** Records one validated authorization request for the consent screen to pick up. */
    async createRequest(request) {
      const document = { ...request, createdAt: now() };
      const result = await requests.insertOne(document);
      return { ...document, _id: result.insertedId };
    },

    /** Finds a request that has not expired. An expired one is indistinguishable from no request. */
    findRequest(requestId) {
      if (!ObjectId.isValid(requestId)) return null;
      return requests.findOne({ _id: toObjectId(requestId), expiresAt: { $gt: now() } });
    },

    /**
     * Consumes one request, returning it only if this call is the one that consumed it.
     *
     * A delete rather than a flag, and the delete's own result is the answer: two tabs approving
     * the same consent screen race, and only the one that actually removed the row may issue a
     * code. The alternative — read, then delete — issues two codes for one consent.
     */
    async consumeRequest(requestId) {
      if (!ObjectId.isValid(requestId)) return null;
      const result = await requests.findOneAndDelete({
        _id: toObjectId(requestId),
        expiresAt: { $gt: now() },
      });
      return result ?? null;
    },

    // ---------------------------------------------------------------------------------------
    // Authorization codes

    /** Records one authorization code against everything the token endpoint must check. */
    async createCode(code) {
      const document = { ...code, createdAt: now() };
      const result = await codes.insertOne(document);
      return { ...document, _id: result.insertedId };
    },

    /**
     * Consumes one code, returning it only if this call is the one that consumed it.
     *
     * Single use is enforced by the delete rather than by a `used` flag, for the same reason the
     * request is: a replayed code must fail even when the replay arrives in the same millisecond
     * as the original.
     */
    async consumeCode(codeId) {
      if (!ObjectId.isValid(codeId)) return null;
      const result = await codes.findOneAndDelete({
        _id: toObjectId(codeId),
        expiresAt: { $gt: now() },
      });
      return result ?? null;
    },

    // ---------------------------------------------------------------------------------------
    // Grants

    /**
     * Creates or updates the grant for one person and one client.
     *
     * One live grant per person and client: approving the same app again replaces what it may read
     * and keeps its tokens, so a second install of the same client keeps working and reads the new
     * set rather than adding a connection beside the first. When there is no live grant, the
     * newest revoked one is revived rather than a row added, which is what re-approving always did.
     * Rows written before sets existed may hold several live grants for one pair, one per
     * workspace; the newest is updated and the others are left for the person to disconnect.
     *
     * A row is inserted only when the pair has none at all. That keeps the unique index on
     * `{userId, clientId, workspaceId}` — written when a grant named one workspace — meaningful
     * without a migration: rows written now carry no `workspaceId`, so the index allows one such
     * row per pair, which is exactly the rule, and a second approval racing the first fails on it
     * and is retried as an update. A legacy row that is updated keeps its old `workspaceId`;
     * `workspaces` is what it means from then on (`workspacesOf`).
     *
     * Scopes are replaced rather than merged: the grant records what was agreed to this time, and
     * a union of every scope ever asked for is not something anybody consented to.
     *
     * The client's name is copied onto the grant rather than joined from `oauth_clients`, so the
     * settings page shows the name the person saw when they approved it. A client that renames
     * itself afterwards must not be able to relabel a connection somebody already agreed to.
     *
     * @param {object} grant
     * @param {{mode: "all"} | {mode: "selected", ids: ObjectId[]}} grant.workspaces what it may read
     */
    async upsertGrant({ userId, clientId, clientName, workspaces, scopes }) {
      const pair = { userId: toObjectId(userId), clientId };
      const update = async () => {
        const current = now();
        const existing =
          (await grants.findOne({ ...pair, revokedAt: null }, { sort: { createdAt: -1 } })) ??
          (await grants.findOne(pair, { sort: { revokedAt: -1, createdAt: -1 } }));
        if (!existing) return null;
        return grants.findOneAndUpdate(
          { _id: existing._id },
          { $set: { clientName, workspaces, scopes, revokedAt: null, updatedAt: current } },
          { returnDocument: "after" },
        );
      };

      const updated = await update();
      if (updated) return updated;

      const current = now();
      try {
        const document = { ...pair, clientName, workspaces, scopes, revokedAt: null, lastUsedAt: null, createdAt: current, updatedAt: current };
        const result = await grants.insertOne(document);
        return { ...document, _id: result.insertedId };
      } catch (error) {
        // Another approval for the same pair inserted first; it is now the row to update.
        if (error?.code !== 11000) throw error;
        return update();
      }
    },

    /** Finds a live grant. A revoked one is refused here so nothing downstream has to remember to. */
    findUsableGrant(grantId) {
      if (!ObjectId.isValid(grantId)) return null;
      return grants.findOne({ _id: toObjectId(grantId), revokedAt: null });
    },

    /**
     * Lists the apps one person has connected that may read one workspace, newest first, revoked
     * ones included.
     */
    listGrantsCovering(userId, workspaceId) {
      return grants
        .find({ userId: toObjectId(userId), ...coversWorkspace(workspaceId) })
        .sort({ createdAt: -1 })
        .limit(100)
        .toArray();
    },

    /**
     * Retires one grant that covers this workspace — the whole grant, everywhere it reads — keeping
     * the row so the person can still see what was connected and when.
     */
    revokeGrant(userId, workspaceId, grantId) {
      if (!ObjectId.isValid(grantId)) return null;
      const current = now();
      return grants.findOneAndUpdate(
        {
          _id: toObjectId(grantId),
          userId: toObjectId(userId),
          revokedAt: null,
          ...coversWorkspace(workspaceId),
        },
        { $set: { revokedAt: current, updatedAt: current } },
        { returnDocument: "after" },
      );
    },

    /** Stamps a grant as used, for the "last used" line beside it on the settings page. */
    touchGrant(grantId) {
      return grants.updateOne({ _id: toObjectId(grantId) }, { $set: { lastUsedAt: now() } });
    },

    // ---------------------------------------------------------------------------------------
    // Tokens

    /** Records one issued token against the grant it belongs to. */
    async createToken({ grantId, kind, tokenHash, expiresAt }) {
      const document = {
        grantId: toObjectId(grantId),
        kind,
        tokenHash,
        expiresAt,
        createdAt: now(),
        rotatedAt: null,
      };
      const result = await tokens.insertOne(document);
      return { ...document, _id: result.insertedId };
    },

    /** Finds an unexpired token of one kind by its identifier. */
    findLiveToken(tokenId, kind) {
      if (!ObjectId.isValid(tokenId)) return null;
      return tokens.findOne({ _id: toObjectId(tokenId), kind, expiresAt: { $gt: now() } });
    },

    /**
     * Retires one refresh token, returning it only if this call is the one that retired it.
     *
     * The guard is `rotatedAt: null`, so two clients racing on the same refresh token produce one
     * success and one `invalid_grant` rather than two live token families.
     */
    async rotateRefreshToken(tokenId) {
      if (!ObjectId.isValid(tokenId)) return null;
      const result = await tokens.findOneAndUpdate(
        { _id: toObjectId(tokenId), kind: "refresh", rotatedAt: null, expiresAt: { $gt: now() } },
        { $set: { rotatedAt: now() } },
        { returnDocument: "after" },
      );
      return result ?? null;
    },

    /**
     * Destroys every token issued under a grant.
     *
     * Deleted rather than marked, because a revoked grant is already the record of what happened
     * and a dead token's row says nothing further. This is what makes revoking take effect on the
     * connector's next call rather than when its access token happens to expire.
     */
    async deleteTokensForGrant(grantId) {
      const result = await tokens.deleteMany({ grantId: toObjectId(grantId) });
      return result.deletedCount;
    },
  };
}

/**
 * Converts a stored grant to the shape the settings page renders.
 *
 * @param {object} grant the stored row
 * @param {Array<object>} accessible the workspaces the person who approved it can read, which
 *   `reads` names the set from
 */
export function toGrantSummary(grant, accessible) {
  return {
    id: grant._id.toHexString(),
    clientId: grant.clientId,
    clientName: grant.clientName ?? grant.clientId,
    // `orbik:read`, and `orbik:write` when the person allowed the app to write: the card says which.
    scopes: normaliseScopes(grant.scopes),
    reads: describeReads(workspacesOf(grant), accessible),
    status: grant.revokedAt ? "revoked" : "active",
    lastUsedAt: grant.lastUsedAt ? grant.lastUsedAt.toISOString() : null,
    revokedAt: grant.revokedAt ? grant.revokedAt.toISOString() : null,
    createdAt: grant.createdAt.toISOString(),
  };
}
