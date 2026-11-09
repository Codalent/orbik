import { apiFetch } from "./client";
import { requireId, requireSlug } from "./ids";

function base(workspaceId, agentSlug) {
  return `/v1/workspaces/${requireId(workspaceId, "Workspace")}/agents/${requireSlug(agentSlug)}`;
}

/**
 * Where an agent's setup is read from — the setup, the agent itself, and whether there is a crawl
 * to choose pages from; also its cache key.
 */
export function agentSetupPath(workspaceId, agentSlug) {
  return `${base(workspaceId, agentSlug)}/setup`;
}

/**
 * Saves the pages the agent tracks.
 *
 * @param {{pages: Array<{url: string, label?: string, pattern?: string}>}} values
 */
export function saveAgentSetup(workspaceId, agentSlug, { pages }) {
  return apiFetch(`${base(workspaceId, agentSlug)}/setup`, {
    method: "PUT",
    body: JSON.stringify({ pages }),
  });
}

/** Sets the agent to work, or pauses it. */
export function setAgentWorking(workspaceId, agentSlug, working) {
  return apiFetch(`${base(workspaceId, agentSlug)}/working`, {
    method: "PUT",
    body: JSON.stringify({ working }),
  });
}
