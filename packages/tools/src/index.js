import { BRAND_TOOLS } from "./brand.js";
import { BRAND_EDIT_TOOLS } from "./brandEdit.js";
import { CONTENT_TOOLS } from "./content.js";
import { CRAWL_TOOLS } from "./crawl.js";
import { LIBRARY_TOOLS } from "./library.js";
import { LLMS_TOOLS } from "./llms.js";

/**
 * Every tool an Orbik agent can be granted, keyed by name.
 *
 * The registry is Orbik's, not a provider's. An agent calls `crawl.summarize` whether it is
 * asked by an Orbik agent run or by somebody's own AI over MCP, whichever model Orbik routed the
 * run to. Letting a provider define the core behaviour instead would make the product a
 * different product depending on the model.
 *
 * Adding a tool here makes it *available*; an agent still only gets the ones its definition
 * declares.
 */
export const TOOLS = Object.freeze({
  ...CRAWL_TOOLS,
  ...CONTENT_TOOLS,
  ...LIBRARY_TOOLS,
  ...LLMS_TOOLS,
  ...BRAND_TOOLS,
  ...BRAND_EDIT_TOOLS,
});

/** Every tool name, for validating that a definition asks only for tools that exist. */
export const TOOL_NAMES = Object.freeze(Object.keys(TOOLS));

/** Tools extensions added (docs/architecture/extensions.md § "Agents"), once installed. */
let extensionTools = null;

/**
 * Adds the tools a process's extensions registered (`host.addTools`) to the ones an agent run may
 * be granted. Called once, at startup, by `extendAgentCatalog` in `@orbik/agent-definitions`.
 *
 * Checked here so a malformed tool stops the process rather than failing the first run that is
 * granted it. A name that is already a core tool, or repeated, is refused: an extension cannot
 * replace what a core agent calls. They are not added to {@link TOOLS}, which is also what MCP
 * serves, so an extension's tools are never on the MCP surface.
 *
 * @param {object[]} tools
 */
export function extendTools(tools = []) {
  if (extensionTools) throw new Error("Extension tools are already installed in this process.");
  const added = {};
  for (const tool of tools) {
    const name = tool?.name;
    const problems = [];
    if (typeof name !== "string" || !/^[a-z][a-z0-9]*\.[a-z][A-Za-z0-9]*$/.test(name)) problems.push("a name such as acme.listIssues");
    if (typeof tool?.description !== "string" || !tool.description.trim()) problems.push("a description");
    if (!tool?.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) problems.push("an inputSchema object");
    if (typeof tool?.parseInput !== "function") problems.push("parseInput(input, errors)");
    if (typeof tool?.handler !== "function") problems.push("handler(input, context)");
    if (problems.length) throw new TypeError(`Extension tool ${typeof name === "string" ? name : "(unnamed)"} needs ${problems.join(", ")}.`);
    if (Object.hasOwn(TOOLS, name)) throw new Error(`Extension tool ${name} has the name of a core tool.`);
    if (Object.hasOwn(added, name)) throw new Error(`Extension tool ${name} is added twice.`);
    added[name] = Object.freeze({ ...tool });
  }
  extensionTools = Object.freeze(added);
}

/**
 * Every tool an agent run may be granted in this process: core's and the extensions'. What the
 * worker builds a run's tool registry from.
 */
export function allTools() {
  return extensionTools ? Object.freeze({ ...TOOLS, ...extensionTools }) : TOOLS;
}

export { ToolError, createToolRegistry } from "./registry.js";
export { ORBIK_MCP_SERVER, toolAlias } from "./mcp.js";
/**
 * The ledger writers, exported for the two callers that advance it without being a tool.
 *
 * The source layer's mirror records, for every page, whether the knowledge base is written from it
 * (`recordSelection`) or that it is not stored at all (`reviewSources`), and the API records a
 * person's verdict when somebody pulls a page back in, through `recordPersonVerdict` beside them.
 * Neither writes `knowledge_sources` itself — three writers with three ideas of what a verdict
 * row looks like is how a ledger stops being answerable.
 */
export { recordPersonVerdict, recordSelection, reviewSources } from "./sources.js";
