import { AGENT_DEFINITIONS, findAgentDefinition } from "@orbik/agent-definitions";

/**
 * Converts an agent definition to the summary the catalog exposes.
 *
 * Instructions are deliberately absent. They are the product's actual intellectual property, they
 * are long enough to make a catalog response unreadable, and a browser has no use for them: the
 * only thing that needs an agent's instructions is the worker about to execute it.
 */
export function toAgentSummary(definition) {
  return {
    slug: definition.slug,
    version: definition.version,
    name: definition.name,
    summary: definition.summary,
    capability: definition.capability,
    tools: definition.tools ?? [],
    inputSchema: definition.inputSchema ?? { type: "object" },
    runtimeRequirements: definition.runtimeRequirements ?? [],
  };
}

/**
 * Definitions that are a variant of another agent rather than an agent of their own, and so are
 * not listed. `library-chat-read` is Ask for a read-only person — chosen by the API from the
 * asker's role, never by anyone picking it — so the catalog keeps showing Ask once.
 */
const UNLISTED = new Set(["library-chat-read", "brand-chat", "brand-chat-read"]);

/** Every listed agent in name order, which is the order the catalog is shown in. */
const BY_NAME = Object.freeze(
  AGENT_DEFINITIONS.filter((definition) => !UNLISTED.has(definition.slug))
    .sort((a, b) => a.name.localeCompare(b.name)),
);

/**
 * Lists every agent a user can run.
 *
 * The catalog is the definitions that ship with this release (`@orbik/agent-definitions`), read
 * from code: nothing about an agent is stored, so there is nothing here to query.
 */
export function listAgentDefinitions() {
  return BY_NAME;
}

/** Finds one agent by its slug, or null when there is none. */
export function findAgent(slug) {
  return findAgentDefinition(slug);
}
