/**
 * What the llms.txt page knows without a server: the agent's identity.
 *
 * The slug is duplicated from `@orbik/core` rather than imported because the web app is a
 * separate build that does not depend on the workspace packages. It is part of the URL, so a
 * change to it is already a coordinated one.
 */

/** The agent that maintains llms.txt; also its route segment. */
export const LLMS_TXT_AGENT_SLUG = "llms-txt";
