import { apiFetch } from "./client";
import { requireId } from "./ids";

/**
 * Where a workspace's MCP tokens — the AI clients connected to it, revoked ones included — are
 * read from; also their cache key.
 */
export function mcpTokensPath(workspaceId) {
  return `/v1/workspaces/${requireId(workspaceId, "Workspace")}/mcp-tokens`;
}

/**
 * Creates a token and returns it, once.
 *
 * `workspaces` says what it reads: `{mode: "all"}` for every workspace the person owns, now and
 * later; omitted, it reads this workspace alone. `write: true` lets it also write to the Library, as
 * the person; omitted, it only reads.
 *
 * The secret is in the response and nowhere else — the server keeps only an argon2id hash of it and
 * genuinely cannot show it again — so a caller must put it in front of the person immediately rather
 * than assuming it can be read back.
 */
export function createMcpToken(workspaceId, { name, workspaces, write = false }) {
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/mcp-tokens`, {
    method: "POST",
    body: JSON.stringify({ name, ...(workspaces ? { workspaces } : {}), ...(write ? { write: true } : {}) }),
  });
}

/**
 * Where "What your AI asked" is read from — what the AIs connected to a workspace did over the
 * last `days` days (7, 30 or 90) — and its cache key. Admins and the owner only.
 */
export function mcpUsagePath(workspaceId, days = 30) {
  return `/v1/workspaces/${requireId(workspaceId, "Workspace")}/mcp-usage?days=${days}`;
}

/** Whether a token or an approved app may write to the Library, from the scopes it reports. */
export function mayWrite(credential) {
  return (credential?.scopes ?? []).includes("orbik:write");
}

/**
 * Retires one token — everywhere it reads, not only in this workspace. It stops working on its next
 * request; the row stays so "last used" survives.
 *
 * The body is an empty object rather than absent: the API requires JSON on every state-changing
 * request, so a bodyless POST is refused before it reaches the route.
 */
export function revokeMcpToken(workspaceId, tokenId) {
  return apiFetch(
    `/v1/workspaces/${requireId(workspaceId, "Workspace")}/mcp-tokens/${requireId(tokenId, "Token")}/revoke`,
    { method: "POST", body: "{}" },
  );
}
