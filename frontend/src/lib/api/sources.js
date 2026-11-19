import { apiFetch } from "./client";
import { requireId } from "./ids";

/**
 * A workspace's sources: everything Orbik reads for it, its website first.
 *
 * A source's crawl — its runs, pages and frequencies — is read through `@/lib/api/crawl` with
 * `crawlScope(workspaceId, sourceId)`; these are the sources themselves.
 */

/** A source id as the routes take it: an id, or `website` for the workspace's website. */
function sourceSegment(sourceId) {
  return sourceId === "website" ? "website" : requireId(sourceId, "Source");
}

/** Where the list of a workspace's sources is read from; also its cache key. */
export function sourcesPath(workspaceId) {
  return `/v1/workspaces/${requireId(workspaceId, "Workspace")}/sources`;
}

/** Where one source in full is read from; also its cache key. */
export function sourcePath(workspaceId, sourceId) {
  return `${sourcesPath(workspaceId)}/${sourceSegment(sourceId)}`;
}

/** Where the pages about the company its website links to are read from; also the cache key. */
export function sourceSuggestionsPath(workspaceId) {
  return `${sourcesPath(workspaceId)}/suggestions`;
}

/** What an address is, before it is added. Saves nothing. */
export function checkSource(workspaceId, url) {
  return apiFetch(`${sourcesPath(workspaceId)}/check`, { method: "POST", body: JSON.stringify({ url }) });
}

/** Adds a source and asks for its first read. */
export function addSource(workspaceId, source) {
  return apiFetch(sourcesPath(workspaceId), { method: "POST", body: JSON.stringify(source) });
}

/** Changes a source's settings; only the fields sent change. */
export function updateSource(workspaceId, sourceId, changes) {
  return apiFetch(sourcePath(workspaceId, sourceId), { method: "PATCH", body: JSON.stringify(changes) });
}

/** Removes a source, its crawl and its folder of the Library. */
export function removeSource(workspaceId, sourceId) {
  return apiFetch(sourcePath(workspaceId, sourceId), { method: "DELETE", body: "{}" });
}

/** Stops suggesting one address. */
export function dismissSourceSuggestion(workspaceId, url) {
  return apiFetch(`${sourceSuggestionsPath(workspaceId)}/dismiss`, { method: "POST", body: JSON.stringify({ url }) });
}
