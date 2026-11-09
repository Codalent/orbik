/** The one path the MCP endpoint answers on. A `location = /mcp` in nginx matches it exactly. */
export const MCP_PATH = "/mcp";

/**
 * The largest request body `/mcp` reads from a credential that may write.
 *
 * Sized to the largest file the Library accepts with room for the envelope: `library_write` sends a
 * file whole, of up to 60,000 characters (`LIBRARY_LIMITS.markdown`), which a client that escapes
 * every non-ASCII character as `\uXXXX` sends as up to 360,000 bytes, beside up to 200 cited URLs.
 * A read-only credential keeps the API's usual 32 kb. Behind nginx, `location = /mcp` needs a
 * `client_max_body_size` of at least this — `1m` — or the proxy refuses the request first.
 */
export const MCP_WRITE_BODY_LIMIT = "1mb";
