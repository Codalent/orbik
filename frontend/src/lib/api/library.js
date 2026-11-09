import { apiFetch } from "./client";
import { requireId } from "./ids";

/**
 * The Library's HTTP surface, as the browser sees it.
 *
 * A node is addressed by its path, so these functions build URLs by appending it — which is why
 * every one of them checks the path first. The API validates it again; this check is here so a
 * malformed path fails as a clear message rather than as a 400 from a URL nobody meant to build.
 */

/** Rejects anything that is not a Library path before it reaches a URL. */
function requirePath(value) {
  const path = String(value ?? "");
  if (!/^(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/.test(path)) throw new Error("That Library path is invalid.");
  return path;
}

/**
 * A query string in the grammar the API client accepts.
 *
 * `URLSearchParams` writes a space as `+` and leaves `*` bare, and the client refuses both — which
 * made every search of more than one word fail before it was sent. A `+` it wrote can only be a
 * space (a typed `+` comes out as `%2B`), so both are percent-encoded instead.
 */
function queryOf(params) {
  return new URLSearchParams(params).toString().replace(/\+/g, "%20").replace(/\*/g, "%2A");
}

/**
 * Where the Library's tree and state — its tree, size, sources and last run: everything the page
 * opens with — are read from; also their cache key.
 */
export function libraryPath(workspaceId, { path = "/", depth = 6 } = {}) {
  const query = new URLSearchParams({ path, depth: String(depth) });
  return `/v1/workspaces/${requireId(workspaceId, "Workspace")}/library?${query}`;
}

/**
 * Reads one branch of the tree, for a folder the first read elided.
 *
 * The Library page asks for the whole tree once, bounded at five hundred nodes; a site whose
 * source layer mirrors two thousand pages does not fit in that, and the folders that did not fit
 * come back carrying a count instead of their children. This is how a person opens one of them
 * without the page having to fetch the other nineteen hundred nodes it did not ask about.
 */
export function getLibraryTree(workspaceId, path, { depth = 2 } = {}) {
  const query = new URLSearchParams({ path: requirePath(path), depth: String(depth) });
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/library/tree?${query}`);
}

/** Reads one folder or file. */
export function getLibraryNode(workspaceId, path) {
  return apiFetch(libraryNodePath(workspaceId, path));
}

/** Where one Library node is read from; also its cache key. */
export function libraryNodePath(workspaceId, path) {
  return `/v1/workspaces/${requireId(workspaceId, "Workspace")}/library/nodes${requirePath(path)}`;
}

/** Searches the Library by what its files say. */
export function searchLibrary(workspaceId, query, { path = "/", limit = 20 } = {}) {
  const search = queryOf({ q: query, path, limit: String(limit) });
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/library/search?${search}`);
}

/**
 * Searches by meaning: passages that answer a question, from the site's pages and the Library's
 * own files, each naming the Library file it opens. `kinds` narrows it to `page` or `library`.
 */
export function searchLibraryPassages(workspaceId, query, { kinds = [], limit = 6 } = {}) {
  const search = queryOf({ q: query, limit: String(limit), ...(kinds.length ? { kinds: kinds.join(",") } : {}) });
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/library/passages?${search}`);
}

/** Where the files that link to one node are read from; also their cache key. */
export function libraryBacklinksPath(workspaceId, path) {
  return `/v1/workspaces/${requireId(workspaceId, "Workspace")}/library/backlinks${requirePath(path)}`;
}

/** Finds where the copy of one page of the site is kept, by the page's address. */
export function locateLibraryPage(workspaceId, url) {
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/library/locate?${queryOf({ url })}`);
}

/**
 * Which files of the knowledge base a changed page of the site has left behind. `version` is a
 * number that changes whenever the Library is written to, so the read is asked again then and
 * shared by everything on the page in between.
 */
export function libraryFreshnessPath(workspaceId, version = 0) {
  return `/v1/workspaces/${requireId(workspaceId, "Workspace")}/library/freshness?v=${Number(version) || 0}`;
}

/** Creates or replaces one folder or file. */
export function saveLibraryNode(workspaceId, path, node) {
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/library/nodes${requirePath(path)}`, {
    method: "PUT",
    body: JSON.stringify(node),
  });
}

/** Deletes a file, or an empty folder. */
export function deleteLibraryNode(workspaceId, path) {
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/library/nodes${requirePath(path)}`, {
    method: "DELETE",
  });
}

/**
 * Moves or renames a node, taking its subtree, its history and every link to it along. With a
 * `title` it is a rename: the node takes the new name, and its path the one that name gives.
 */
export function moveLibraryNode(workspaceId, path, to, { title } = {}) {
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/library/move${requirePath(path)}`, {
    method: "POST",
    body: JSON.stringify({ to: requirePath(to), ...(title ? { title } : {}) }),
  });
}

/** Sets where a node sits among its siblings; `null` puts it back in the default order. */
export function reorderLibraryNode(workspaceId, path, order) {
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/library/reorder${requirePath(path)}`, {
    method: "POST",
    body: JSON.stringify({ order }),
  });
}

/**
 * Saves the top-level structure a person chose, which creates its folders. Only while the
 * Library is waiting on a choice: before its first write, or after a rebuild was asked for.
 */
export function chooseLibraryStructure(workspaceId, groups) {
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/library/structure`, {
    method: "PUT",
    body: JSON.stringify({ groups }),
  });
}

/** Asks for the proposed structures again; the scheduler asks the model within a minute. */
export function suggestLibraryStructureAgain(workspaceId) {
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/library/structure/suggest`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/** Opens the structure step again: a rebuild, which waits for a new choice. */
export function requestLibraryRebuild(workspaceId) {
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/library/structure/rebuild`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/** Locks a node against agent writes, or lets them back in. */
export function setLibraryNodeLocked(workspaceId, path, locked) {
  const action = locked ? "lock" : "unlock";
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/library/${action}${requirePath(path)}`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/** Reads one file's kept versions. */
export function listLibraryRevisions(workspaceId, path) {
  return apiFetch(libraryRevisionsPath(workspaceId, path));
}

/** Where one file's kept versions are read from; also their cache key. */
export function libraryRevisionsPath(workspaceId, path) {
  return `/v1/workspaces/${requireId(workspaceId, "Workspace")}/library/revisions${requirePath(path)}`;
}

/** Puts a file back to one of its kept versions, as a new version. */
export function restoreLibraryRevision(workspaceId, path, revision) {
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/library/restore${requirePath(path)}`, {
    method: "POST",
    body: JSON.stringify({ revision }),
  });
}
