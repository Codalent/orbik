import { apiFetch, apiFetchText } from "./client";
import { requireId } from "./ids";

/**
 * Where a workspace's crawl overview — its crawl configuration and current status — is read from;
 * also its cache key.
 */
export function crawlOverviewPath(workspaceId) {
  return `/v1/workspaces/${requireId(workspaceId, "Workspace")}/crawl`;
}

/** Creates or replaces a workspace's crawl configuration. */
export function saveCrawlSite(workspaceId, settings) {
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/crawl`, {
    method: "PUT", body: JSON.stringify(settings),
  });
}

/**
 * Asks for a crawl to start.
 *
 * The body is an empty object rather than absent: the API requires JSON on every state-changing
 * request, so a bodyless POST is refused before it reaches the route.
 */
export function requestCrawl(workspaceId, { fresh = false } = {}) {
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/crawl/runs`, {
    method: "POST", body: JSON.stringify(fresh ? { fresh: true } : {}),
  });
}

/** Deletes everything crawled for a workspace, keeping its crawl settings. */
export function clearCrawlData(workspaceId) {
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/crawl/clear`, {
    method: "POST", body: "{}",
  });
}

/** Where a workspace's recent crawl runs are read from; also their cache key. */
export function crawlRunsPath(workspaceId, limit = 10) {
  return `/v1/workspaces/${requireId(workspaceId, "Workspace")}/crawl/runs?limit=${Number(limit)}`;
}

/**
 * Expands one level of the site's route tree.
 *
 * One request per branch, because a site can have fifty thousand URLs and a person looks at a
 * dozen. `skip` is what a "show more" sends to continue a branch it has already partly drawn.
 */
export function getCrawlTree(workspaceId, { path = "/", limit = 20, skip = 0 } = {}) {
  const query = new URLSearchParams({ path, limit: String(limit), skip: String(skip) });
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/crawl/tree?${query}`);
}

/**
 * Where one crawled page's record — everything the crawl recorded about it — is read from; also
 * its cache key.
 */
export function crawlPagePath(workspaceId, urlHash) {
  if (!/^[0-9a-f]{64}$/i.test(urlHash ?? "")) throw new Error("Page identifier is invalid.");
  return `/v1/workspaces/${requireId(workspaceId, "Workspace")}/crawl/pages/${urlHash.toLowerCase()}`;
}

/**
 * Reads what the crawl is doing right now.
 *
 * Polled while a crawl runs, which is the only time it changes. `before` pages back through
 * earlier entries without re-reading the ones already on screen.
 */
export function getCrawlActivity(workspaceId, { before, limit = 25 } = {}) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (before) query.set("before", before);
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/crawl/activity?${query}`);
}

/**
 * Pins one page to its own crawl frequency, or returns it to its pattern's.
 *
 * @param {{intervalHours: number|null}|null} override the page's own interval, null hours for
 *   never, or null altogether to follow the pattern again
 */
export function setCrawlPageSchedule(workspaceId, urlHash, override) {
  if (!/^[0-9a-f]{64}$/i.test(urlHash ?? "")) throw new Error("Page identifier is invalid.");
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/crawl/pages/${urlHash.toLowerCase()}/schedule`, {
    method: "PUT", body: JSON.stringify({ override }),
  });
}

/**
 * Asks for one page, or every page of one route pattern, to be crawled on the next pass.
 *
 * This is the manual trigger behind a frequency of "never": the pages are marked wanted and the
 * site is made due, whatever their interval says.
 */
export function recrawlPages(workspaceId, target) {
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/crawl/recrawl`, {
    method: "POST", body: JSON.stringify(target),
  });
}

/**
 * Sets one crawl frequency on a selection of pages and folders.
 *
 * @param {{urlHashes: string[], paths: string[]}} targets pages by hash, folders by path
 * @param {number|null} intervalHours hours between crawls, or null for manual trigger
 */
export function setCrawlFrequencies(workspaceId, targets, intervalHours) {
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/crawl/frequencies`, {
    method: "PUT", body: JSON.stringify({ targets, intervalHours }),
  });
}

/** Reads a page's content as Markdown, as text. */
export function getCrawlPageMarkdown(workspaceId, urlHash) {
  if (!/^[0-9a-f]{64}$/i.test(urlHash ?? "")) throw new Error("Page identifier is invalid.");
  return apiFetchText(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/crawl/pages/${urlHash.toLowerCase()}/markdown`);
}

/**
 * Lists the pages that have a Markdown rendering, by path, without the text.
 *
 * @param {{limit?: number, skip?: number}} [query]
 */
export function listCrawlMarkdown(workspaceId, { limit = 200, skip = 0 } = {}) {
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/crawl/markdown?limit=${Number(limit)}&skip=${Number(skip)}`);
}

/** Lists the crawled site's routes, grouped by pattern, for choosing pages. */
export function listCrawlRoutes(workspaceId, { limit = 200 } = {}) {
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/crawl/routes?limit=${Number(limit)}`);
}

/** Lists the pages of one route pattern, so a person can pick which post stands for the route. */
export function listCrawlRoutePages(workspaceId, { pattern, search = "", limit = 50 }) {
  const query = new URLSearchParams({ pattern, limit: String(limit) });
  if (search) query.set("search", search);
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/crawl/routes/pages?${query}`);
}
