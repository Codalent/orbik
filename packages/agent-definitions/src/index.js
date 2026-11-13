import { parseAgentDefinition } from "@orbik/protocol";
import { TOOL_NAMES, allTools, extendTools } from "@orbik/tools";

import { BRAND_CHAT, BRAND_CHAT_READ } from "./brandChat.js";
import { BUSINESS_KNOWLEDGE_BASE } from "./businessKnowledgeBase.js";
import { DESIGN_SYSTEM } from "./designSystem.js";
import { LIBRARY_CHAT } from "./libraryChat.js";
import { LIBRARY_CHAT_READ } from "./libraryChatRead.js";
import { LLMS_TXT } from "./llmsTxt.js";

/**
 * Validates one definition as it is written in this package.
 *
 * Twice: against the protocol's own shape, and against the tools the release actually provides.
 * The second check is what stops a definition shipping that no worker could execute, which would
 * otherwise only surface when a user tried to run it. Either failure throws while the module
 * loads, so the API and the worker both refuse to start on a definition they could not run.
 */
function checked(candidate, toolNames = TOOL_NAMES) {
  const definition = parseAgentDefinition(candidate);
  const missing = definition.tools.filter((tool) => !toolNames.includes(tool));
  if (missing.length) {
    throw new Error(`${definition.slug} needs tools that neither this release nor an extension provides: ${missing.join(", ")}.`);
  }
  return definition;
}

/**
 * Every agent this repository ships, as the API lists it and the worker executes it. A deployment's
 * extensions may add more ({@link extendAgentCatalog}); {@link agentDefinitions} is the whole
 * catalog of a process.
 *
 * The code is the only copy of it: nothing is stored in a
 * database, and there is no step between changing a definition and it being what the next run
 * follows. The API and the worker each read it from their own process, so both have to be
 * running the release a change shipped in. A definition's `version` is a label a run and its
 * model calls record, so a result can be traced to the wording that produced it; raise it when
 * the instructions change in a way worth telling apart afterwards.
 */
export const AGENT_DEFINITIONS = Object.freeze([
  BUSINESS_KNOWLEDGE_BASE,
  LLMS_TXT,
  LIBRARY_CHAT,
  LIBRARY_CHAT_READ,
  BRAND_CHAT,
  BRAND_CHAT_READ,
  DESIGN_SYSTEM,
].map((definition) => checked(definition)));

const BY_SLUG = new Map(AGENT_DEFINITIONS.map((definition) => [definition.slug, definition]));
if (BY_SLUG.size !== AGENT_DEFINITIONS.length) {
  throw new Error("Two agent definitions share a slug.");
}

/** The definitions extensions added, once {@link extendAgentCatalog} has run; core's alone before. */
let catalog = AGENT_DEFINITIONS;

/**
 * Adds what a process's extensions registered — agent definitions (`host.addAgentDefinitions`)
 * and the tools they may be granted (`host.addTools`) — to this process's catalog.
 *
 * The API, the worker and the scheduler call it once, right after `loadExtensions` and before
 * they serve or claim anything, so every place that reads the catalog sees the same agents. Each
 * definition is checked exactly as a core one is, against core's tools and the extensions'; a
 * malformed definition, a slug that is already taken or a tool no one provides throws, and the
 * process refuses to start, as it does when an extension fails to register.
 *
 * @param {{definitions?: object[], tools?: object[]}} added usually the loaded host's
 *   `agentDefinitions` and `tools`
 */
export function extendAgentCatalog({ definitions = [], tools = [] } = {}) {
  if (catalog !== AGENT_DEFINITIONS) throw new Error("The agent catalog is already extended in this process.");
  extendTools(tools);
  const toolNames = Object.keys(allTools());
  const added = definitions.map((candidate) => checked(candidate, toolNames));
  const slugs = new Set(BY_SLUG.keys());
  for (const definition of added) {
    if (slugs.has(definition.slug)) throw new Error(`An extension's agent ${definition.slug} has a slug that is already taken.`);
    slugs.add(definition.slug);
  }
  for (const definition of added) BY_SLUG.set(definition.slug, definition);
  catalog = Object.freeze([...AGENT_DEFINITIONS, ...added]);
}

/**
 * Every agent this process knows: core's ({@link AGENT_DEFINITIONS}) and any its extensions
 * added. What the API lists; read it at call time, not at import, since extensions are added after
 * the modules load.
 */
export function agentDefinitions() {
  return catalog;
}

/**
 * Finds an agent's definition by its slug, core's or an extension's.
 *
 * @param {string} slug the agent, as in `business-knowledge-base`
 * @returns {Readonly<object>|null} the definition, or null when no agent has that slug
 */
export function findAgentDefinition(slug) {
  return BY_SLUG.get(slug) ?? null;
}
