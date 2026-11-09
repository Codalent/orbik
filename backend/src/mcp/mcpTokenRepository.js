import { toObjectId } from "@orbik/core";
import { ObjectId } from "mongodb";

import { coversWorkspace, describeReads, workspacesOf } from "./credentialWorkspaces.js";
import { normaliseScopes } from "./scopes.js";

/**
 * Creates the persistence adapter for the tokens a person's own AI client reads their workspaces
 * with.
 *
 * A token names a *set* of the workspaces its holder can read, decided when it is minted: the one
 * whose page minted it, or all of them, now and later (`credentialWorkspaces.js`). A set is as safe
 * as the single workspace tokens used to name, for one reason: it is never trusted as stored. On
 * every request the MCP endpoint intersects it with the workspaces the person can read at that
 * moment — owned or as a member — and a client that names a workspace can only pick a member of
 * that intersection. A token is its holder's alone: every query here is by `userId`, so a
 * workspace's owner never lists or revokes a token one of its members minted. Rows minted before
 * sets existed carry one `workspaceId` and are read as a set of that one.
 *
 * Only a hash of the secret is stored, and lookup is by identifier. Looking a token up *by* a hash
 * of itself would be simpler and is the mistake worth naming — a hash you can query for is a hash
 * an attacker who read the collection can use.
 *
 * @param {import("mongodb").Collection} collection the `mcp_tokens` collection
 * @param {() => Date} [now] clock; defaults to the system clock
 */
export function createMcpTokenRepository(collection, now = () => new Date()) {
  return {
    /**
     * Records a new token and returns it with its generated identifier.
     *
     * @param {object} token
     * @param {{mode: "all"} | {mode: "selected", ids: ObjectId[]}} token.workspaces what it may read
     */
    async create({ userId, workspaces, name, scopes, secretHash, createdFromIp = null }) {
      const current = now();
      const token = {
        userId: toObjectId(userId),
        workspaces,
        name,
        scopes,
        secretHash,
        createdFromIp,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: current,
        updatedAt: current,
      };
      const result = await collection.insertOne(token);
      return { ...token, _id: result.insertedId };
    },

    /**
     * Finds a usable token by its identifier.
     *
     * Revoked rows are refused here rather than by the caller, so revocation takes effect on the
     * next request without anything downstream having to remember to check.
     */
    findUsableById(tokenId) {
      if (!ObjectId.isValid(tokenId)) return null;
      return collection.findOne({ _id: toObjectId(tokenId), revokedAt: null });
    },

    /**
     * Lists every token of one person whose set includes one workspace, newest first, revoked ones
     * included — which is what that workspace's settings card shows.
     */
    listCovering(userId, workspaceId) {
      return collection
        .find({ userId: toObjectId(userId), ...coversWorkspace(workspaceId) })
        .sort({ createdAt: -1 })
        .limit(100)
        .toArray();
    },

    /**
     * One person's unrevoked tokens, with only what says which workspaces each reads — for the
     * live-token ceiling, which counts the ones that still read something.
     */
    listLive(userId) {
      return collection
        .find({ userId: toObjectId(userId), revokedAt: null })
        .project({ workspaces: 1, workspaceId: 1 })
        .toArray();
    },

    /**
     * Retires one token, keeping the row.
     *
     * Addressed through one workspace the token covers — the card it was revoked from — and retires
     * the whole token, everywhere it reads: a credential somebody wants stopped is stopped, not
     * stopped here and left working on their other sites.
     *
     * The row stays so "last used" survives a revoke: the useful question after revoking a token
     * somebody found in a dotfile is when it was last used, and a deleted row cannot answer it.
     */
    revoke(userId, workspaceId, tokenId) {
      if (!ObjectId.isValid(tokenId)) return null;
      const current = now();
      return collection.findOneAndUpdate(
        {
          _id: toObjectId(tokenId),
          userId: toObjectId(userId),
          revokedAt: null,
          ...coversWorkspace(workspaceId),
        },
        { $set: { revokedAt: current, updatedAt: current } },
        { returnDocument: "after" },
      );
    },

    /**
     * Stamps a token as used.
     *
     * Not awaited by the request that triggers it, and deliberately unconditional: this is the
     * only signal a person has that a token they have forgotten about is still live, and it is
     * worth one write per request to keep it honest.
     */
    touch(tokenId) {
      return collection.updateOne({ _id: toObjectId(tokenId) }, { $set: { lastUsedAt: now() } });
    },
  };
}

/**
 * Converts a stored token to the shape the settings page renders. Never includes the hash.
 *
 * @param {object} token the stored row
 * @param {Array<object>} accessible the workspaces the holder can read, which `reads` names the
 *   set from
 */
export function toMcpTokenSummary(token, accessible) {
  return {
    id: token._id.toHexString(),
    name: token.name,
    // `orbik:read`, and `orbik:write` when it may write to the Library: the card says which.
    scopes: normaliseScopes(token.scopes),
    reads: describeReads(workspacesOf(token), accessible),
    status: token.revokedAt ? "revoked" : "active",
    lastUsedAt: token.lastUsedAt ? token.lastUsedAt.toISOString() : null,
    revokedAt: token.revokedAt ? token.revokedAt.toISOString() : null,
    createdAt: token.createdAt.toISOString(),
  };
}
