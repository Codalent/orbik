/** The MCP server name the Orbik tools are served under. */
export const ORBIK_MCP_SERVER = "orbik";

/**
 * Converts an Orbik tool name to one MCP accepts.
 *
 * MCP tool names cannot carry a dot, so `crawl.listPages` is declared as `crawl_listPages`.
 *
 * @param {string} name an Orbik tool name such as `crawl.listPages`
 * @returns {string}
 */
export function toolAlias(name) {
  return name.replace(".", "_");
}
