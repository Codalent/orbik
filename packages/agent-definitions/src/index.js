import { parseAgentDefinition } from "@orbik/protocol";
import { TOOL_NAMES } from "@orbik/tools";

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
function checked(candidate) {
  const definition = parseAgentDefinition(candidate);
  const missing = definition.tools.filter((tool) => !TOOL_NAMES.includes(tool));
  if (missing.length) {
    throw new Error(`${definition.slug} needs tools this release does not provide: ${missing.join(", ")}.`);
  }
  return definition;
}

/**
 * Every agent, as the API lists it and the worker executes it.
 *
 * This list is the whole catalog and the code is the only copy of it: nothing is stored in a
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
].map(checked));

const BY_SLUG = new Map(AGENT_DEFINITIONS.map((definition) => [definition.slug, definition]));
if (BY_SLUG.size !== AGENT_DEFINITIONS.length) {
  throw new Error("Two agent definitions share a slug.");
}

/**
 * Finds an agent's definition by its slug.
 *
 * @param {string} slug the agent, as in `business-knowledge-base`
 * @returns {Readonly<object>|null} the definition, or null when no agent has that slug
 */
export function findAgentDefinition(slug) {
  return BY_SLUG.get(slug) ?? null;
}
