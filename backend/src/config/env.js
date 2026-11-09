import { assertValidEnvironment, parseBoundedInteger, parseMongoUri, parseNodeEnv, parseUrl } from "@orbik/core";
import { parseRetrievalEnvironment } from "@orbik/retrieval";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Parses and validates all API-owned environment inputs before startup.
 * Unknown operating-system variables are ignored because they do not influence the application.
 *
 * Runtime and database inputs are validated by the shared `@orbik/core` primitives so the API
 * and the agent processes cannot disagree about what a valid runtime or database is. The HTTP,
 * CORS, and session inputs below are owned by this process alone.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} source environment values
 * @returns {Readonly<object>} canonical runtime configuration
 */
export function parseEnvironment(source) {
  const errors = [];
  const nodeEnv = parseNodeEnv(source, errors);

  // Loopback, so that the API is reachable only through the proxy in front of it. A container is
  // the exception: its loopback is its own, and the proxy reaches it over the container network,
  // so the compose file listens on every interface of the container and says so explicitly.
  const host = source.HOST ?? "127.0.0.1";
  const anyHost = parseFlag(source.ALLOW_NON_LOOPBACK_HOST, "ALLOW_NON_LOOPBACK_HOST", errors);
  if (!LOOPBACK_HOSTS.has(host) && !anyHost) {
    errors.push("HOST must be a loopback address, unless ALLOW_NON_LOOPBACK_HOST=true (a container behind a proxy).");
  }

  // Which hops in front of the API are trusted to say who the client is (X-Forwarded-For), in
  // Express's own terms: `loopback` for nginx on the same machine, `loopback,uniquelocal` for a
  // proxy on a container network. Rate limits key on the address this produces.
  const trustProxy = (source.TRUST_PROXY ?? "loopback").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!trustProxy.length) errors.push("TRUST_PROXY must name at least one address or range, e.g. loopback.");

  const port = Number(source.PORT ?? 4100);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    errors.push("PORT must be an integer from 1024 through 65535.");
  }

  const { mongodbUri, databaseName } = parseMongoUri(source, errors);

  const frontendOrigins = parseOrigins(source.FRONTEND_ORIGINS, errors);
  // ORBIK_GENERATE_SECRETS=true lets a fresh install start with no secrets in its environment:
  // whichever of SESSION_SECRET and ORBIK_ASSET_URL_SECRET is unset is generated once and kept in
  // the database (`system_state`), so it survives restarts. The compose file sets it, which is
  // what makes `docker compose up` work on a fresh clone. Without it a missing secret is an error.
  const generateSecrets = parseFlag(source.ORBIK_GENERATE_SECRETS, "ORBIK_GENERATE_SECRETS", errors);
  const sessionSecret = source.SESSION_SECRET ?? "";
  if (!(generateSecrets && !sessionSecret) && (sessionSecret.length < 32 || /^replace-/i.test(sessionSecret))) {
    errors.push("SESSION_SECRET must contain at least 32 non-placeholder characters.");
  }

  // Self-service signup: `closed` (the default) adds people only by invite, `open` lets anyone
  // who reaches the sign-in page create an account.
  const signup = (source.ORBIK_SIGNUP ?? "closed").trim().toLowerCase();
  if (!["open", "closed"].includes(signup)) errors.push("ORBIK_SIGNUP must be open or closed.");

  // The install's admins: who sees and answers access requests on the Admin page, and can make a
  // password reset link for someone. A comma-separated list of account addresses; unset, the
  // install's first account (the one setup made) is its admin.
  const adminEmails = [...new Set(String(source.ORBIK_ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().normalize("NFC").toLowerCase())
    .filter(Boolean))];
  for (const address of adminEmails) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address)) errors.push(`ORBIK_ADMIN_EMAILS has an address that is not one: ${address}`);
  }

  // Email, through any SMTP server: smtp://user:pass@host:587 or smtps://user:pass@host:465.
  // Optional. Without it nothing is emailed and nothing needs to be: an invite link is shown to
  // whoever made it, to send as they like. With it, an invite is also emailed to the address.
  const smtpUrl = (source.SMTP_URL ?? "").trim();
  const emailFrom = (source.EMAIL_FROM ?? "").trim();
  if (smtpUrl) {
    try {
      const parsed = new URL(smtpUrl);
      if (!["smtp:", "smtps:"].includes(parsed.protocol)) throw new Error("protocol");
    } catch {
      errors.push("SMTP_URL must be an smtp:// or smtps:// address.");
    }
    if (!emailFrom) errors.push("EMAIL_FROM is required when SMTP_URL is set, e.g. Orbik <orbik@example.com>.");
  }

  const sessionMaxAgeSeconds = Number(source.SESSION_MAX_AGE_SECONDS ?? 86400);
  if (
    !Number.isInteger(sessionMaxAgeSeconds) ||
    sessionMaxAgeSeconds < 300 ||
    sessionMaxAgeSeconds > 2_592_000
  ) {
    errors.push("SESSION_MAX_AGE_SECONDS must be an integer from 300 through 2592000.");
  }

  // ---------------------------------------------------------------------------------------------
  // The retrieval index, read by the MCP server's `content.search` and by nothing else in this
  // process. Parsed by `parseRetrievalEnvironment`, the one parser the agents worker uses too.
  //
  // All optional. An API without an embedding key serves every other MCP tool and reports
  // `INDEX_UNAVAILABLE` with the reason from `content_search`, exactly as the worker indexes
  // nothing and says so — refusing to start over a credential one tool needs would take the whole
  // API down for a feature nobody had switched on.
  //
  // This is the one place the API holds the embedding key, which until now only the worker did.
  // The containment that matters is unchanged: one module, `packages/retrieval/src/embeddings.js`,
  // reaches a non-Claude model, and the key is never written to a run or
  // echoed into an error. The API only ever *searches* the index; filling it stays the worker's.
  const { qdrantUrl, qdrantCollection, qdrantApiKey, openaiApiKey, embeddingModel } = parseRetrievalEnvironment(source, errors);

  // Requests a minute one MCP credential may make. A person's editor asks a handful of questions a
  // minute at most; an agent in a loop can ask hundreds, and the ceiling is what keeps one
  // runaway client from spending an embedding budget or saturating Qdrant for everyone else.
  const mcpRequestsPerMinute = parseBoundedInteger(source.MCP_REQUESTS_PER_MINUTE, 120, 1, 10_000, "MCP_REQUESTS_PER_MINUTE", errors);

  // Library writes a minute one MCP credential that may write can make, counted apart from the
  // requests above and much lower: a person saving what they decided writes a file or two, and a
  // client rewriting the Library in a loop is the failure this ceiling is for. Every file keeps its
  // last twenty versions, so what got through is undone from the Library page.
  const mcpWritesPerMinute = parseBoundedInteger(source.MCP_WRITES_PER_MINUTE, 20, 1, 1_000, "MCP_WRITES_PER_MINUTE", errors);

  // This API's own public origin, which is what it calls itself when it acts as an OAuth
  // authorization server: the `issuer`, every endpoint it advertises, and the `resource` an MCP
  // client compares character for character against the URL it is connecting to. A wrong value here
  // does not degrade — a client that discovers one issuer and is handed another refuses the server
  // outright — so it defaults to the development address and must be set wherever there is a proxy.
  const publicApiUrl = parseUrl(source.PUBLIC_API_URL, `http://${host === "::1" ? "[::1]" : host}:${port}`, "PUBLIC_API_URL", errors);

  // The secret the signed asset links are made with: the links an outside AI fetches a brand's
  // images by, since it has no session and an image model can only be handed a URL.
  //
  // Optional, like the embedding key and for the same reason. An API without it serves the Brand
  // page and every MCP tool as before; what it cannot do is mint a link, and the tools that would
  // carry one say so (`ASSET_LINKS_NOT_CONFIGURED`) and offer the image inline instead. Rotating
  // it ends every outstanding link at once, which is the only way a link is revoked early.
  const assetUrlSecret = (source.ORBIK_ASSET_URL_SECRET ?? "").trim();
  if (assetUrlSecret && (assetUrlSecret.length < 32 || /^replace-/i.test(assetUrlSecret))) {
    errors.push("ORBIK_ASSET_URL_SECRET must contain at least 32 non-placeholder characters when it is set.");
  }

  // devbar (npm `@codalent/devbar`), the toolbar for tasks, bugs and ideas on a development machine: on, the
  // API serves it at /v1/devbar/ and writes its items to the repository's .devbar/. Off by default.
  // Nobody signs in to it; ORBIK_DEVBAR_KEY, a shared secret, is what keeps it to the developers:
  // a request without it is answered as if devbar were off, and the web app shows the toolbar only
  // in a browser that was given the key (`?devbar=<key>` once).
  const devbar = parseFlag(source.ORBIK_DEVBAR, "ORBIK_DEVBAR", errors);
  const devbarKey = (source.ORBIK_DEVBAR_KEY ?? "").trim();
  if (devbar && (devbarKey.length < 24 || !/^[A-Za-z0-9_-]+$/.test(devbarKey))) {
    errors.push("ORBIK_DEVBAR_KEY must be at least 24 letters, digits, '-' or '_' when ORBIK_DEVBAR is on (openssl rand -hex 24).");
  }

  // The session cookie is `Secure` (and named with the `__Host-` prefix, which requires it) when
  // the install is served over HTTPS, as every public deployment is. A production install reached
  // over plain HTTP — Docker on a laptop at http://localhost:8080 — gets an ordinary cookie, because
  // a Secure one is never set on an HTTP request and nobody could stay signed in.
  const secureCookies = nodeEnv === "production"
    && [publicApiUrl, frontendOrigins[0]].some((url) => typeof url === "string" && url.startsWith("https:"));

  assertValidEnvironment(errors);

  return Object.freeze({
    nodeEnv,
    host,
    port,
    mongodbUri,
    databaseName,
    frontendOrigins,
    trustProxy,
    // Null when it is to be generated: `resolveSecrets` fills it in before the app is built.
    sessionSecret: sessionSecret || null,
    generateSecrets,
    signup,
    adminEmails,
    smtpUrl: smtpUrl || null,
    emailFrom: emailFrom || null,
    sessionMaxAgeSeconds,
    sessionMaxAgeMs: sessionMaxAgeSeconds * 1000,
    cookieName: secureCookies ? "__Host-seo_session" : `seo_session_${nodeEnv}`,
    secureCookies,
    isProduction: nodeEnv === "production",
    qdrantUrl,
    qdrantCollection,
    qdrantApiKey,
    openaiApiKey,
    embeddingModel,
    mcpRequestsPerMinute,
    mcpWritesPerMinute,
    publicApiUrl,
    assetUrlSecret,
    devbar,
    devbarKey: devbar ? devbarKey : null,
  });
}

/** Reads an optional true/false switch; anything else is a startup error. */
function parseFlag(value, name, errors) {
  if (value === undefined || value === "") return false;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  errors.push(`${name} must be true or false.`);
  return false;
}

/** Parses comma-separated exact browser origins and appends safe startup errors. */
function parseOrigins(value, errors) {
  const origins = (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (!origins.length || origins.includes("*")) {
    errors.push("FRONTEND_ORIGINS must contain exact HTTP(S) origins and cannot use wildcard.");
    return [];
  }
  const unique = [];
  for (const origin of origins) {
    try {
      const parsed = new URL(origin);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
        throw new Error("not an exact origin");
      }
      if (!unique.includes(origin)) unique.push(origin);
    } catch {
      errors.push(`FRONTEND_ORIGINS contains an invalid exact origin: ${origin}`);
    }
  }
  return unique;
}
