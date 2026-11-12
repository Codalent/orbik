import { agentDefinitions, findAgentDefinition } from "@orbik/agent-definitions";

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

/**
 * Lists every agent a user can run, in name order, which is the order the catalog is shown in.
 *
 * The catalog is the definitions that ship with this release (`@orbik/agent-definitions`) and any
 * the API's extensions added, read from code: nothing about an agent is stored, so there is
 * nothing here to query. Read on each call, because extensions add theirs after this module loads.
 */
export function listAgentDefinitions() {
  return agentDefinitions()
    .filter((definition) => !UNLISTED.has(definition.slug))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Finds one agent by its slug, or null when there is none. */
export function findAgent(slug) {
  return findAgentDefinition(slug);
}
