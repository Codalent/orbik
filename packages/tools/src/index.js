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
