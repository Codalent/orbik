import { requireId } from "./ids";

/**
 * Where the Agents overview is read from — each agent's newest run in the workspace, and whether
 * it is set to work and when it runs next — and also its cache key. One read for every agent, rather than each agent's page read in turn.
 */
export function agentOverviewPath(workspaceId) {
  return `/v1/workspaces/${requireId(workspaceId, "Workspace")}/agents`;
}
