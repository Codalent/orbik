"use client";

import { normalizeApiError } from "./errors";

let cachedBaseUrl;
let csrfToken = null;
let sessionRequest = null;
let sessionRevision = 0;
const sessionListeners = new Set();
const accessListeners = new Set();

/**
 * Subscribes to refusals that say the person's access to a workspace changed under them: a 404
 * `WORKSPACE_NOT_FOUND` (removed, or the workspace is gone) or a 403 `ROLE_INSUFFICIENT` (their role
 * was lowered). The workspace list is what every page takes the role from, so the cache re-reads it
 * on either, and the pages follow.
 */
export function subscribeAccessChange(listener) {
  accessListeners.add(listener);
  return () => accessListeners.delete(listener);
}

/** Subscribes the auth provider to session changes without coupling API callers to React. */
export function subscribeSession(listener) {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

/** Clears browser-only credentials and private UI state. */
export function clearSession() {
  publishSession(null);
}

function publishSession(session) {
  csrfToken = session?.csrfToken ?? null;
  sessionRevision += 1;
  for (const listener of sessionListeners) listener(session);
}

/** Coalesces bootstrap requests, including writes made before the provider finishes loading. */
export function fetchSession() {
  if (!sessionRequest) {
    sessionRequest = apiFetch("/v1/auth/session").finally(() => { sessionRequest = null; });
  }
  return sessionRequest;
}

/**
 * Returns the validated, origin-only API base URL embedded at build time.
 *
 * Unset, the API is this page's own origin: the web app and the API are served at one address with
 * a proxy sending API paths to the API, as the Docker install does. That is what lets one image of
 * the web app serve any hostname — the value is fixed when the app is built, and a self-hoster's
 * hostname is not known then. The development setup, and a deployment that serves the API at an
 * address of its own, name a separate origin.
 */
export function getApiBaseUrl() {
  if (cachedBaseUrl) return cachedBaseUrl;
  const raw = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!raw) {
    if (typeof window === "undefined") return "";
    cachedBaseUrl = window.location.origin;
    return cachedBaseUrl;
  }
  const parsed = new URL(raw);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== raw) {
    throw new Error("NEXT_PUBLIC_API_BASE_URL must be an exact HTTP(S) origin.");
  }
  cachedBaseUrl = parsed.origin;
  return cachedBaseUrl;
}

/**
 * Performs a credentialed JSON request and rejects every undocumented response shape safely.
 *
 * @param {string} path absolute API path beginning with `/`
 * @param {RequestInit & {idempotencyKey?: string}} options request options
 */
export async function apiFetch(path, options = {}) {
  if (!/^\/[A-Za-z0-9/_{}.-]*(?:\?[A-Za-z0-9%&=_.-]+)?$/.test(path)) {
    throw new Error("API path is invalid.");
  }
  const { idempotencyKey, headers: suppliedHeaders, ...requestOptions } = options;
  const headers = new Headers(suppliedHeaders);
  headers.set("Accept", "application/json");
  if (requestOptions.body !== undefined) headers.set("Content-Type", "application/json");
  const method = (requestOptions.method ?? "GET").toUpperCase();
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (mutation && !csrfToken) await fetchSession();
  if (mutation) {
    if (!csrfToken) throw new Error("Your session could not be verified. Refresh and try again.");
    headers.set("X-CSRF-Token", csrfToken);
  }
  const revision = sessionRevision;
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);

  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...requestOptions,
    credentials: "include",
    headers,
  });
  if (response.status === 204) {
    if (path === "/v1/auth/logout" && revision === sessionRevision) clearSession();
    return null;
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = normalizeApiError(response.status, payload, response.headers.get("Retry-After"));
    if (revision === sessionRevision) {
      if (response.status === 401 && path !== "/v1/auth/login") clearSession();
      if (path.startsWith("/v1/workspaces/") && (error.code === "WORKSPACE_NOT_FOUND" || error.code === "ROLE_INSUFFICIENT")) {
        for (const listener of accessListeners) listener(error);
      }
      if (error.code === "CSRF_INVALID") {
        // Revalidate a token rotated in another tab. Never replay a user's mutation automatically.
        csrfToken = null;
        try { await fetchSession(); } catch { clearSession(); }
        error.message = "Your session changed. Please try again.";
      }
    }
    throw error;
  }
  if (!payload || typeof payload !== "object") {
    throw normalizeApiError(502, null);
  }
  // Accepting an invite can create an account and sign it in, which regenerates the session and
  // its CSRF token. The answer carries the new token; it is kept at once so that the next write
  // does not depend on the session being read again first. Only the token: the answer says
  // nothing about the user, so the auth state still comes from the session read that follows.
  if (revision === sessionRevision && /^\/v1\/invites\/[^/]+\/accept$/.test(path) && typeof payload.csrfToken === "string") {
    csrfToken = payload.csrfToken;
  }
  // An approved access link and a password reset both sign the browser in and answer with the
  // whole session, as login does.
  const signsIn = /^\/v1\/(access-links\/[^/]+\/accept|auth\/password-resets\/[^/]+\/complete)$/.test(path);
  if (revision === sessionRevision && (signsIn || ["/v1/auth/session", "/v1/auth/login", "/v1/auth/signup", "/v1/setup"].includes(path))) {
    publishSession(payload);
  }
  return payload;
}

/**
 * Sends a file as the body of a credentialed POST and reads the JSON answer.
 *
 * The one request the web app makes whose body is not JSON: an upload to a brand. The file goes as
 * it is, under its own type, with the session's CSRF header like every other write; the API reads
 * what it is from the bytes. The query is built here from plain values so a file's name cannot
 * break out of it.
 *
 * @param {string} path absolute API path beginning with `/`, without a query
 * @param {Blob} file the file
 * @param {Record<string, string|null|undefined>} [query] values for the query string
 */
export async function apiUpload(path, file, query = {}) {
  if (!/^\/[A-Za-z0-9/_.-]*$/.test(path)) throw new Error("API path is invalid.");
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined && value !== "") params.set(key, String(value));
  }
  if (!csrfToken) await fetchSession();
  if (!csrfToken) throw new Error("Your session could not be verified. Refresh and try again.");
  const headers = new Headers({ Accept: "application/json", "X-CSRF-Token": csrfToken, "Content-Type": file.type || "application/octet-stream" });
  const revision = sessionRevision;
  const response = await fetch(`${getApiBaseUrl()}${path}${params.size ? `?${params}` : ""}`, {
    method: "POST",
    body: file,
    credentials: "include",
    headers,
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = normalizeApiError(response.status, payload, response.headers.get("Retry-After"));
    if (revision === sessionRevision && response.status === 401) clearSession();
    if (response.status === 413 && !payload) error.message = "That file is too large to upload.";
    throw error;
  }
  if (!payload || typeof payload !== "object") throw normalizeApiError(502, null);
  return payload;
}

/**
 * Performs a credentialed GET for a text response, such as a page's Markdown or a CSV export.
 *
 * Kept apart from `apiFetch` rather than folded in behind an option: that function's contract is
 * "a JSON object or a normalized error", and every caller relies on it. A text route has its own
 * small contract — the body as a string — and gets its own small function.
 *
 * The path may carry a query string, in the same grammar `apiFetch` accepts, because a route that
 * answers in several formats names the one it is asked for there: `…/brand/render?format=css`.
 *
 * @param {string} path absolute API path beginning with `/`
 * @returns {Promise<string>}
 */
export async function apiFetchText(path) {
  if (!/^\/[A-Za-z0-9/_{}.-]*(?:\?[A-Za-z0-9%&=_.-]+)?$/.test(path)) throw new Error("API path is invalid.");
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    credentials: "include",
    headers: { Accept: "text/markdown, text/csv, text/plain" },
  });
  if (!response.ok) {
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (response.status === 401) clearSession();
    throw normalizeApiError(response.status, payload, response.headers.get("Retry-After"));
  }
  return response.text();
}
