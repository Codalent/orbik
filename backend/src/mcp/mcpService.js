import { AGENT_COLLECTIONS, toObjectId } from "@orbik/core";
import { LIBRARY_WRITE_CHANNELS } from "@orbik/library";
import { TOOLS, createToolRegistry } from "@orbik/tools";
import { ObjectId } from "mongodb";

import { hostOf, isRoaming, materialise, mayWriteIn } from "./credentialWorkspaces.js";
import { mayWrite, normaliseScopes } from "./scopes.js";
import { MCP_READ_TOOLS, MCP_WRITE_TOOLS } from "./tools.js";
import { roleInsufficient } from "./writes.js";

/**
 * Creates the per-request use cases behind the MCP endpoint.
 *
 * Two things happen here and nowhere else. A credential becomes a *set* of workspaces it may read,
 * and a workspace of that set becomes a tool registry. Both are built from the credential and from
 * the database, never from anything the client sent: the set is the credential's stored set
 * intersected with the workspaces its holder can read on this request, and a client's `workspace`
 * argument only ever selects a member of it (`workspaceChoice.js`). No registry tool takes a
 * workspace argument, so once a registry exists there is no value in a call that could point a
 * read at another workspace — the property the whole tool layer rests on, inherited by
 * construction rather than by remembering to check.
 *
 * A registry per call is deliberate. It is a `Map` over frozen definitions and costs nothing, and
 * the alternative — one registry held between requests — would be a cached workspace, which is
 * exactly the thing that must not outlive a revoke.
 *
 * The per-run reading ceiling is not applied, because there is no run: `readingBudget` stays null
 * and each call's own cap is the whole limit. `content_readPages`'s description says so, so a model
 * is not left waiting for a budget figure that never comes.
 *
 * @param {object} options collaborators
 * @param {object} options.mcpTokenService resolves and stamps pasted tokens
 * @param {object} options.oauthService resolves and stamps OAuth access tokens
 * @param {object} options.workspaceRepository the workspaces the person can read, with their role
 *   in each, which a set is cut from
 * @param {object} options.crawlRepository resolves a workspace's crawl site
 * @param {import("mongodb").Db} options.database handed to the tools as their reader
 * @param {object | null} options.retrieval the search index, or null when this API has none
 * @param {{code: string, message: string} | null} options.retrievalReason why it has none
 * @param {object | null} [options.assetUrls] mints the signed links the brand tools hand out for
 *   images; null when this API has no secret to sign with, and the tools then say so
 */
export function createMcpService({
  mcpTokenService,
  oauthService,
  workspaceRepository,
  crawlRepository,
  database,
  retrieval,
  retrievalReason,
  assetUrls = null,
}) {
  const brandAssets = database.collection(AGENT_COLLECTIONS.brandAssets);

  /**
   * The registry scope for one member of a session's set: its workspace and crawl site, and no
   * agent and no run, because an outside client belongs to neither.
   */
  async function scopeFor(workspace) {
    const site = await crawlRepository.findSiteByWorkspace(workspace.id);
    return {
      workspaceId: toObjectId(workspace.id),
      siteId: site?._id ?? null,
      agentSlug: null,
      runId: null,
    };
  }

  return {
    /** Whether `content_search` can answer at all, and why not when it cannot. */
    retrievalReason: retrieval ? null : retrievalReason,

    /**
     * Turns a bearer string into everything one request needs, or null.
     *
     * Two kinds of credential arrive here and nothing downstream can tell them apart. A pasted
     * token says which workspaces it reads on its own row; an OAuth access token says it through
     * the grant a person approved. Both resolve to the same `{userId, scopes, tokenId, kind,
     * workspaces, client}`, which is what keeps the tool layer unaware that OAuth exists at all.
     * Whether a credential may write is its scopes and nothing else: `orbik:write`, which a person
     * gives a token when minting it and an app when approving it.
     *
     * They are told apart by their prefix rather than tried in turn against each store, so a
     * malformed credential costs one regex instead of two database round trips and an argon2 hash.
     *
     * The set is materialised here, from the workspaces the person can read as they are now —
     * owned, or as a member in any role: "all" is every one of them, a selection is the ones it
     * names that the person can still open. A workspace they were removed from is simply not
     * there. A set that comes out empty is a failure like any other — the same `401` a pinned
     * credential whose one workspace was deleted has always had. Each member of the set carries
     * the role the person holds in it on this request, which is what a write is checked against.
     *
     * Null for every failure. The endpoint answers one `401` with no detail about which part was
     * wrong — an unknown token, a revoked one, a workspace that changed hands or that the person was
     * removed from — because an endpoint
     * that distinguished them would be an oracle for workspace and token identifiers.
     */
    async openSession(bearer) {
      const credential = String(bearer ?? "").startsWith("orba_")
        ? await oauthService.authenticate(bearer)
        : await mcpTokenService.authenticate(bearer);
      if (!credential) return null;

      const accessible = await workspaceRepository.listAccessible(credential.userId);
      const members = materialise(accessible, credential.workspaces).map((workspace) => ({
        id: workspace._id.toHexString(),
        name: workspace.name,
        websiteUrl: workspace.websiteUrl ?? null,
        host: hostOf(workspace.websiteUrl),
        // Never shown to a client as such: it decides whether a write here is refused, and the
        // instructions mention it only where it stops one.
        role: workspace.role,
      }));
      if (!members.length) return null;

      const roaming = isRoaming(credential.workspaces);
      const scopes = normaliseScopes(credential.scopes);
      return {
        userId: credential.userId,
        tokenId: credential.tokenId,
        scopes,
        // Whether the Library write tools exist for this credential. Read from the scopes and
        // nothing else, so it is the same answer for a pasted token and an approved app.
        mayWrite: mayWrite(scopes),
        // The client's name as the credential records it, which a write is attributed through.
        client: credential.client ?? null,
        // Which store to stamp "last used" on. The only place the two kinds are distinguished
        // after this point, and it is a bookkeeping detail rather than an authorization one.
        kind: credential.kind,
        roaming,
        workspaces: members,
        // The one workspace of a pinned credential, which is all a pinned surface ever names.
        workspace: roaming ? null : members[0],
      };
    },

    /**
     * Records that a credential was used, on whichever row the person will look at.
     *
     * For a pasted token that is the token itself; for an OAuth session it is the grant, because
     * the grant is what somebody sees on the settings page — the access token beneath it was
     * replaced an hour ago and will be again.
     */
    touch(session) {
      return session.kind === "oauth"
        ? oauthService.touch(session.tokenId)
        : mcpTokenService.touch(session.tokenId);
    },

    /**
     * Builds the tool registry for one member of a session's set.
     *
     * Takes the member, never an identifier a client sent: callers get one from
     * `chooseWorkspace`, which only ever returns a member of the set this request materialised.
     *
     * The crawl site is looked up per call rather than stored on the credential: a workspace whose
     * first crawl is configured after the token was minted starts answering `content_readPages`
     * without anybody minting a new one.
     *
     * `agentSlug` and `runId` are null, and this registry holds the read tools only. A scope with
     * no agent and no `actor` names no writer, so even a write tool reached through it would be
     * refused by the store: reading stays read-only in two independent ways.
     *
     * @param {{id: string}} workspace a member of the session's set
     */
    async registryFor(workspace) {
      return createToolRegistry({
        tools: TOOLS,
        allowed: MCP_READ_TOOLS,
        scope: await scopeFor(workspace),
        // The signer travels the way the index does: a collaborator holding a secret, built once
        // for the process, which a tool is handed rather than constructs.
        context: { database, retrieval, assetUrls },
        readingBudget: null,
      });
    },

    /**
     * Builds the registry a Library write goes through, for one member of a session's set.
     *
     * Only for a session whose credential holds `orbik:write`, checked here as well as where the
     * tools are registered, so a registry that can write is never built for one that may not; and
     * only for a workspace where the person is a member or above on this request, checked here as
     * well as by the server, so a holder demoted to read-only cannot write through a credential
     * minted before the demotion.
     *
     * It holds the two write tools and nothing else, and its scope carries `actor`: the person the
     * credential belongs to, and the credential and client the write came through. The registry's
     * tools write as that person — what they add is claimed as theirs, exactly as a save from the
     * Library page is — and the store records `updatedBy.via` and holds the write to their locks.
     * Which paths a client may not write at all is decided in front of this, by the server.
     *
     * @param {object} session a session that may write
     * @param {{id: string}} workspace a member of the session's set
     */
    async writerFor(session, workspace) {
      if (!session.mayWrite) {
        throw new Error("A writing registry was asked for by a credential that may not write.");
      }
      if (!mayWriteIn(workspace)) throw roleInsufficient(workspace);
      return createToolRegistry({
        tools: TOOLS,
        allowed: MCP_WRITE_TOOLS,
        scope: {
          ...(await scopeFor(workspace)),
          actor: {
            userId: session.userId,
            via: { kind: LIBRARY_WRITE_CHANNELS.mcp, tokenId: session.tokenId, client: session.client || "your AI" },
          },
        },
        context: { database, retrieval, assetUrls },
        readingBudget: null,
      });
    },

    /**
     * What `workspace_list` answers: the session's set, with whether each site has been crawled.
     *
     * @param {object} session a roaming session
     */
    async listWorkspaces(session) {
      const workspaces = await Promise.all(
        session.workspaces.map(async (workspace) => ({
          id: workspace.id,
          name: workspace.name,
          websiteUrl: workspace.websiteUrl,
          host: workspace.host,
          hasCrawl: Boolean(await crawlRepository.findSiteByWorkspace(workspace.id)),
        })),
      );
      return { workspaces };
    },

    /**
     * The workspace a stored image belongs to, as a hex id, or null when there is no such image.
     *
     * For the one address that names an image without naming its workspace,
     * `orbik://brand/assets/{id}`: the row is read for its owner, and the caller checks that owner
     * against the session's set before anything is served.
     */
    async assetWorkspace(assetId) {
      if (!/^[0-9a-f]{24}$/i.test(String(assetId ?? ""))) return null;
      const asset = await brandAssets.findOne({ _id: new ObjectId(assetId) }, { projection: { workspaceId: 1 } });
      return asset?.workspaceId ? toObjectId(asset.workspaceId).toHexString() : null;
    },
  };
}
