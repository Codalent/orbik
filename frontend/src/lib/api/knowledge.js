import { apiFetch } from "./client";
import { requireId, requireSlug } from "./ids";

/**
 * Where the llms.txt page's state — the file, with its sections parsed out of the text — is read
 * from; also its cache key.
 */
export function llmsDocumentPath(workspaceId) {
  return `/v1/workspaces/${requireId(workspaceId, "Workspace")}/llms-txt`;
}

/**
 * Where an agent's source verdicts — what it decided about the site's pages — are read from; also
 * their cache key.
 *
 * `relevant` is left out to see everything, and set to see one half — which is the question
 * somebody actually asks: "what did it leave out, and why?"
 */
export function agentSourcesPath(workspaceId, agentSlug, { relevant, limit = 200, skip = 0 } = {}) {
  const query = new URLSearchParams({ limit: String(limit), skip: String(skip) });
  if (relevant !== undefined) query.set("relevant", String(relevant));
  return `/v1/workspaces/${requireId(workspaceId, "Workspace")}/agents/${requireSlug(agentSlug)}/sources?${query}`;
}

/**
 * Asks for an agent's output to be written from a page that was left out of it.
 *
 * A request rather than an edit: it records that somebody wants the page, and the agent's next
 * run is written from it. The reply says so in words, because the button is instant and the run
 * is not, and a person who sees nothing appear concludes the click did nothing.
 */
export function includeAgentSource(workspaceId, agentSlug, key) {
  return apiFetch(
    `/v1/workspaces/${requireId(workspaceId, "Workspace")}/agents/${requireSlug(agentSlug)}/sources/include`,
    { method: "POST", body: JSON.stringify({ key }) },
  );
}
