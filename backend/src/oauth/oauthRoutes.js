import express, { Router } from "express";
import { buildOAuthProtectedResourceMetadata } from "@modelcontextprotocol/server";

import { OAuthError, sendOAuthError } from "./oauthError.js";
import { createRateLimit } from "../middleware/rateLimits.js";
import { OAUTH_SCOPES } from "./oauthClientService.js";

/**
 * Builds the public half of Orbik's OAuth surface: discovery, authorization, tokens, registration.
 *
 * Every route here is reached by somebody else's software, not by Orbik's web app, and that shapes
 * three things. Errors answer in OAuth's envelope rather than Orbik's, because a client parses
 * `{error, error_description}` and knows nothing about correlation ids. CORS is open, because a
 * browser-based client discovers this server cross-origin and the documents are public anyway. And
 * none of it accepts a session cookie — the one route that needs a person is the consent screen,
 * which lives in the web app and talks to a separate, session-authenticated API.
 *
 * `/oauth/authorize` is the join between the two. It validates what the client asked for, stores
 * it, and sends the browser to the web app to ask a person about it. Validating first is what lets
 * the consent screen be a plain page: by the time anybody sees it, the `redirect_uri` is one the
 * client declared and the scopes are ones this server issues.
 *
 * @param {object} options collaborators
 * @param {object} options.oauthService the authorization server
 * @param {object} options.oauthClientService client registration
 * @param {object} options.config the API configuration
 * @param {import("mongodb").Collection} options.rateLimitCollection backs the ceilings below
 * @param {(level: string, message: string, context?: object) => void} options.logger
 */
export function createOauthRouter({ oauthService, oauthClientService, config, rateLimitCollection, logger }) {
  const router = Router();
  const consentUrl = `${config.frontendOrigins[0]}/oauth/consent`;

  // Built once at startup so a misconfigured `PUBLIC_API_URL` fails here, loudly, rather than at
  // the moment a client tries to connect and gets a document it refuses.
  const protectedResource = buildOAuthProtectedResourceMetadata({
    oauthMetadata: oauthService.metadata(),
    resourceServerUrl: new URL(oauthService.mcpResource),
    scopesSupported: [...OAUTH_SCOPES],
    resourceName: "Orbik knowledge base",
    // The helper refuses a non-HTTPS issuer other than localhost, which is the right default for
    // an install served over HTTPS. One that is not — development, or a self-hosted install its
    // operator put on a plain-HTTP address — must still start; the clients that insist on HTTPS
    // refuse it themselves. Decided off the parsed environment only (`secureCookies` is true
    // exactly when a production install's address is HTTPS).
    dangerouslyAllowInsecureIssuerUrl: !config.secureCookies,
  });

  // ---------------------------------------------------------------------------------------------
  // Discovery. Public, cacheable, and CORS-open: a client reads these before it has any credential.

  router.get("/.well-known/oauth-protected-resource/mcp", discovery, (_req, res) => {
    res.json(protectedResource);
  });

  // Some clients probe the origin root rather than the resource path. Answering both costs nothing
  // and saves a class of "it did not discover my server" that is invisible from this side.
  router.get("/.well-known/oauth-protected-resource", discovery, (_req, res) => {
    res.json(protectedResource);
  });

  router.get("/.well-known/oauth-authorization-server", discovery, (_req, res) => {
    res.json(oauthService.metadata());
  });

  // ---------------------------------------------------------------------------------------------
  // Authorization

  const authorizeLimit = createRateLimit({
    collection: rateLimitCollection,
    keyPrefix: "oauth-authorize",
    points: 60,
    durationSeconds: 300,
  });

  router.get("/oauth/authorize", authorizeLimit, async (req, res) => {
    try {
      const outcome = await oauthService.beginAuthorization(req.query);
      // Two shapes come back. A `redirectTo` is an error the client declared a URI for, so it goes
      // there. A `requestId` is a request worth asking a person about, so the browser goes to the
      // web app — which is where a person can be signed in, shown the client, and given a choice.
      if (outcome.redirectTo) return res.redirect(302, outcome.redirectTo);
      return res.redirect(302, `${consentUrl}?request=${encodeURIComponent(outcome.requestId)}`);
    } catch (error) {
      // No usable `redirect_uri`, so there is nowhere to send the person but a page. Deliberately
      // plain text: this is read by a developer wiring up a client, and an HTML page from an API
      // that serves nothing else would be a template to maintain for an audience of one.
      if (error instanceof OAuthError) {
        res.status(error.status).type("text/plain").send(
          `${error.code}: ${error.message}\n\n` +
          "This request was not sent back to the client, because the redirect_uri it gave could " +
          "not be verified against the client's own metadata.\n",
        );
        return;
      }
      logger("error", "oauth.authorize_failed", { message: error?.message ?? "unknown" });
      res.status(500).type("text/plain").send("server_error\n");
    }
  });

  // ---------------------------------------------------------------------------------------------
  // Tokens. Form-encoded, as RFC 6749 requires, and never cached.

  const form = express.urlencoded({ extended: false, limit: "16kb" });
  const tokenLimit = createRateLimit({
    collection: rateLimitCollection,
    keyPrefix: "oauth-token",
    points: 120,
    durationSeconds: 60,
  });

  router.post("/oauth/token", noStore, form, tokenLimit, async (req, res) => {
    try {
      const body = req.body ?? {};
      const clientId = String(body.client_id ?? "");
      if (!clientId) {
        throw new OAuthError({ code: "invalid_client", message: "A client_id is required." });
      }

      if (body.grant_type === "authorization_code") {
        return res.json(
          await oauthService.exchangeCode({
            clientId,
            code: String(body.code ?? ""),
            codeVerifier: String(body.code_verifier ?? ""),
            redirectUri: String(body.redirect_uri ?? ""),
          }),
        );
      }
      if (body.grant_type === "refresh_token") {
        return res.json(
          await oauthService.refresh({ clientId, refreshToken: String(body.refresh_token ?? "") }),
        );
      }
      throw new OAuthError({
        code: "unsupported_grant_type",
        message: "Supported grant types are authorization_code and refresh_token.",
      });
    } catch (error) {
      sendOAuthError(res, error, logger);
    }
  });

  router.post("/oauth/revoke", noStore, form, tokenLimit, async (req, res) => {
    try {
      await oauthService.revokeToken({ token: String(req.body?.token ?? "") });
      // RFC 7009: success whatever was presented, including a token that never existed. An endpoint
      // that distinguished them would confirm tokens to whoever asked.
      res.status(200).json({});
    } catch (error) {
      sendOAuthError(res, error, logger);
    }
  });

  // ---------------------------------------------------------------------------------------------
  // Registration, for clients that cannot publish their own metadata document.

  const registerLimit = createRateLimit({
    collection: rateLimitCollection,
    keyPrefix: "oauth-register",
    points: 10,
    durationSeconds: 3600,
  });

  router.post("/oauth/register", noStore, registerLimit, async (req, res) => {
    try {
      const client = await oauthClientService.register(req.body);
      res.status(201).json({
        client_id: client.clientId,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        grant_types: client.grantTypes,
        response_types: client.responseTypes,
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        scope: client.scopes.join(" "),
        // No `client_secret` and no expiry on the identifier: every client here is public, and
        // RFC 7591 says to omit what is not issued rather than send an empty one.
        client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      });
    } catch (error) {
      sendOAuthError(res, error, logger);
    }
  });

  return router;
}

/**
 * Serves a discovery document to anyone, from anywhere.
 *
 * Open CORS is correct here and nowhere else in this API: the documents say only what this server
 * is and where its endpoints are, they are meant to be read before a client holds any credential,
 * and a browser-based client reads them cross-origin. Caching is allowed for the same reason — the
 * answer is the same for everybody.
 */
function discovery(_req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=3600");
  next();
}

/** Keeps a token response out of every cache between here and the client. */
function noStore(_req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  next();
}
