import { apiFetch } from "./client";
import { requireId } from "./ids";

/**
 * Describes one pending authorization request: who is asking, for what, and which workspaces exist.
 *
 * The client's name and links come from the server rather than from the URL the person arrived on,
 * because a name in a query string is a name the client could have written to say anything.
 */
export function readAuthorizationRequest(requestId) {
  return apiFetch(`/v1/oauth/requests/${requireId(requestId, "Request")}`);
}

/**
 * Approves one request for a set of workspaces and returns where to send the browser next.
 *
 * `workspaces` is `{mode: "all"}` — every workspace the person owns, including ones they create
 * later — or `{mode: "selected", ids: [...]}`. `write` is whether the app may also write to their
 * Libraries: only ever what the person ticked, whatever the app asked for.
 *
 * A URL rather than a redirect, because by this point the browser is on Orbik's own origin and the
 * redirect back to the AI client belongs to this page.
 */
export function approveAuthorizationRequest(requestId, { workspaces, write = false }) {
  const body = {
    workspaces:
      workspaces.mode === "all"
        ? { mode: "all" }
        : { mode: "selected", ids: workspaces.ids.map((id) => requireId(id, "Workspace")) },
    write: write === true,
  };
  return apiFetch(`/v1/oauth/requests/${requireId(requestId, "Request")}/approve`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Refuses one request, and returns where to send the browser to tell the client so. */
export function denyAuthorizationRequest(requestId) {
  return apiFetch(`/v1/oauth/requests/${requireId(requestId, "Request")}/deny`, {
    method: "POST",
    body: "{}",
  });
}

/**
 * Where a workspace's approved apps — those connected through OAuth, revoked ones included — are
 * read from; also their cache key.
 */
export function mcpGrantsPath(workspaceId) {
  return `/v1/workspaces/${requireId(workspaceId, "Workspace")}/mcp-grants`;
}

/** Disconnects one app, from every workspace it reads. It stops working on its next request; the row stays. */
export function revokeMcpGrant(workspaceId, grantId) {
  return apiFetch(
    `/v1/workspaces/${requireId(workspaceId, "Workspace")}/mcp-grants/${requireId(grantId, "Connection")}/revoke`,
    { method: "POST", body: "{}" },
  );
}
