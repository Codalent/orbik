import { toObjectId } from "@orbik/core";

/**
 * Lets go of one person's credentials on a workspace they can no longer open.
 *
 * The per-request intersection (`credentialWorkspaces.materialise`) already stops a credential
 * reading a workspace its holder was removed from, so nothing here is what keeps a workspace safe.
 * It exists for what that intersection leaves behind. A token or grant whose selection named only
 * that workspace answers `401` from then on, yet it is still live: it is listed on no card the
 * person can open (its only card now answers `404`), so they cannot see or revoke it; a token
 * counts against their twenty; an app's refresh tokens keep rotating; and on a later invite back
 * it would start working again, with whatever scope it was minted with, without anybody choosing
 * that. So the member service calls this when a person is removed or leaves, for that person
 * only:
 *
 * - a token or grant whose stored selection names this workspace and nothing else — including a
 *   row written before sets existed, whose single `workspaceId` is this one — is revoked, as the
 *   card's Revoke or Disconnect would, and a revoked grant's issued tokens are destroyed;
 * - a selection that names this workspace among others loses it, and keeps reading the rest;
 * - a set of "all" is left alone: it means every workspace the person can read, which no longer
 *   includes this one, and will include whatever they join next.
 *
 * Revoked rows are kept, like every revocation, so "last used" survives. Other people's
 * credentials are never touched: the owner's and the other members' sets are theirs.
 *
 * @param {object} collections handles from `getCollections`: `mcpTokens`, `oauthGrants`,
 *   `oauthTokens`
 * @param {() => Date} [now] clock; defaults to the system clock
 */
export function createCredentialRelease({ mcpTokens, oauthGrants, oauthTokens }, now = () => new Date()) {
  /**
   * Revokes the live rows that named only this workspace, then removes it from live selections
   * that named others too. In that order, so a one-workspace selection is revoked rather than
   * narrowed to nothing.
   *
   * @returns {Promise<{revoked: import("mongodb").ObjectId[], narrowed: number}>}
   */
  async function releaseIn(collection, user, workspace) {
    const current = now();
    const live = { userId: user, revokedAt: null };
    const onlyThis = {
      ...live,
      $or: [
        { "workspaces.mode": "selected", "workspaces.ids": { $size: 1 }, "workspaces.ids.0": workspace },
        { workspaces: { $exists: false }, workspaceId: workspace },
      ],
    };
    const doomed = await collection.find(onlyThis).project({ _id: 1 }).toArray();
    const revoked = doomed.map((row) => row._id);
    if (revoked.length) {
      await collection.updateMany(
        { _id: { $in: revoked }, revokedAt: null },
        { $set: { revokedAt: current, updatedAt: current } },
      );
    }
    const narrowed = await collection.updateMany(
      { ...live, "workspaces.mode": "selected", "workspaces.ids": workspace },
      { $pull: { "workspaces.ids": workspace }, $set: { updatedAt: current } },
    );
    return { revoked, narrowed: narrowed.modifiedCount };
  }

  /**
   * Deletes everybody's rows that read only this workspace, and takes it out of everybody's
   * selections that read others too. For a workspace that is being deleted.
   *
   * @returns {Promise<{deleted: import("mongodb").ObjectId[], narrowed: number}>}
   */
  async function forgetIn(collection, workspace, beforeDelete = async () => {}) {
    const onlyThis = {
      $or: [
        { "workspaces.mode": "selected", "workspaces.ids": { $size: 1 }, "workspaces.ids.0": workspace },
        { workspaces: { $exists: false }, workspaceId: workspace },
      ],
    };
    const doomed = (await collection.find(onlyThis).project({ _id: 1 }).toArray()).map((row) => row._id);
    if (doomed.length) {
      await beforeDelete(doomed);
      await collection.deleteMany({ _id: { $in: doomed } });
    }
    const narrowed = await collection.updateMany(
      { "workspaces.mode": "selected", "workspaces.ids": workspace },
      { $pull: { "workspaces.ids": workspace }, $set: { updatedAt: now() } },
    );
    return { deleted: doomed, narrowed: narrowed.modifiedCount };
  }

  return {
    /**
     * Lets go of every credential on a workspace that is being deleted, whoever holds it.
     *
     * Unlike {@link release}, which revokes and keeps the row so its card can still say when it
     * was last used, this deletes: the card was listed under the workspace, and with the
     * workspace gone there is nowhere a row reading only it could ever be shown or revoked. A
     * token or grant that also reads other workspaces keeps reading them; a set of "all" is left
     * alone, and simply no longer includes this one. The issued tokens of a deleted grant go with
     * it. Idempotent.
     *
     * @param {object} options
     * @param {string | import("mongodb").ObjectId} options.workspaceId the workspace being deleted
     * @returns {Promise<{tokensDeleted: number, tokensNarrowed: number, grantsDeleted: number,
     *   grantsNarrowed: number, oauthTokensDeleted: number}>}
     */
    async forgetWorkspace({ workspaceId }) {
      const workspace = toObjectId(workspaceId);
      const tokens = await forgetIn(mcpTokens, workspace);
      // A grant's issued tokens go before the grant, so a retry after a failure between the two
      // still finds the grant, and through it the tokens.
      let oauthTokensDeleted = 0;
      const grants = await forgetIn(oauthGrants, workspace, async (ids) => {
        oauthTokensDeleted = (await oauthTokens.deleteMany({ grantId: { $in: ids } })).deletedCount;
      });
      return {
        tokensDeleted: tokens.deleted.length,
        tokensNarrowed: tokens.narrowed,
        grantsDeleted: grants.deleted.length,
        grantsNarrowed: grants.narrowed,
        oauthTokensDeleted,
      };
    },

    /**
     * Releases one person's credentials on one workspace. Idempotent: a second call finds nothing.
     *
     * @param {object} options
     * @param {string | import("mongodb").ObjectId} options.userId the person who lost access
     * @param {string | import("mongodb").ObjectId} options.workspaceId the workspace they lost
     * @returns {Promise<{tokensRevoked: number, tokensNarrowed: number, grantsRevoked: number,
     *   grantsNarrowed: number, oauthTokensDeleted: number}>}
     */
    async release({ userId, workspaceId }) {
      const user = toObjectId(userId);
      const workspace = toObjectId(workspaceId);
      const tokens = await releaseIn(mcpTokens, user, workspace);
      const grants = await releaseIn(oauthGrants, user, workspace);
      // As disconnecting an app does: a revoked grant's access and refresh tokens go with it, so
      // the app's next call and its next refresh both fail.
      const deleted = grants.revoked.length
        ? await oauthTokens.deleteMany({ grantId: { $in: grants.revoked } })
        : { deletedCount: 0 };
      return {
        tokensRevoked: tokens.revoked.length,
        tokensNarrowed: tokens.narrowed,
        grantsRevoked: grants.revoked.length,
        grantsNarrowed: grants.narrowed,
        oauthTokensDeleted: deleted.deletedCount,
      };
    },
  };
}
