import express, { Router } from "express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/server";
import { ORBIK_MCP_SERVER } from "@orbik/tools";

import { MCP_PATH, MCP_WRITE_BODY_LIMIT } from "./constants.js";
import { buildMcpHandler } from "./server.js";
import { createRateCounter, createRateLimit } from "../middleware/rateLimits.js";
import { JSON_BODY_LIMIT } from "../middleware/security.js";
import { mcpTokenIdFrom } from "./mcpTokenService.js";

/**
 * Builds the MCP endpoint: one route, on the API's own listener.
 *
 * It sits here rather than in a fourth process because everything it needs is already here — the
 * ownership check, argon2 token hashing, the Library store, the error envelope — and a separate
 * process would be a port, a PM2 pair, an nginx site and a second copy of the authentication
 * plumbing bought for an endpoint that mostly reads — and writes, when it does, through the same
 * Library store the API's own routes write through. What it costs is that the API now holds the
 * embedding key; that trade is argued where the key is parsed, in `config/env.js`.
 *
 * Order matters and is the reverse of how it reads. The rate limit runs *before* authentication and
 * keys on the unverified token identifier, because argon2id is deliberately expensive: a caller who
 * could make the API hash unlimited wrong secrets would have a cheap way to spend its CPU. The body
 * is read *after* it, with a limit the credential decides: a credential that may write sends whole
 * Library files, so it gets room for one; a read-only one keeps the API's usual 32 kb; and nobody
 * without a credential gets the API to read a body at all.
 *
 * Library writes have a ceiling of their own, lower than the requests', counted inside the tool
 * call (`server.js`) because a write is only told apart from a read once the request is read.
 *
 * @param {object} options collaborators
 * @param {object} options.mcpService opens sessions and builds registries
 * @param {object} options.config the API configuration
 * @param {import("mongodb").Collection} options.rateLimitCollection backs the per-credential ceiling
 * @param {(level: string, message: string, context?: object) => void} options.logger
 * @param {object | null} [options.callLog] records each tool call (`mcpCallLog.js`)
 */
export function createMcpRouter({ mcpService, config, rateLimitCollection, logger, callLog = null }) {
  const router = Router();
  const handler = buildMcpHandler({
    mcpService,
    callLog,
    // Per credential, like the request ceiling, and in the same counters.
    writeLimit: createRateCounter({
      collection: rateLimitCollection,
      keyPrefix: "mcp-write",
      points: config.mcpWritesPerMinute,
      durationSeconds: 60,
    }),
    // The app's own Library view already opens a file from `?path=`, which is how a citation on the
    // ask page reaches the file it names, so a Library citation reuses it rather than inventing a
    // second addressing scheme. It matters because a Library path is not a URL, and the
    // ChatGPT-shaped tools drop a result whose `url` is empty — which would silently hide half of
    // this knowledge base from the client that needs those tools most.
    appOrigin: config.frontendOrigins[0],
    logger,
  });
  const serve = toNodeHandler(handler, {
    onerror: (error) => logger("error", "mcp.transport_failed", { message: error?.message ?? "unknown" }),
  });

  const limit = createRateLimit({
    collection: rateLimitCollection,
    keyPrefix: "mcp",
    points: config.mcpRequestsPerMinute,
    durationSeconds: 60,
    // Per credential, falling back to the address for a request that named no token at all — so a
    // caller cannot dodge the ceiling by sending nothing, and two people's clients never share one.
    keyFromRequest: (req) => mcpTokenIdFrom(bearerFrom(req)) ?? `ip:${req.ip}`,
  });

  // Where a client that has no credential goes to find out how to get one. Advertised only on a
  // `401`, which is the one place clients look for it.
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(`${config.publicApiUrl}${MCP_PATH}`));

  const readBody = express.json({ limit: JSON_BODY_LIMIT, strict: true });
  const writeBody = express.json({ limit: MCP_WRITE_BODY_LIMIT, strict: true });
  const parseBody = (req, res, next) => (req.auth.extra.session.mayWrite ? writeBody : readBody)(req, res, next);

  router.post(
    MCP_PATH,
    allowMcpClients,
    limit,
    authenticate(mcpService, logger, resourceMetadataUrl),
    parseBody,
    (req, res) => {
      // Which tools this request calls, so a read-only credential's server can answer a call to a
      // write tool with a refusal the model reads, rather than "no such tool" (`server.js`).
      req.auth.extra.calledTools = calledTools(req.body);
      serve(req, res, req.body);
    },
  );

  // The 2025-era session operations, GET and DELETE. Answered here rather than left to fall through
  // to the API's 404 handler, because a client that gets an HTML-shaped 404 from a GET reports the
  // server as unreachable, while a `405` is the documented answer for a stateless endpoint.
  router.all(MCP_PATH, allowMcpClients, (_req, res) => {
    res.setHeader("Allow", "POST, OPTIONS");
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "This endpoint is stateless: every request is a POST." },
      id: null,
    });
  });

  return router;
}

/**
 * Allows the headers an MCP client sends, for this route only.
 *
 * None of the clients this endpoint was built for is a browser origin — Claude Code, Cursor, the
 * Messages API and the Responses API all call it server to server, and a request with no `Origin`
 * needs no CORS at all. The allowance exists for the MCP Inspector and the other browser-based
 * debugging tools, which is why it is scoped to `/mcp` and why it does not set
 * `Access-Control-Allow-Credentials`: this endpoint authenticates with a bearer token and never a
 * cookie, so a page that can reach it still has to already hold the token.
 */
function allowMcpClients(req, res, next) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Accept, Mcp-Method, Mcp-Name, Mcp-Protocol-Version, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  );
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
  res.setHeader("Access-Control-Max-Age", "600");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
}

/**
 * Resolves the bearer credential, or refuses with a `401` challenge.
 *
 * One answer for every failure, and a body that says nothing more than the status: a response that
 * distinguished "no such token" from "you can no longer read that workspace" would be an oracle for
 * token and workspace identifiers. The `WWW-Authenticate` header is what makes a client re-prompt
 * rather than report the server as broken — and, once phase two exists, what carries the
 * `resource_metadata` pointer clients honour only on a 401.
 *
 * A token in the query string is refused by never being looked for: URLs land in access logs.
 */
function authenticate(mcpService, logger, resourceMetadataUrl) {
  return async (req, res, next) => {
    let session;
    try {
      session = await mcpService.openSession(bearerFrom(req));
    } catch (error) {
      return next(error);
    }

    if (!session) {
      logger("warn", "mcp.rejected", { reason: "AUTHENTICATION_FAILED" });
      // `resource_metadata` is what turns a refusal into a sign-in. A client that has never seen
      // this server reads the document it points at, finds the authorization server, and starts the
      // OAuth flow — which is the whole reason Claude.ai and ChatGPT can connect at all. Clients
      // honour it on a `401` and nowhere else, so it is set here rather than on every response.
      res.setHeader(
        "WWW-Authenticate",
        `Bearer realm="${ORBIK_MCP_SERVER}", resource_metadata="${resourceMetadataUrl}"`,
      );
      return res.status(401).json({
        error: { code: "AUTHENTICATION_REQUIRED", message: "A valid Orbik credential is required." },
      });
    }

    // Not awaited: "last used" is worth a write per request but not a millisecond of one, and a
    // failed stamp must not fail a read. Its own service swallows the failure.
    void mcpService.touch(session);

    // `req.auth` is what `toNodeHandler` forwards as the handler's `authInfo`, which the factory
    // reads to build this request's registry. The token itself is not put back on it: nothing
    // downstream needs the secret, and a credential in an object that gets logged is a credential
    // in a log.
    req.auth = {
      token: "",
      clientId: ORBIK_MCP_SERVER,
      scopes: session.scopes,
      extra: { session },
    };
    next();
  };
}

/**
 * The names of the tools a JSON-RPC body calls: none, or one per `tools/call` in it.
 *
 * Read from the parsed body for one purpose only — to know whether to register the refusals a
 * read-only credential is answered with — and never trusted for anything else: the SDK parses and
 * validates the same body afterwards, and decides what is actually called.
 */
function calledTools(body) {
  return [].concat(body ?? [])
    .filter((message) => message?.method === "tools/call" && typeof message.params?.name === "string")
    .map((message) => message.params.name);
}

/** Reads the bearer token from the Authorization header, and from nowhere else. */
function bearerFrom(req) {
  const header = req.headers?.authorization ?? "";
  return /^Bearer (.+)$/i.exec(header)?.[1]?.trim() ?? null;
}
