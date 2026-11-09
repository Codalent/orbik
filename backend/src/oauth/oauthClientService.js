import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";

import { classifyAddress } from "@orbik/core";

import { OAuthError } from "./oauthError.js";
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE } from "../mcp/scopes.js";

/** How long a published metadata document is trusted before it is read again. */
const CIMD_CACHE_SECONDS = 24 * 60 * 60;

/** Ceilings on reading somebody else's document: it is a stranger's server at the other end. */
const CIMD_TIMEOUT_MS = 5000;
const CIMD_MAX_BYTES = 64 * 1024;

/**
 * What a client may ask for, and what the discovery documents advertise.
 *
 * Asking is not getting. A request with no `scope` is a request to read, and `orbik:write` is
 * granted only when the person ticks the box on the consent screen — whether or not the client
 * asked for it, because the clients that matter (Claude.ai, ChatGPT) cannot ask on a person's
 * behalf, and a client that can ask has not thereby been allowed.
 */
export const OAUTH_SCOPES = Object.freeze([MCP_READ_SCOPE, MCP_WRITE_SCOPE]);

/** The only grant types this server issues, and the only response type it answers. */
const GRANT_TYPES = Object.freeze(["authorization_code", "refresh_token"]);
const RESPONSE_TYPES = Object.freeze(["code"]);

/**
 * Creates client registration and lookup for Orbik's authorization server.
 *
 * Two ways in, and the order matters. **Client ID Metadata Documents** come first: the client's
 * `client_id` is an HTTPS URL it publishes its own metadata at, Orbik reads it, and there is no
 * registration call and no row to go stale — which is what both Anthropic and OpenAI now prefer and
 * what the 2026-07-28 specification promotes. **Dynamic Client Registration** stays for clients
 * that cannot publish one, which in practice is the older half of the ecosystem.
 *
 * Neither issues a client secret. Every client here is public — a desktop app, a browser extension,
 * somebody's script — and a secret shipped to a public client is a secret that is not one. PKCE is
 * what actually binds an authorization code to the client that asked for it.
 *
 * @param {object} options collaborators
 * @param {object} options.oauthRepository persistence
 * @param {object} options.config the API configuration
 * @param {(level: string, message: string, context?: object) => void} options.logger
 * @param {typeof fetch} [options.fetchImpl] reads client metadata documents; defaults to `fetch`
 */
export function createOauthClientService({ oauthRepository, config, logger, fetchImpl = fetch }) {
  return {
    /**
     * Resolves whatever a client called itself into what this server knows about it.
     *
     * Throws `invalid_client` for anything it cannot resolve, which the authorization endpoint
     * turns into a page rather than a redirect: a `client_id` it cannot place is a `client_id`
     * whose `redirect_uri` it has no reason to trust, and redirecting to an unverified URI is how
     * an open redirector is built.
     */
    async resolve(clientId) {
      if (!clientId || typeof clientId !== "string" || clientId.length > 2048) {
        throw new OAuthError({ code: "invalid_client", message: "A client_id is required." });
      }

      if (isMetadataUrl(clientId)) return resolvePublished(clientId);

      const registered = await oauthRepository.findClient(clientId);
      if (!registered) {
        throw new OAuthError({ code: "invalid_client", message: "That client_id is not registered." });
      }
      return registered;
    },

    /**
     * Registers a client that cannot publish its own metadata (RFC 7591).
     *
     * Open to anyone, which is what the specification intends and what every MCP client expects:
     * the registration confers nothing but a name and a set of redirect URIs, and the credential
     * that matters is the user's consent, which is still asked for. The endpoint is rate-limited
     * so the collection cannot be filled by a loop.
     */
    async register(metadata) {
      const validated = validateMetadata(metadata, { requireClientIdMatch: null });
      const clientId = `orbc_${randomUUID().replaceAll("-", "")}`;
      const client = await oauthRepository.saveClient({ clientId, kind: "dcr", metadata: validated });
      logger("info", "oauth.client_registered", { clientId, clientName: validated.clientName });
      return client;
    },
  };

  /** Reads, validates and caches a client's published metadata document. */
  async function resolvePublished(clientId) {
    const cached = await oauthRepository.findClient(clientId);
    const fresh = cached?.updatedAt && Date.now() - cached.updatedAt.getTime() < CIMD_CACHE_SECONDS * 1000;
    if (cached && fresh) return cached;

    let document;
    try {
      document = await readMetadataDocument(clientId);
    } catch (failure) {
      logger("warn", "oauth.cimd_unreadable", { clientId, message: failure?.message ?? "unknown" });
      // A stale copy beats refusing a client whose own site is having a bad afternoon. Only when
      // there is no copy at all does an unreachable document become the client's problem.
      if (cached) return cached;
      throw new OAuthError({
        code: "invalid_client",
        message: "That client_id's metadata document could not be read.",
      });
    }

    const validated = validateMetadata(document, { requireClientIdMatch: clientId });
    return oauthRepository.saveClient({ clientId, kind: "cimd", metadata: validated });
  }

  /**
   * Fetches one metadata document from a URL somebody else chose.
   *
   * Every ceiling here exists because the URL is the client's, not ours. HTTPS only, so the
   * certificate has to match the host whose document we are about to believe. The address is
   * resolved and refused if it is private, loopback or link-local, because otherwise `client_id`
   * is a hole straight into this machine's network. Redirects are not followed, since a redirect is
   * exactly how that check would be walked around. And the body is read with a ceiling, because a
   * stranger's server that never stops sending is a stranger's server that holds a request open.
   */
  async function readMetadataDocument(url) {
    await assertPublicHost(new URL(url).hostname);

    const response = await fetchImpl(url, {
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`metadata document answered ${response.status}`);

    const text = await readCapped(response, CIMD_MAX_BYTES);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("metadata document is not JSON");
    }
  }

  /** Refuses a hostname that resolves somewhere this server should not be reaching. */
  async function assertPublicHost(hostname) {
    // In development everything is loopback — the frontend, the API, a test client — so the check
    // would refuse the only addresses there are. It is the one place this is relaxed, and it is
    // keyed off the parsed environment rather than off anything in the request.
    if (!config.isProduction) return;

    const addresses = await dns.lookup(hostname, { all: true });
    for (const { address } of addresses) {
      const { isPublic, range } = classifyAddress(address);
      if (!isPublic) {
        throw new Error(`metadata document resolves to ${range ? `a ${range}` : "an unparseable"} address`);
      }
    }
  }
}

/** Whether a `client_id` is a metadata document URL rather than a registered identifier. */
function isMetadataUrl(clientId) {
  if (!/^https:\/\//i.test(clientId)) return false;
  try {
    const url = new URL(clientId);
    return url.protocol === "https:" && !url.hash;
  } catch {
    return false;
  }
}

/**
 * Checks whether a redirect URI is one this client declared.
 *
 * Exact string match, with one exception the specifications require: a loopback redirect
 * (`http://127.0.0.1/…`, `http://localhost/…`, `http://[::1]/…`) matches regardless of port, because
 * a native client binds whatever port is free at the moment it starts the flow and cannot know it
 * in advance. That is RFC 8252 §7.3, and it is how Claude Code's login completes.
 *
 * Everything else must match character for character — no prefix matching, which is the mistake
 * that turns an authorization server into an open redirector.
 */
export function matchesRedirectUri(declared, requested) {
  if (declared.includes(requested)) return true;

  let candidate;
  try {
    candidate = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopback(candidate)) return false;

  return declared.some((uri) => {
    try {
      const allowed = new URL(uri);
      return (
        isLoopback(allowed) &&
        allowed.hostname === candidate.hostname &&
        allowed.pathname === candidate.pathname &&
        allowed.search === candidate.search
      );
    } catch {
      return false;
    }
  });
}

/** Whether a URL is the kind of loopback redirect a native client binds a random port on. */
function isLoopback(url) {
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
}

/**
 * Validates what a client says about itself, in either registration shape.
 *
 * Deliberately narrow. Redirect URIs are the only field with teeth — everything else is a label
 * shown on a consent screen — so they are checked first and the rest is clamped rather than
 * argued with. A document naming a grant type or scope this server does not issue is not an error:
 * the client is told what it got in the response, which is what RFC 7591 asks for.
 */
function validateMetadata(metadata, { requireClientIdMatch }) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new OAuthError({ code: "invalid_client_metadata", message: "Client metadata must be an object." });
  }

  if (requireClientIdMatch && metadata.client_id !== requireClientIdMatch) {
    // The document has to claim the URL it is published at, or anyone who can host JSON could
    // publish a document describing somebody else's client.
    throw new OAuthError({
      code: "invalid_client_metadata",
      message: "The metadata document's client_id must equal the URL it is published at.",
    });
  }

  const redirectUris = Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris : [];
  const valid = redirectUris.filter((uri) => typeof uri === "string" && isAcceptableRedirect(uri));
  if (!valid.length || valid.length !== redirectUris.length) {
    throw new OAuthError({
      code: "invalid_redirect_uri",
      message: "redirect_uris must each be an https URL or a loopback http URL, with no fragment.",
    });
  }

  return {
    clientName: clamp(metadata.client_name) ?? "An AI client",
    clientUri: httpsOrNull(metadata.client_uri),
    logoUri: httpsOrNull(metadata.logo_uri),
    policyUri: httpsOrNull(metadata.policy_uri),
    tosUri: httpsOrNull(metadata.tos_uri),
    softwareId: clamp(metadata.software_id),
    redirectUris: valid.slice(0, 20),
    scopes: OAUTH_SCOPES,
    grantTypes: GRANT_TYPES,
    responseTypes: RESPONSE_TYPES,
    tokenEndpointAuthMethod: "none",
  };
}

/** Whether a redirect URI is one this server will ever send a person to. */
function isAcceptableRedirect(uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  // A fragment is refused because the authorization response is appended to the query, and a URI
  // carrying its own fragment would silently discard it.
  if (url.hash) return false;
  return url.protocol === "https:" || isLoopback(url);
}

/** Keeps a label short enough to render, or drops it. */
function clamp(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\p{Cc}|\p{Cf}/gu, "");
  return trimmed ? trimmed.slice(0, 120) : null;
}

/** Keeps a URL only if it is one a consent screen can safely link to or load. */
function httpsOrNull(value) {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value.slice(0, 2048) : null;
  } catch {
    return null;
  }
}

/** Reads a response body up to a ceiling, refusing one that keeps going. */
async function readCapped(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new Error("metadata document is too large");

  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("metadata document is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
