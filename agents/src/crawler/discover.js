import { CRAWLER_AGENT, CRAWLER_JOBS } from "../jobs.js";
import { AgentError, requireObjectId } from "../runtime/errors.js";
import { createCrawlBudget } from "@orbik/crawl-budget";
import { discoveryJob } from "./fetchPage.js";
import { getAgentCollections } from "@orbik/core";
import { collectSitemapUrls } from "./sitemap.js";
import { createScope } from "./scope.js";
import { createUrlRegistry, DISCOVERY_SOURCES } from "./urlRegistry.js";
import { loadRobotsForSite } from "./robotsStore.js";
import { parseSiteConfig } from "./siteConfig.js";
import { recrawlPriority } from "./priority.js";
import { tryNormalizeUrl } from "./url.js";

/** Sitemap locations tried when robots.txt declares none. */
const CONVENTIONAL_SITEMAPS = Object.freeze(["/sitemap.xml", "/sitemap_index.xml"]);

/**
 * How much of the month's allowance must be left, as a multiple of the URLs known for the site,
 * for a crawl to go without a discovery pass of its own.
 *
 * Half as much again as is known, because what is known at this point is a floor: the sitemaps
 * and earlier crawls, before a single link has been followed.
 */
const SINGLE_PASS_HEADROOM = 1.5;

/**
 * Builds the crawler's discovery step: work out which URLs a site has, before fetching any of them.
 *
 * Discovery is separated from fetching because the two fail differently and are worth retrying on
 * different schedules. Discovery is a handful of requests that establish the shape of a crawl;
 * fetching is thousands of requests that fill it in. Merging them would mean a single sitemap
 * timeout re-runs the whole crawl.
 *
 * Sources are combined rather than ranked: the seed, robots.txt-declared sitemaps, conventional
 * sitemap locations, and (on later runs) URLs already in the registry. Sitemaps matter most
 * because they list pages the owner wants crawled — including orphan pages that nothing links to,
 * which a link-following crawl would never reach at all.
 *
 * What follows depends on the account's crawl budget. A page's links can be read for free, by a
 * discovery pass that requests every page once before any is fetched, or as part of the fetch
 * that is going to request it anyway. The pass doubles the requests of a first crawl, and buys
 * one thing: a site the allowance cannot cover is known in full before the allowance runs out
 * part-way through it. So it runs only when that could happen — when what is left of the month
 * does not cover the URLs known, with headroom. Otherwise the crawl goes straight to fetching,
 * and each fetch queues the pages it finds.
 *
 * @param {object} dependencies collaborators
 * @param {(config: object) => {fetch: Function}} dependencies.createFetcherFor builds the HTTP client for a site
 * @returns {(job: object, context: object) => Promise<object>} the `crawler.discover` handler
 */
export function createDiscoverHandler({ createFetcherFor }) {
  return async function discover(job, { database, logger, signal }) {
    const collections = getAgentCollections(database);

    const siteId = requireObjectId(job.payload?.siteId ?? job.siteId, "siteId");
    const document = await collections.sites.findOne({ _id: siteId });
    if (!document) {
      // A deleted site is not going to reappear, so retrying would only burn attempts.
      throw new AgentError({ code: "SITE_NOT_FOUND", message: `Site ${siteId.toHexString()} does not exist.` });
    }

    await collections.runs.updateOne({ _id: job.runId }, { $set: { phase: "discovering" } });
    const config = parseSiteConfig(document);
    const scope = createScope(config);
    const registry = createUrlRegistry({ urls: collections.urls });
    const fetcher = createFetcherFor(config);
    const normalizeOptions = {
      stripParams: config.stripParams,
      keepTrackingParams: config.keepTrackingParams,
      sortQuery: config.sortQuery,
    };

    // Discovery always fetches robots.txt fresh: it is the first request of a crawl, and a stale
    // copy would let a crawl start under permissions the site has since changed.
    const robots = await loadRobotsForSite({
      robots: collections.robots,
      fetcher,
      siteId,
      config,
      runId: job.runId,
      signal,
      maxAgeMs: 0,
    });

    // A site that disallows us entirely is a finished crawl with a recorded reason, not a
    // failure: there is nothing to retry, and reporting it as an error would bury the actual
    // finding the operator needs to see.
    const seedAllowed = robots.rules.allows(`${scope.seed.pathname}${scope.seed.search}`);
    if (!seedAllowed) {
      logger("warn", "crawler.blocked_by_robots", { siteId: siteId.toHexString(), source: robots.rules.source });
    }

    const sitemapSeeds = resolveSitemapSeeds(config.sitemapUrls, robots.rules.sitemaps, config.seedUrl, normalizeOptions);
    const sitemap = await collectSitemapUrls({ fetcher, seeds: sitemapSeeds, signal });

    const candidates = new Map();
    addCandidate(candidates, {
      normalized: scope.seed,
      sources: [DISCOVERY_SOURCES.seed],
      depth: 0,
    });
    for (const entry of sitemap.entries) {
      const normalized = tryNormalizeUrl(entry.url, normalizeOptions);
      if (!normalized) continue;
      // Sitemaps routinely list other hosts — a shared sitemap index across a group of sites, or a
      // subdomain's pages. Those belong to their own crawl, so they are not registered here.
      if (normalized.hostname !== scope.seed.hostname) continue;
      addCandidate(candidates, {
        normalized,
        sources: [DISCOVERY_SOURCES.sitemap],
        // A sitemap says nothing about link depth. Leaving it unset keeps the registry's
        // shortest-path depth honest until a link crawl establishes a real one.
        depth: null,
        sitemap: { lastmod: entry.lastmod, changefreq: entry.changefreq, priority: entry.priority },
      });
    }

    const entries = [];
    let outOfScope = 0;
    let robotsBlocked = 0;
    for (const candidate of candidates.values()) {
      const decision = scope.allows(candidate.normalized, candidate.depth ?? 0);
      const target = `${candidate.normalized.pathname}${candidate.normalized.search}`;
      const allowed = robots.rules.allows(target);
      if (!decision.allowed) outOfScope += 1;
      else if (!allowed) robotsBlocked += 1;

      entries.push({
        url: candidate.normalized.href,
        hash: candidate.normalized.hash,
        host: candidate.normalized.host,
        sources: [...candidate.sources],
        depth: candidate.depth,
        sitemap: candidate.sitemap,
        inScope: decision.allowed,
        scopeReason: decision.reason ?? null,
        robotsAllowed: allowed,
      });
    }

    // Discovery is not capped, and is never charged for. Knowing a site has 40,000 URLs is the
    // finding; how many of them this month's allowance can fetch is a separate question, answered
    // one page at a time by the fetch handler. Truncating here instead would make "how big is my
    // site" depend on how much crawling had already been paid for.
    const crawlable = entries.filter((entry) => entry.inScope && entry.robotsAllowed);

    const workspaceId = job.workspaceId ?? document.workspaceId;
    const written = await registry.record({
      siteId,
      workspaceId,
      runId: job.runId,
      entries,
    });

    // Measured against everything known for the site, not only what this pass turned up: on a
    // later crawl the registry already holds the pages earlier ones found by following links,
    // which no sitemap may list. An account with nothing left, or none that can be found, has
    // zero remaining and gets the discovery pass, which is the half of a crawl it can still have.
    const knownUrls = await registry.count(siteId, { eligible: true });
    // A month with no limit (`remaining` null) can pay for every page, so it never needs the pass.
    const { remaining } = await createCrawlBudget({ database }).statusFor({ workspaceId });
    const separatePass = remaining !== null && remaining < Math.ceil(knownUrls * SINGLE_PASS_HEADROOM);
    // Recorded so a run can be read afterwards: why it did or did not have a discovery pass.
    await collections.runs.updateOne(
      { _id: job.runId },
      { $set: { discovery: { separatePass, knownUrls, budgetRemaining: remaining } } },
    );

    // Jobs are returned rather than queued directly, so the runtime enqueues them before it
    // completes this job: a crash in between re-runs discovery, which re-queues the same
    // idempotency keys instead of leaving a crawl that discovered pages it never fetches.
    const pending = separatePass
      ? await registry.pendingForRun({
        siteId,
        runId: job.runId,
        discovery: true,
        hashes: crawlable.map((entry) => entry.hash),
      })
      : [];
    // Queued at the lowest priority and self-rescheduling, so it runs after the discovery work it
    // depends on without needing a coordinator to declare the frontier drained. With no discovery
    // pass there is nothing for it to wait for, and it plans the fetches at once.
    const startFetchJob = {
      agent: CRAWLER_AGENT,
      type: CRAWLER_JOBS.startFetch,
      payload: { siteId: siteId.toHexString(), recheck: 0 },
      priority: 9,
      idempotencyKey: `start-fetch:${job.runId ? job.runId.toHexString() : "manual"}:0`,
    };
    const enqueue = pending.map((row) =>
      discoveryJob({ siteId, runId: job.runId, urlHash: row.urlHash, priority: recrawlPriority(row) }));

    return {
      enqueue: [...enqueue, startFetchJob],
      counters: {
        urlsDiscovered: entries.length,
        urlsNew: written.inserted,
        urlsCrawlable: crawlable.length,
        urlsOutOfScope: outOfScope,
        urlsRobotsBlocked: robotsBlocked,
        sitemapsFetched: sitemap.fetched.length,
        sitemapErrors: sitemap.errors.length,
      },
    };
  };
}

/**
 * Chooses which sitemap URLs to walk.
 *
 * robots.txt declarations win because they are the site's own statement of where its sitemaps
 * are. The conventional locations are tried only when neither the site nor the operator says
 * where to look, so a site with a correct declaration is never asked for URLs it did not
 * advertise, and neither is one whose owner already told us.
 *
 * @param {string[]} configured sitemaps the operator named, already pinned to the seed's host
 * @param {string[]} declared sitemaps robots.txt advertises
 */
function resolveSitemapSeeds(configured, declared, seedUrl, normalizeOptions) {
  const seeds = [];
  const seen = new Set();
  // Configured sitemaps are added to what robots.txt declares rather than replacing it, and they
  // are what stops the conventional guesses from being tried: someone who names their sitemaps has
  // told us where they are, and a site silent on the subject is the only one worth guessing about.
  const discovered = declared.length
    ? declared
    : (configured.length ? [] : CONVENTIONAL_SITEMAPS.map((path) => new URL(path, seedUrl).href));
  const sources = [...configured, ...discovered];

  for (const candidate of sources) {
    const normalized = tryNormalizeUrl(candidate, { base: seedUrl, ...normalizeOptions });
    if (!normalized || seen.has(normalized.href)) continue;
    seen.add(normalized.href);
    seeds.push(normalized.href);
  }
  return seeds;
}

/**
 * Merges one candidate into the discovery set.
 *
 * A URL reached from several sources keeps the shallowest known depth and the richest metadata,
 * so learning about a page twice never downgrades what is known about it.
 */
function addCandidate(candidates, candidate) {
  const existing = candidates.get(candidate.normalized.hash);
  if (!existing) {
    candidates.set(candidate.normalized.hash, { ...candidate, sources: new Set(candidate.sources) });
    return;
  }
  // Sources accumulate rather than being replaced: "in the sitemap and linked from the home
  // page" is a stronger signal than either alone, and keeping only the first-seen source would
  // throw that away for exactly the pages most likely to matter.
  for (const source of candidate.sources) existing.sources.add(source);
  if (Number.isInteger(candidate.depth) && (!Number.isInteger(existing.depth) || candidate.depth < existing.depth)) {
    existing.depth = candidate.depth;
  }
  existing.sitemap = existing.sitemap ?? candidate.sitemap;
}
