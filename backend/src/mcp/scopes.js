/**
 * What an MCP credential may do, as the scopes it carries say.
 *
 * Two scopes, and one never implies the other. `orbik:read` is every credential's: the Library,
 * the pages, llms.txt and the design system. `orbik:write` is given only when the person said so —
 * a box ticked when a token is minted, or on the consent screen when an app is approved — and adds
 * the two Library write tools. Reading is not implied by writing either, but nothing issues
 * `orbik:write` without `orbik:read`.
 *
 * Namespaced because they are advertised in this server's OAuth discovery documents, where a bare
 * `read` would be one of a hundred unrelated `read` scopes a client has seen. A pasted token carries
 * the same values as an OAuth grant, so nothing downstream has to know which kind it holds.
 */

/** Read the workspaces a credential covers. Every credential has it. */
export const MCP_READ_SCOPE = "orbik:read";

/** Write files and folders in their Libraries, as the person. Only when the person allowed it. */
export const MCP_WRITE_SCOPE = "orbik:write";

/**
 * The scopes a stored credential carries, in today's names.
 *
 * Pasted tokens minted before the scope was namespaced carry a bare `read`; they are read as
 * `orbik:read` here rather than migrated. A bare `write` was never issued, so nothing maps to
 * `orbik:write`: writing is only ever what somebody explicitly allowed under that name.
 *
 * @param {unknown} scopes the row's `scopes`
 * @returns {string[]}
 */
export function normaliseScopes(scopes) {
  const named = (Array.isArray(scopes) ? scopes : []).map((scope) => (scope === "read" ? MCP_READ_SCOPE : scope));
  return [...new Set(named.filter((scope) => typeof scope === "string"))];
}

/** Whether a credential's scopes let it write to the Library. */
export function mayWrite(scopes) {
  return normaliseScopes(scopes).includes(MCP_WRITE_SCOPE);
}

/** The scopes a credential is issued with: reading always, writing when the person allowed it. */
export function scopesFor({ write }) {
  return write ? [MCP_READ_SCOPE, MCP_WRITE_SCOPE] : [MCP_READ_SCOPE];
}
