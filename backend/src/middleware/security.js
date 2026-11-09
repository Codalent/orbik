import { SIGNED_ASSET_PATH } from "@orbik/assets";
import cors from "cors";
import express from "express";
import helmet from "helmet";

import { AppError } from "../errors/appError.js";
import { MCP_PATH } from "../mcp/constants.js";

/**
 * The routes that answer somebody else's software rather than Orbik's own web app.
 *
 * They are exempt from the two policies below, and it is worth being precise about why rather than
 * treating it as a list of awkward cases. Both policies exist to protect a *cookie-authenticated*
 * API from other people's web pages: one refuses any origin but the app's, the other refuses any
 * request body a form could have submitted. Nothing on this list is cookie-authenticated — the MCP
 * endpoint and the token endpoint carry bearer credentials, and the discovery documents carry none
 * at all — so neither policy protects anything here, while both would break clients that are
 * behaving exactly as their specifications require.
 *
 * Each route sets what it actually needs instead: `/mcp` its own CORS headers, the discovery routes
 * open CORS, and the token endpoint a form parser scoped to itself.
 *
 * The signed asset links are on the list for the same reason: a link carries its own permission in
 * a signature and never a cookie, and what fetches it is an AI client's server or an image model,
 * from an origin nobody can list in advance.
 */
const PUBLIC_PROTOCOL_PREFIXES = Object.freeze(["/.well-known/", "/oauth/", `${SIGNED_ASSET_PATH}/`, "/v1/hooks/"]);

/**
 * Where an extension's server-to-server endpoints live — a payment provider's webhook, say. Like
 * the routes above they carry no cookie, and they also get no body parsing: a webhook is checked
 * against a signature over its raw bytes, so the route reads the body itself.
 */
export const EXTENSION_HOOK_PREFIX = "/v1/hooks/";

/** Where devbar is mounted when ORBIK_DEVBAR is on (server.js); it reads its own bodies. */
export const DEVBAR_PATH = "/v1/devbar";

/**
 * The one session route whose body is a file rather than JSON: a person's upload to a brand. It
 * reads its own body, raw, under the upload limit, and keeps every other check: the session, the
 * CSRF header and the browser policy.
 */
export const BRAND_UPLOAD_PATH = /^\/v1\/workspaces\/[0-9a-f]{24}\/brand\/uploads$/;

/** The largest JSON body the API reads, everywhere but where a route says otherwise. */
export const JSON_BODY_LIMIT = "32kb";

/** Whether a path is served to outside software under its own rules. */
function isPublicProtocol(path) {
  return path === MCP_PATH || PUBLIC_PROTOCOL_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Installs shared HTTP parsing and browser security boundaries. */
export function applySecurityMiddleware(app, config) {
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy ?? "loopback");
  app.use(helmet());
  const browserCors = cors({
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-CSRF-Token", "Idempotency-Key", "X-Correlation-ID", "X-Devbar-Key"],
    origin(origin, callback) {
      if (!origin || config.frontendOrigins.includes(origin)) return callback(null, true);
      return callback(
        new AppError({ status: 403, code: "ORIGIN_NOT_ALLOWED", message: "Origin is not allowed." }),
      );
    },
  });
  app.use((req, res, next) => (isPublicProtocol(req.path) ? next() : browserCors(req, res, next)));
  // devbar checks its own content types: a screen recording is sent raw, as video/webm or video/mp4.
  const ownsContentType = (path) => isPublicProtocol(path) || BRAND_UPLOAD_PATH.test(path) || path.startsWith(`${DEVBAR_PATH}/`);
  app.use((req, res, next) => (ownsContentType(req.path) ? next() : requireJsonForMutation(req, res, next)));
  // `/mcp` reads its own body, after the credential is known: a credential that may write sends
  // whole Library files and is given room for one, and a read-only one keeps this limit. Parsing
  // there also means nobody without a credential can make the API read a large body.
  // devbar reads its own body, with its own limit: an item with a screenshot is a few megabytes.
  const json = express.json({ limit: JSON_BODY_LIMIT, strict: true });
  const unparsed = (path) => path === MCP_PATH || path.startsWith(EXTENSION_HOOK_PREFIX) || path.startsWith(`${DEVBAR_PATH}/`) || BRAND_UPLOAD_PATH.test(path);
  app.use((req, res, next) => (unparsed(req.path) ? next() : json(req, res, next)));
}

/** Rejects mutation bodies before a parser or route can interpret ambiguous content. */
function requireJsonForMutation(req, _res, next) {
  if (["POST", "PUT", "PATCH"].includes(req.method) && !req.is("application/json")) {
    return next(
      new AppError({
        status: 415,
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "Content-Type must be application/json.",
      }),
    );
  }
  next();
}
