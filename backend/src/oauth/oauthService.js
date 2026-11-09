import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { AppError } from "../errors/appError.js";
import { OAuthError } from "./oauthError.js";
import { OAUTH_SCOPES, matchesRedirectUri } from "./oauthClientService.js";
import { toGrantSummary } from "./oauthRepository.js";
import { materialise, requireWriteRole, toStoredWorkspaces, workspacesOf } from "../mcp/credentialWorkspaces.js";
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE, normaliseScopes, scopesFor } from "../mcp/scopes.js";
import { createWorkspaceAccessCheck } from "../services/workspaceAccess.js";

/** Bytes of entropy in a code or token secret. */
const SECRET_BYTES = 32;

/**
 * How long each short-lived thing lives.
 *
 * An authorization request is a browser tab somebody has open, so ten minutes. A code is handed
 * straight to the token endpoint, so one minute — long enough for a slow redirect and short enough
 * that a code in a browser history is already dead. An access token is an hour and a refresh token
 * thirty days, which is what the plan committed to and what Claude's connectors expect.
 */
const REQUEST_TTL_SECONDS = 600;
const CODE_TTL_SECONDS = 60;
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Creates Orbik's OAuth 2.1 authorization server.
 *
 * It exists because the clients this knowledge base was built for — Claude.ai, Claude Desktop,
 * Claude mobile, ChatGPT — will not let a person paste a token. They connect by sending the person
 * to the resource's own sign-in and asking for consent, so Orbik has to be the thing they are sent
 * to. The MCP SDK deliberately implements only the verification half of this; issuing is ours.
 *
 * Three properties are worth stating because everything else follows from them:
 *
 * - **Consent decides the workspaces, and whether the app may write.** A grant is one person, one
 *   client, a set of the workspaces that person can read — all of them, now and later, or the ones
 *   they ticked — and its scopes: reading always, writing to the Library only when they ticked the
 *   box that says so, whatever the client asked for, and only when they are a member or above in
 *   every workspace the set covers. The access token carries nothing else. That is the same
 *   property the pasted tokens have: the set is read from the grant and intersected with what the
 *   person can read on every request, and a client that names a workspace can only pick a member
 *   of it.
 * - **Every client is public.** No client secret is issued or accepted. PKCE S256 is what binds a
 *   code to the client that asked for it, and a secret shipped inside a desktop app is not a secret.
 * - **Nothing is trusted twice.** The authorization request is validated before consent and the
 *   stored copy is what the code is minted from, so a consent screen cannot widen what it was
 *   shown. The code is validated again at the token endpoint against the same stored row.
 *
 * @param {object} options collaborators
 * @param {object} options.oauthRepository persistence
 * @param {object} options.oauthClientService resolves and registers clients
 * @param {object} options.workspaceRepository proves the person can read the workspaces they
 *   approve, with the role they hold in each
 * @param {object} options.config the API configuration
 * @param {(level: string, message: string, context?: object) => void} options.logger
 */
export function createOauthService({
  oauthRepository,
  oauthClientService,
  workspaceRepository,
  config,
  logger,
}) {
  const issuer = config.publicApiUrl;
  const mcpResource = `${issuer}/mcp`;
  const requireWorkspaceAccess = createWorkspaceAccessCheck(workspaceRepository);
  // The Connect your AI card is open to every role, and lists only the signed-in person's own apps.
  const requireCardAccess = (userId, workspaceId) => requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });

  return {
    issuer,
    mcpResource,

    /** The RFC 8414 document a client reads to find out how to talk to this server. */
    metadata() {
      return {
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        revocation_endpoint: `${issuer}/oauth/revoke`,
        scopes_supported: [...OAUTH_SCOPES],
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        // S256 only. The specification's other value, `plain`, protects against nothing.
        code_challenge_methods_supported: ["S256"],
        // Every client here is public, so the token endpoint takes no client authentication.
        token_endpoint_auth_methods_supported: ["none"],
        revocation_endpoint_auth_methods_supported: ["none"],
        // A client may be identified by a document it publishes, which is what both Anthropic and
        // OpenAI now prefer over registering. Advertised so a client knows it need not register.
        client_id_metadata_document_supported: true,
        // RFC 8707: a client may say which resource the token is for, and this server checks it.
        authorization_response_iss_parameter_supported: true,
        service_documentation: `${issuer}/mcp`,
      };
    },

    /**
     * Validates an authorization request and records it for the consent screen.
     *
     * The two refusals here are deliberately different in kind. An unresolvable client or an
     * undeclared `redirect_uri` throws, because the only place to report it is a page — sending a
     * person to a URI the client never declared is how an authorization server becomes an open
     * redirector. Everything else returns a `redirectTo`, because the client declared that URI and
     * RFC 6749 says errors go back to it.
     */
    async beginAuthorization(query) {
      const client = await oauthClientService.resolve(query.client_id);

      const redirectUri = typeof query.redirect_uri === "string" ? query.redirect_uri : "";
      if (!redirectUri || !matchesRedirectUri(client.redirectUris, redirectUri)) {
        throw new OAuthError({
          code: "invalid_redirect_uri",
          message: "redirect_uri must be one this client declared.",
        });
      }

      const state = typeof query.state === "string" ? query.state.slice(0, 2048) : null;
      const fail = (code, message) => ({
        redirectTo: redirectWith(redirectUri, { error: code, error_description: message, state, iss: issuer }),
      });

      if (query.response_type !== "code") {
        return fail("unsupported_response_type", "Only response_type=code is supported.");
      }
      if (query.code_challenge_method !== "S256") {
        return fail("invalid_request", "code_challenge_method must be S256.");
      }
      if (!isCodeChallenge(query.code_challenge)) {
        return fail("invalid_request", "A base64url code_challenge of 43 to 128 characters is required.");
      }

      const scopes = parseScopes(query.scope);
      if (!scopes) {
        return fail("invalid_scope", `Supported scopes are: ${OAUTH_SCOPES.join(" ")}.`);
      }

      // RFC 8707. Checked when present rather than required, because not every client sends it and
      // refusing those would exclude clients the specification still considers conformant.
      if (typeof query.resource === "string" && query.resource && !isThisResource(query.resource, mcpResource)) {
        return fail("invalid_target", "This authorization server issues tokens for its own MCP endpoint only.");
      }

      const request = await oauthRepository.createRequest({
        clientId: client.clientId,
        redirectUri,
        scopes,
        state,
        codeChallenge: query.code_challenge,
        resource: typeof query.resource === "string" ? query.resource.slice(0, 2048) : null,
        expiresAt: new Date(Date.now() + REQUEST_TTL_SECONDS * 1000),
      });

      logger("info", "oauth.authorize_started", { clientId: client.clientId });
      return { requestId: request._id.toHexString() };
    },

    /**
     * Describes a pending request for the consent screen.
     *
     * The client's details come from the stored client rather than from the request, so what a
     * person is shown is what Orbik verified — a name in a query string would be a name the client
     * could have written to say anything.
     *
     * The workspaces are every one the person can read, each with their `role` in it, so the
     * screen can turn the write box off for a choice that includes one where they are read-only.
     * The approval refuses that choice regardless.
     */
    async describeRequest({ userId, requestId }) {
      const request = await oauthRepository.findRequest(requestId);
      if (!request) {
        throw new AppError({
          status: 404,
          code: "OAUTH_REQUEST_NOT_FOUND",
          message: "That authorization request has expired. Start again from your AI client.",
        });
      }
      const client = await oauthRepository.findClient(request.clientId);
      const workspaces = await workspaceRepository.listAccessible(userId);

      return {
        client: {
          id: request.clientId,
          name: client?.clientName ?? "An AI client",
          uri: client?.clientUri ?? null,
          policyUri: client?.policyUri ?? null,
          tosUri: client?.tosUri ?? null,
          // Said plainly, because it is the one thing a person cannot check for themselves: a
          // client that registered itself proved nothing but that it could call an endpoint.
          verified: client?.kind === "cimd",
        },
        scopes: request.scopes,
        // Said on the screen, and decided there: asking does not grant it.
        asksToWrite: request.scopes.includes(MCP_WRITE_SCOPE),
        workspaces: workspaces.map((workspace) => ({
          id: workspace._id.toHexString(),
          name: workspace.name,
          websiteUrl: workspace.websiteUrl ?? null,
          role: workspace.role,
        })),
      };
    },

    /**
     * Records consent and mints the code.
     *
     * Everything the code is bound to comes from the stored request, except the two things the
     * person actually decided: the workspaces — every one they can read, or a selection of them —
     * and whether the app may write to their Libraries. A selection may name only workspaces the
     * person can read — every id in it, not most of them — and "all" needs at least one to exist.
     * Writing needs the member role or above in every workspace the choice covers now ("all" being
     * every one they can read), and is refused `403 ROLE_INSUFFICIENT` otherwise — before the
     * request is consumed, so the person can approve again without the box. The request is
     * consumed atomically, so a consent screen opened in two tabs issues one code rather than two.
     *
     * The scopes granted are the person's answer, not the client's question: reading always, and
     * `orbik:write` only when they ticked the box. A client that asked for `orbik:write` is shown
     * asking and gets it only if the box is ticked; one that asked for nothing gets it the same
     * way. Approving the same app again replaces its scopes with the new answer.
     *
     * @param {object} options
     * @param {{mode: "all"} | {mode: "selected", ids: string[]}} options.workspaces what was approved
     * @param {boolean} [options.write] whether the app may also write to the Library
     */
    async approveRequest({ userId, requestId, workspaces, write = false }) {
      const accessible = await workspaceRepository.listAccessible(userId);
      const readable = new Set(accessible.map((one) => one._id.toHexString()));
      const allowed = workspaces.mode === "all" ? readable.size > 0 : workspaces.ids.every((id) => readable.has(id));
      if (!allowed) {
        throw new AppError({ status: 404, code: "WORKSPACE_NOT_FOUND", message: "Workspace was not found." });
      }
      if (write === true) requireWriteRole(materialise(accessible, toStoredWorkspaces(workspaces)));

      const request = await oauthRepository.consumeRequest(requestId);
      if (!request) {
        throw new AppError({
          status: 404,
          code: "OAUTH_REQUEST_NOT_FOUND",
          message: "That authorization request has expired. Start again from your AI client.",
        });
      }

      const client = await oauthRepository.findClient(request.clientId);
      const scopes = scopesFor({ write: write === true });
      const grant = await oauthRepository.upsertGrant({
        userId,
        clientId: request.clientId,
        clientName: client?.clientName ?? request.clientId,
        workspaces: toStoredWorkspaces(workspaces),
        scopes,
      });

      const secret = randomBytes(SECRET_BYTES).toString("base64url");
      const code = await oauthRepository.createCode({
        codeHash: sha256(secret),
        clientId: request.clientId,
        grantId: grant._id,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        scopes,
        expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000),
      });

      logger("info", "oauth.authorize_approved", {
        clientId: request.clientId,
        write: scopes.includes(MCP_WRITE_SCOPE),
        workspaces: workspaces.mode,
        ...(workspaces.mode === "selected" ? { count: workspaces.ids.length } : {}),
      });

      return {
        redirectTo: redirectWith(request.redirectUri, {
          code: `${code._id.toHexString()}.${secret}`,
          state: request.state,
          // RFC 9207. A client that checks it cannot be tricked into sending a code it got from
          // one authorization server to another one's token endpoint.
          iss: issuer,
        }),
      };
    },

    /** Records a refusal and sends the client the answer the specification defines for one. */
    async denyRequest({ requestId }) {
      const request = await oauthRepository.consumeRequest(requestId);
      if (!request) {
        throw new AppError({
          status: 404,
          code: "OAUTH_REQUEST_NOT_FOUND",
          message: "That authorization request has expired.",
        });
      }
      return {
        redirectTo: redirectWith(request.redirectUri, {
          error: "access_denied",
          error_description: "The person refused the request.",
          state: request.state,
          iss: issuer,
        }),
      };
    },

    /**
     * Exchanges an authorization code for tokens.
     *
     * The PKCE check is the whole security of this step: the code travelled through a browser
     * redirect and anything that saw it could present it, so what proves the presenter is the
     * client that started the flow is the verifier whose hash it committed to beforehand.
     *
     * The code is consumed *before* any of it is checked, so a presentation that fails validation
     * still burns it. That is deliberate and it is the stricter reading: single use has to be
     * guaranteed by the one atomic operation, because validating first and deleting afterwards
     * leaves a window in which two concurrent presentations both pass. A client that sends the
     * wrong verifier is a broken client, and it starts the flow again.
     */
    async exchangeCode({ clientId, code, codeVerifier, redirectUri }) {
      const parsed = splitSecret(code);
      if (!parsed) throw new OAuthError({ code: "invalid_grant", message: "That code is not valid." });

      const stored = await oauthRepository.consumeCode(parsed.id);
      if (!stored || !sameSecret(stored.codeHash, parsed.secret)) {
        throw new OAuthError({ code: "invalid_grant", message: "That code is not valid." });
      }
      if (stored.clientId !== clientId) {
        throw new OAuthError({ code: "invalid_grant", message: "That code was issued to another client." });
      }
      if (stored.redirectUri !== redirectUri) {
        throw new OAuthError({ code: "invalid_grant", message: "redirect_uri must match the one the code was issued for." });
      }
      if (!verifyPkce(codeVerifier, stored.codeChallenge)) {
        throw new OAuthError({ code: "invalid_grant", message: "code_verifier does not match the code_challenge." });
      }

      const grant = await oauthRepository.findUsableGrant(stored.grantId);
      if (!grant) {
        throw new OAuthError({ code: "invalid_grant", message: "That authorization has been revoked." });
      }
      await requireCoveredWorkspace(grant);

      logger("info", "oauth.token_issued", { clientId, grant: "authorization_code" });
      return issueTokens(grant, stored.scopes);
    },

    /**
     * Exchanges a refresh token for a new pair, retiring the old one.
     *
     * Rotation is the point: the new refresh token is returned in the same response that retires
     * the old one, so a stolen refresh token stops working as soon as the real client uses its own.
     * The retirement is a guarded update, so two clients racing produce one success and one
     * `invalid_grant` rather than two live families.
     */
    async refresh({ clientId, refreshToken }) {
      const parsed = splitSecret(refreshToken, "orbr_");
      if (!parsed) throw new OAuthError({ code: "invalid_grant", message: "That refresh token is not valid." });

      const live = await oauthRepository.findLiveToken(parsed.id, "refresh");
      if (!live || !sameSecret(live.tokenHash, parsed.secret)) {
        throw new OAuthError({ code: "invalid_grant", message: "That refresh token is not valid." });
      }

      const grant = await oauthRepository.findUsableGrant(live.grantId);
      if (!grant) {
        throw new OAuthError({ code: "invalid_grant", message: "That authorization has been revoked." });
      }
      if (grant.clientId !== clientId) {
        throw new OAuthError({ code: "invalid_grant", message: "That refresh token was issued to another client." });
      }
      await requireCoveredWorkspace(grant);

      const rotated = await oauthRepository.rotateRefreshToken(parsed.id);
      if (!rotated) {
        throw new OAuthError({ code: "invalid_grant", message: "That refresh token has already been used." });
      }

      logger("info", "oauth.token_issued", { clientId, grant: "refresh_token" });
      return issueTokens(grant, normaliseScopes(grant.scopes));
    },

    /**
     * Honours a client's token revocation (RFC 7009).
     *
     * Always answers success, including for a token that was never valid. The specification
     * requires it, and the reason is sound: an endpoint that distinguished "revoked" from "never
     * existed" would confirm tokens to whoever asked.
     */
    async revokeToken({ token }) {
      // A client may present either kind, and RFC 7009 lets it omit `token_type_hint`, so the
      // prefix is what says which to look for. Revoking either destroys the whole family: a client
      // that is giving up its refresh token is a client that is done.
      for (const [prefix, kind] of [["orba_", "access"], ["orbr_", "refresh"]]) {
        const parsed = splitSecret(token ?? "", prefix);
        if (!parsed) continue;
        const live = await oauthRepository.findLiveToken(parsed.id, kind);
        if (live && sameSecret(live.tokenHash, parsed.secret)) {
          await oauthRepository.deleteTokensForGrant(live.grantId);
          return;
        }
      }
    },

    /**
     * Resolves an access token to the same credential a pasted workspace token resolves to.
     *
     * Null for every failure, so the MCP endpoint answers one `401` whichever kind of credential it
     * was given and nothing downstream can tell the two apart. The set of workspaces is returned as
     * the grant stores it; the MCP service intersects it with what the person can read on every
     * request, so a workspace that changed hands or that they were removed from drops out of their
     * grants without anybody revoking them, and a grant left with none answers `401`.
     */
    async authenticate(bearer) {
      const parsed = splitSecret(bearer ?? "", "orba_");
      if (!parsed) return null;

      const live = await oauthRepository.findLiveToken(parsed.id, "access");
      if (!live || !sameSecret(live.tokenHash, parsed.secret)) return null;

      const grant = await oauthRepository.findUsableGrant(live.grantId);
      if (!grant) return null;

      return {
        userId: grant.userId,
        tokenId: grant._id,
        scopes: normaliseScopes(grant.scopes),
        kind: "oauth",
        workspaces: workspacesOf(grant),
        // What a write through this app is recorded as having come through: the name it was
        // approved under, as the settings page shows it.
        client: grant.clientName ?? grant.clientId ?? null,
      };
    },

    /** Records that a grant was used, for the line beside it on the settings page. */
    async touch(grantId) {
      try {
        await oauthRepository.touchGrant(grantId);
      } catch {
        // The request succeeded; only the freshness of "last used" suffers.
      }
    },

    /**
     * Lists the apps one person has connected that may read one workspace — their own, never the
     * ones another member of it approved.
     */
    async listGrants({ userId, workspaceId }) {
      await requireCardAccess(userId, workspaceId);
      const [grants, accessible] = await Promise.all([
        oauthRepository.listGrantsCovering(userId, workspaceId),
        workspaceRepository.listAccessible(userId),
      ]);
      return { items: grants.map((grant) => toGrantSummary(grant, accessible)) };
    },

    /**
     * Disconnects one app, from every workspace it reads — not only the one whose card was used.
     *
     * The grant is retired and every token under it is destroyed in the same breath, which is what
     * makes this take effect on the connector's next call rather than whenever its access token
     * happened to expire.
     */
    async revokeGrant({ userId, workspaceId, grantId }) {
      await requireCardAccess(userId, workspaceId);
      const revoked = await oauthRepository.revokeGrant(userId, workspaceId, grantId);
      if (!revoked) {
        throw new AppError({ status: 404, code: "OAUTH_GRANT_NOT_FOUND", message: "Connection was not found." });
      }
      await oauthRepository.deleteTokensForGrant(revoked._id);
      logger("info", "oauth.grant_revoked", { clientId: revoked.clientId });
      return { grant: toGrantSummary(revoked, await workspaceRepository.listAccessible(userId)) };
    },
  };

  /**
   * Refuses to issue tokens under a grant that covers no workspace the person can read now — one
   * whose selection named only workspaces they were removed from or that were deleted.
   *
   * Every MCP request already answers `401` for such a grant, so this is not what keeps a
   * workspace safe. It stops the refresh family rotating for a connection that can read nothing,
   * so the app is told, in the one answer RFC 6749 gives for it, to send the person through
   * consent again. The member service also revokes such grants when a person loses a workspace
   * (`credentialRelease.js`); this covers the rows that predate it and a workspace deleted later.
   */
  async function requireCoveredWorkspace(grant) {
    const accessible = await workspaceRepository.listAccessible(grant.userId);
    if (!materialise(accessible, workspacesOf(grant)).length) {
      throw new OAuthError({ code: "invalid_grant", message: "That authorization no longer covers any workspace." });
    }
  }

  /** Mints one access and one refresh token under a grant, and says what the client got. */
  async function issueTokens(grant, scopes) {
    const accessSecret = randomBytes(SECRET_BYTES).toString("base64url");
    const refreshSecret = randomBytes(SECRET_BYTES).toString("base64url");

    const access = await oauthRepository.createToken({
      grantId: grant._id,
      kind: "access",
      tokenHash: sha256(accessSecret),
      expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000),
    });
    const refresh = await oauthRepository.createToken({
      grantId: grant._id,
      kind: "refresh",
      tokenHash: sha256(refreshSecret),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    });

    return {
      access_token: `orba_${access._id.toHexString()}.${accessSecret}`,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: `orbr_${refresh._id.toHexString()}.${refreshSecret}`,
      scope: scopes.join(" "),
    };
  }
}

/**
 * Hashes a code or token secret for storage.
 *
 * SHA-256 rather than argon2id, which is what the pasted workspace tokens use, and the difference
 * is the input. A password-hashing function exists to make guessing a low-entropy human secret
 * slow; these are 256 bits of randomness, which nobody guesses at any speed, so the cost would buy
 * nothing — and it would be paid on every single MCP request an access token authenticates.
 */
function sha256(secret) {
  return createHash("sha256").update(secret).digest("hex");
}

/** Compares a stored digest with a presented secret, without leaking where they diverge. */
function sameSecret(storedHash, secret) {
  const expected = Buffer.from(storedHash, "hex");
  const actual = Buffer.from(sha256(secret), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Splits `<prefix><id>.<secret>` into its parts.
 *
 * A dot rather than the underscore the workspace token uses, because an identifier and a base64url
 * secret can both contain underscores and the split would be ambiguous. The identifier is a lookup
 * key only; the secret beside it is what is actually verified.
 */
function splitSecret(value, prefix = "") {
  const pattern = new RegExp(`^${prefix}([0-9a-f]{24})\\.([A-Za-z0-9_-]{16,128})$`);
  const match = pattern.exec(String(value ?? ""));
  return match ? { id: match[1], secret: match[2] } : null;
}

/** Whether a PKCE verifier hashes to the challenge the code committed to. */
function verifyPkce(verifier, challenge) {
  if (typeof verifier !== "string" || verifier.length < 43 || verifier.length > 128) return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  const expected = Buffer.from(challenge);
  const actual = Buffer.from(computed);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Whether a value is shaped like a base64url S256 challenge. */
function isCodeChallenge(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(value);
}

/**
 * Parses a scope string, refusing anything this server does not issue.
 *
 * Absent means reading, and only reading — not every scope there is. What a client asks for is
 * kept to show on the consent screen; what it gets is decided there (`approveRequest`).
 */
function parseScopes(scope) {
  if (scope === undefined || scope === null || scope === "") return [MCP_READ_SCOPE];
  if (typeof scope !== "string") return null;
  const asked = [...new Set(scope.split(/\s+/).filter(Boolean))];
  if (!asked.length) return [MCP_READ_SCOPE];
  return asked.every((one) => OAUTH_SCOPES.includes(one)) ? asked : null;
}

/**
 * Whether a requested resource names this MCP endpoint.
 *
 * Compared without a trailing slash or fragment, because clients differ on both and neither
 * changes which endpoint is meant.
 */
function isThisResource(requested, mcpResource) {
  try {
    const url = new URL(requested);
    url.hash = "";
    return url.href.replace(/\/$/, "") === mcpResource.replace(/\/$/, "");
  } catch {
    return false;
  }
}

/** Appends an authorization response to a redirect URI, keeping whatever query it already had. */
function redirectWith(redirectUri, params) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, value);
  }
  return url.href;
}
