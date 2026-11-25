import { WORKSPACE_ICON_LIMITS, createWorkspaceIconStore, readIconImage } from "@orbik/assets";
import { getAgentCollections } from "@orbik/core";

import { CRAWLER_AGENT, CRAWLER_JOBS } from "../jobs.js";
import { requireObjectId } from "../runtime/errors.js";
import { loadRobotsForSite } from "./robotsStore.js";
import { createScope } from "./scope.js";
import { parseSiteConfig } from "./siteConfig.js";

/** How many addresses are tried for one icon before it is left to the next crawl. */
const MAX_ATTEMPTS = 4;

/** The size an icon that declares none, or `any`, is taken to be when they are ranked. */
const SCALABLE = 512;
const UNDECLARED = 32;
const APPLE_TOUCH_DEFAULT = 180;

/**
 * Describes the job that reads the website's icon for its workspace, queued by the fetch of the
 * home page: once per crawl, so a site that changes its icon changes the workspace's too.
 *
 * @param {object} input
 * @param {import("mongodb").ObjectId} input.siteId the website's crawl site
 * @param {unknown} [input.runId] the crawl run
 */
export function siteIconJob({ siteId, runId }) {
  return {
    agent: CRAWLER_AGENT,
    type: CRAWLER_JOBS.icon,
    payload: { siteId: siteId.toHexString() },
    // Early in the run: on a workspace's first crawl the icon is up before most of its pages are.
    priority: 1,
    idempotencyKey: `icon:${runId ? String(runId) : siteId.toHexString()}`,
  };
}

/**
 * The addresses worth trying for a site's icon, best first, from what its home page names.
 *
 * Shown at about 48 pixels and as small as 24, so the larger the better, and an
 * `apple-touch-icon` first: it is drawn to stand on its own as a tile, where a favicon is often a
 * mark on nothing, drawn for a light browser tab. An icon for one colour scheme only (`media`)
 * comes after every icon for both. `/favicon.ico` is last, where a browser looks when a page
 * names nothing.
 *
 * @param {Array<{rel: string, url: string, sizes?: string|null, type?: string|null, media?: string|null}>|undefined} icons
 *   what `extractPage` read from the home page
 * @param {string} pageUrl the home page's address
 * @returns {string[]} at most `MAX_ATTEMPTS` addresses
 */
export function rankIcons(icons, pageUrl) {
  const ranked = (Array.isArray(icons) ? icons : [])
    .filter((icon) => typeof icon?.url === "string")
    .map((icon) => ({ url: icon.url, media: icon.media ? 0 : 1, apple: icon.rel === "apple-touch-icon" ? 1 : 0, size: declaredSize(icon) }))
    .sort((left, right) => right.media - left.media || right.apple - left.apple || right.size - left.size);
  const urls = [...new Set(ranked.map((icon) => icon.url))];
  try {
    const fallback = new URL("/favicon.ico", pageUrl).href;
    if (!urls.includes(fallback)) urls.push(fallback);
  } catch {
    // A page address that does not parse has no root to look in.
  }
  return urls.slice(0, MAX_ATTEMPTS);
}

/** The largest size an icon declares, read from `sizes` ("16x16 32x32", "any") and its type. */
function declaredSize(icon) {
  const scalable = /svg/.test(icon.type ?? "") || /\.svg(?:$|[?#])/i.test(icon.url);
  const sizes = String(icon.sizes ?? "").split(/\s+/).filter(Boolean);
  if (sizes.includes("any") || (scalable && !sizes.length)) return SCALABLE;
  const largest = Math.max(0, ...sizes.map((size) => Number(size.split("x")[0])).filter(Number.isFinite));
  if (largest) return Math.min(largest, SCALABLE);
  return icon.rel === "apple-touch-icon" ? APPLE_TOUCH_DEFAULT : UNDECLARED;
}

/**
 * Builds the `crawler.icon` handler: fetch the website's icon and keep it as the workspace's.
 *
 * The home page's icons are read from its newest snapshot that was served whole, so a crawl the
 * home page answered with "not modified" still checks the icon. Each address is asked for through
 * the site's own client — paced with the crawl's pages, refused on a non-public address — and one
 * on the site's own host only when its robots.txt allows it. The first answer that is a picture of
 * a size an icon may be is kept.
 *
 * Nothing here fails the crawl. An icon is a nicety: a site with none, or one that will not serve
 * it, is logged and left, and the workspace keeps the icon it had — or its letter. The one error
 * passed on is the worker shutting down, so the job is tried again on the next start.
 *
 * @param {object} dependencies
 * @param {(config: object) => {fetch: Function}} dependencies.createFetcherFor the site's HTTP client
 */
export function createSiteIconHandler({ createFetcherFor }) {
  return async function readSiteIcon(job, { database, signal, logger }) {
    const collections = getAgentCollections(database);
    const siteId = requireObjectId(job.payload?.siteId ?? job.siteId, "siteId");
    const site = await collections.sites.findOne({ _id: siteId });
    if (!site?.workspaceId) return {};
    const config = parseSiteConfig(site);
    // The workspace is its website: another source's icon is somebody else's, or a section's.
    if (!config.primary) return {};
    const scope = createScope(config);

    const home = await collections.snapshots.findOne(
      { siteId, urlHash: scope.seed.hash, status: { $gte: 200, $lt: 300 } },
      { sort: { fetchedAt: -1 }, projection: { "extracted.icons": 1, finalUrl: 1, url: 1 } },
    );
    const pageUrl = home?.finalUrl ?? home?.url ?? scope.seed.href;
    const pageHost = new URL(pageUrl).host;
    const fetcher = createFetcherFor(config);
    let rules = null;
    const tried = [];

    for (const url of rankIcons(home?.extracted?.icons, pageUrl)) {
      const target = new URL(url);
      try {
        if (target.host === pageHost) {
          rules ??= (await loadRobotsForSite({ robots: collections.robots, fetcher, siteId, config, runId: job.runId, signal })).rules;
          if (!rules.allows(`${target.pathname}${target.search}`)) {
            tried.push({ url, reason: "robots" });
            continue;
          }
        }
        const response = await fetcher.fetch(url, { signal });
        if (response.status < 200 || response.status >= 300) {
          tried.push({ url, reason: `status ${response.status}` });
          continue;
        }
        const image = !response.truncated && response.bytes <= WORKSPACE_ICON_LIMITS.bytes ? readIconImage(response.buffer) : null;
        if (!image) {
          tried.push({ url, reason: response.truncated || response.bytes > WORKSPACE_ICON_LIMITS.bytes ? "too large" : "not an image" });
          continue;
        }
        const { changed } = await createWorkspaceIconStore({ database }).putSite({
          workspaceId: site.workspaceId,
          image,
          sourceUrl: response.url,
          pageUrl: home ? pageUrl : null,
        });
        logger?.("info", "crawler.site_icon", { siteId: siteId.toHexString(), url: response.url, mimeType: image.mimeType, changed });
        return {};
      } catch (error) {
        if (signal?.aborted) throw error;
        tried.push({ url, reason: error?.code ?? "FETCH_FAILED" });
      }
    }

    logger?.("info", "crawler.site_icon_not_found", { siteId: siteId.toHexString(), tried });
    return {};
  };
}
