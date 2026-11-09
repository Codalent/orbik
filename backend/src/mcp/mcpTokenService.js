import { randomBytes } from "node:crypto";

import argon2 from "argon2";

import { AppError } from "../errors/appError.js";
import { toMcpTokenSummary } from "./mcpTokenRepository.js";
import { materialise, requireWriteRole, toStoredWorkspaces, workspacesOf } from "./credentialWorkspaces.js";
import { normaliseScopes, scopesFor } from "./scopes.js";
import { createWorkspaceAccessCheck } from "../services/workspaceAccess.js";

/** Bytes of entropy in a token secret. */
const SECRET_BYTES = 32;

/**
 * How many live tokens one person may hold at once, across all their workspaces.
 *
 * Per person rather than per workspace since a token may read several: a token that reads every
 * workspace would otherwise count against each of them, or against none. Not a security boundary —
 * a person who can mint one can mint another — but a list that has grown to hundreds is a list
 * nobody reads, and an unread list of long-lived credentials is how a forgotten one survives.
 */
const MAX_ACTIVE_TOKENS = 20;

/**
 * Parses a bearer string into the token identifier it names, without verifying it.
 *
 * Exported because the rate limiter needs a key *before* the secret is checked: argon2id is
 * deliberately expensive, so a caller who could make the API hash an unbounded number of wrong
 * secrets would have a cheap way to spend the API's CPU. Keying the limit on the unverified
 * identifier costs nothing and is enough — an attacker choosing a fresh identifier per attempt is
 * refused by the lookup before any hashing happens.
 */
export function mcpTokenIdFrom(bearer) {
  return /^orbm_([0-9a-f]{24})_[A-Za-z0-9_-]{16,128}$/.exec(bearer ?? "")?.[1] ?? null;
}

/**
 * Creates the lifecycle and authentication use cases for MCP credentials.
 *
 * Shaped `orbm_<tokenId>_<secret>`.
 *
 * There is no expiry. An editor's `.mcp.json` is a long-lived credential by nature, and a token
 * that stopped working on a Tuesday for no visible reason would be reported as a broken product.
 * Revocation is immediate instead, and "last used" is what makes a forgotten token visible.
 *
 * @param {object} options collaborators
 * @param {object} options.mcpTokenRepository persistence adapter
 * @param {object} options.workspaceRepository used to prove the caller can read the workspaces a
 *   token names, with the role they hold in each, and to name them on the settings page
 */
export function createMcpTokenService({ mcpTokenRepository, workspaceRepository }) {
  const requireWorkspaceAccess = createWorkspaceAccessCheck(workspaceRepository);
  // The Connect your AI card is open to every role: a read-only member may mint a token that reads,
  // and what they hold is theirs alone to list and revoke.
  const requireCardAccess = (userId, workspaceId) => requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });

  return {
    /**
     * Mints a token and returns the secret, once.
     *
     * Minted from one workspace's page, which is the workspace it reads unless the person chose
     * otherwise: every workspace they can read, now and later, or a selection that includes this
     * one. A selection must name only workspaces the caller can read — owned or as a member, in any
     * role — and must include the page's own, so a token is always listed on the card it was
     * minted from.
     *
     * The secret is assembled after the insert because it carries the generated identifier, and it
     * is never stored: the row holds an argon2id hash, so this response is the only time the token
     * exists in a form anybody can use.
     *
     * A token reads, and writes to the Library only when the person ticked the box that says so:
     * `orbik:write` is never implied by anything else, and a token's scopes never change after it
     * is minted — a person who wants a token that writes mints one. The box needs the member role
     * or above in every workspace the token covers now — for "all", every workspace the person can
     * read — and is refused `403 ROLE_INSUFFICIENT` otherwise; a later demotion is caught where
     * each write is made, by the MCP endpoint.
     *
     * @param {object} options
     * @param {{mode: "all"} | {mode: "selected", ids: string[]} | null} [options.workspaces] what the
     *   token reads; omitted means the page's workspace alone
     * @param {boolean} [options.write] whether it may also write to the Library, as the person
     */
    async createToken({ userId, workspaceId, name, workspaces = null, write = false, createdFromIp = null }) {
      await requireCardAccess(userId, workspaceId);
      const selection = workspaces ?? { mode: "selected", ids: [String(workspaceId)] };
      const accessible = await workspaceRepository.listAccessible(userId);
      if (selection.mode === "selected") {
        if (!selection.ids.includes(String(workspaceId).toLowerCase())) {
          throw new AppError({
            status: 400,
            code: "MCP_TOKEN_WORKSPACE_MISSING",
            message: "A token minted from a workspace's page must read that workspace.",
          });
        }
        const readable = new Set(accessible.map((one) => one._id.toHexString()));
        if (!selection.ids.every((id) => readable.has(id))) {
          throw new AppError({ status: 404, code: "WORKSPACE_NOT_FOUND", message: "Workspace was not found." });
        }
      }
      if (write === true) requireWriteRole(materialise(accessible, toStoredWorkspaces(selection)));

      // A token whose set reads nothing the person can open any more — a selection of workspaces
      // they have left — answers `401` everywhere and is on no card they can see, so it does not
      // hold one of their places. At most a few dozen rows, read with the list above.
      const live = await mcpTokenRepository.listLive(userId);
      const working = live.filter((row) => materialise(accessible, workspacesOf(row)).length > 0).length;
      if (working >= MAX_ACTIVE_TOKENS) {
        throw new AppError({
          status: 409,
          code: "MCP_TOKEN_LIMIT_REACHED",
          message: `You can hold ${MAX_ACTIVE_TOKENS} tokens at once. Revoke one you no longer use.`,
        });
      }

      const secret = randomBytes(SECRET_BYTES).toString("base64url");
      const token = await mcpTokenRepository.create({
        userId,
        workspaces: toStoredWorkspaces(selection),
        name,
        scopes: scopesFor({ write: write === true }),
        secretHash: await argon2.hash(secret, { type: argon2.argon2id }),
        createdFromIp,
      });

      return {
        token: toMcpTokenSummary(token, accessible),
        secret: `orbm_${token._id.toHexString()}_${secret}`,
        notice: "This token is shown once and cannot be recovered. Paste it into your AI client now.",
      };
    },

    /**
     * Lists the caller's own tokens that read this workspace, revoked ones included. Never anybody
     * else's: the owner of a workspace does not see the tokens its members minted.
     */
    async listTokens({ userId, workspaceId }) {
      await requireCardAccess(userId, workspaceId);
      const [tokens, accessible] = await Promise.all([
        mcpTokenRepository.listCovering(userId, workspaceId),
        workspaceRepository.listAccessible(userId),
      ]);
      return { items: tokens.map((token) => toMcpTokenSummary(token, accessible)) };
    },

    /**
     * Retires one token that reads this workspace — everywhere it reads, not only here. Takes
     * effect on its next request; the row stays.
     */
    async revokeToken({ userId, workspaceId, tokenId }) {
      await requireCardAccess(userId, workspaceId);
      const revoked = await mcpTokenRepository.revoke(userId, workspaceId, tokenId);
      if (!revoked) {
        throw new AppError({ status: 404, code: "MCP_TOKEN_NOT_FOUND", message: "Token was not found." });
      }
      return { token: toMcpTokenSummary(revoked, await workspaceRepository.listAccessible(userId)) };
    },

    /**
     * Resolves a bearer string to the credential it names, or null.
     *
     * Null for every reason — malformed, unknown, revoked, wrong secret, unreadable hash — because
     * the caller turns it into one `401` with no detail. A response that distinguished "no such
     * token" from "wrong secret" would confirm identifiers to whoever asked.
     *
     * The set of workspaces is returned as the row stores it and never trusted on its own: the MCP
     * service intersects it with the workspaces the person can read on every request, so a
     * workspace that changed hands, was deleted or that the person was removed from drops out of
     * their tokens without anybody having to remember to revoke them, and a token left with none
     * answers `401`.
     */
    async authenticate(bearer) {
      const tokenId = mcpTokenIdFrom(bearer);
      if (!tokenId) return null;
      const secret = bearer.slice(`orbm_${tokenId}_`.length);

      const token = await mcpTokenRepository.findUsableById(tokenId);
      if (!token) return null;

      let verified = false;
      try {
        verified = await argon2.verify(token.secretHash, secret);
      } catch {
        // A stored hash this build cannot parse is a failure to authenticate, not a crash that
        // takes the endpoint down with it.
        return null;
      }
      if (!verified) return null;

      return {
        userId: token.userId,
        tokenId: token._id,
        scopes: normaliseScopes(token.scopes),
        kind: "token",
        workspaces: workspacesOf(token),
        // What a write through this token is recorded as having come through: the name its owner
        // gave it, which is what they will recognise in the Library's history.
        client: token.name ?? null,
      };
    },

    /** Records that a credential was used. Failures are swallowed: a stamp is not worth a 500. */
    async touch(tokenId) {
      try {
        await mcpTokenRepository.touch(tokenId);
      } catch {
        // Nothing to do. The request succeeded; only the freshness of "last used" suffers.
      }
    },
  };
}
