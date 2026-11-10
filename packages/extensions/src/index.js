/**
 * The extension seam.
 *
 * Orbik's processes start through `loadExtensions`, which imports the modules named by
 * `ORBIK_EXTENSIONS` and lets each register against a small set of hooks. Nothing in this
 * repository registers one: with none loaded, every limit is unlimited, nothing listens, and the
 * edition is `community`. The contract is written down in docs/architecture/extensions.md.
 */
export { COMMUNITY_EDITION, EVENTS, PROCESSES, createExtensionHost } from "./host.js";
export { activeExtensions, loadExtensions, parseExtensionList } from "./loader.js";
export { createAiCallHooks } from "./aiCalls.js";
export { createOwnerLookup } from "./owners.js";
export { PLAN_LIMIT_REACHED, PlanLimitError, UNLIMITED, agentAllowed, normalizeLimits } from "./limits.js";
