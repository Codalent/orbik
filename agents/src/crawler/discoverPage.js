import { ObjectId } from "mongodb";
import { getAgentCollections } from "@orbik/core";
import { CRAWLER_AGENT, CRAWLER_JOBS } from "../jobs.js";
import { AgentError } from "../runtime/errors.js";
import { extractPage } from "./extract.js";
import { discoveryJob, fetchJob, queueStoredLinks, recordLinks, sameRun } from "./fetchPage.js";
import { createScope } from "./scope.js";
import { parseSiteConfig } from "./siteConfig.js";
import { createUrlRegistry } from "./urlRegistry.js";
import { loadRobotsForSite } from "./robotsStore.js";
import { awaitedJobs, recrawlPriority } from "./priority.js";
import { detectSiteBlock, isRunBlocked, recordBlocked, recordNotBlocked } from "./siteBlock.js";
import { canRetry, isRunRateLimited, rateLimitedError, recordServed, recordThrottled, THROTTLE_STATUSES } from "./throttle.js";

/**
 * Free link exploration persists the frontier, never a paid page snapshot.
 *
 * It runs in two places. As a pass of its own before any page is fetched, when discovery decided
 * the month's allowance might not cover the site (`./discover.js`). And for a single page whose
 * fetch found the allowance gone, in a crawl that had no such pass (`./fetchPage.js`).
 */
export function createDiscoverPageHandler({ createFetcherFor }) {
  return async (job, { database, signal }) => {
    const collections = getAgentCollections(database);
    const siteId = new ObjectId(job.payload.siteId);
    const site = await collections.sites.findOne({ _id: siteId });
    if (!site) throw new AgentError({ code: "SITE_NOT_FOUND", message: "Site no longer exists." });
    const registry = createUrlRegistry({ urls: collections.urls });
    const record = await registry.find(siteId, job.payload.urlHash);
    if (!record) return {};
    // A page is read for its links once per run, by this or by a fetch. A second job for it is
    // possible for the reason given in the fetch handler, and like there it sends no request and
    // still queues what the page links to, from the links on record.
    if (sameRun(record.lastExploredRunId, job.runId) || sameRun(record.lastRunId, job.runId)) {
      return { enqueue: await queueStoredLinks({ collections, registry, job, siteId, urlHash: record.urlHash, discovery: true }) };
    }
    // Discovery is free for the account but not for the server, so a run the site has stopped
    // explores nothing more either.
    if (await isRunRateLimited(collections.runs, job.runId)) return { counters: { pagesSkippedRateLimited: 1 } };
    if (await isRunBlocked(collections.runs, job.runId)) return {};
    const config = parseSiteConfig(site);
    const scope = createScope(config);
    const fetcher = createFetcherFor(config);
    const { rules } = await loadRobotsForSite({ robots: collections.robots, fetcher, siteId, config, runId: job.runId, signal });
    const target = new URL(record.url);
    if (!scope.allows(target, record.depth ?? 0).allowed
      || !rules.allows(target.pathname + target.search)) return {};
    // Redirects that loop are explored as what the server last sent — a redirect, with no links —
    // for the reason given in the fetch handler.
    const response = await fetcher.fetch(record.url, { signal, hostDelayMs: rules.crawlDelay ? rules.crawlDelay * 1000 : undefined })
      .catch((error) => {
        if (error?.code === "TOO_MANY_REDIRECTS" && error.response) return error.response;
        throw error;
      });
    // Checked before anything is read from the response: a bot-protection page has no links, and
    // a home page that turns the crawler away ends the crawl here, before any budget is spent.
    const block = detectSiteBlock(response);
    const seed = record.urlHash === scope.seed.hash;
    if (block && (block.kind === "challenge" || seed)) {
      await recordBlocked({ runs: collections.runs, runId: job.runId, block, url: record.url, seed });
      return {};
    }
    await recordNotBlocked(collections.runs, job.runId);
    // Same contract as the paid fetch: a refusal is retried when the server said it could be, and
    // only the last permitted attempt lets the page through as "explored" with nothing found.
    if (THROTTLE_STATUSES.has(response.status)) {
      await recordThrottled({ runs: collections.runs, runId: job.runId, status: response.status, url: record.url, retryAfterMs: response.retryAfterMs ?? null });
      if (canRetry(job)) throw rateLimitedError({ status: response.status, url: record.url, retryAfterMs: response.retryAfterMs ?? 30_000 });
    } else {
      await recordServed(collections.runs, job.runId);
    }
    const html = /text\/html|application\/xhtml\+xml/i.test(response.headers?.["content-type"] ?? "");
    const discovered = html ? await recordLinks({ collections, registry, job, siteId, config, scope, rules, record,
      extracted: extractPage(response.body, { url: response.url }), discovery: true }) : { enqueue: [], newUrls: 0, newEligible: 0 };
    // Mark only after links are durable. Queue keys cover a retry between these writes.
    await collections.urls.updateOne({ siteId, urlHash: record.urlHash }, { $set: { lastExploredRunId: job.runId, lastExploredAt: new Date() } });
    return { counters: { discoveryPages: 1, urlsNew: discovered.newUrls, urlsDiscovered: discovered.newEligible }, enqueue: discovered.enqueue.map((entry) =>
      discoveryJob({ siteId, runId: job.runId, urlHash: entry.payload.urlHash, priority: entry.priority })) };
  };
}

/**
 * The phase barrier: no paid fetch starts until the free frontier drains.
 *
 * A crawl with no discovery pass has no frontier to wait for, and comes straight through: the
 * pages planned here are the ones known from the seed, the sitemaps and earlier crawls, and the
 * fetches find the rest by following links. `pagesPlanned` is therefore the count at this moment,
 * not the number of pages the run will fetch.
 *
 * The job that queued this one is counted as outstanding too. Follow-up jobs become visible in no
 * particular order, so this can be claimed while the discovery jobs queued with it are still being
 * written; their parent is still running until they all are.
 */
export function createStartFetchHandler() {
  return async (job, { database }) => {
    const collections = getAgentCollections(database);
    const { outstanding, recheckAt } = await awaitedJobs(collections.jobs, { runId: job.runId, type: { $in: [CRAWLER_JOBS.discover, CRAWLER_JOBS.discoverPage] } });
    if (outstanding) {
      const recheck = (job.payload.recheck ?? 0) + 1;
      return { enqueue: [{ ...job, _id: undefined, payload: { ...job.payload, recheck }, availableAt: recheckAt, idempotencyKey: `start-fetch:${job.runId}:${recheck}` }] };
    }
    const siteId = new ObjectId(job.payload.siteId);
    const registry = createUrlRegistry({ urls: collections.urls });
    const rows = await collections.urls.find({ siteId, eligible: true }).project({ urlHash: 1 }).toArray();
    const pending = await registry.pendingForRun({ siteId, runId: job.runId, hashes: rows.map((row) => row.urlHash) });
    await collections.runs.updateOne({ _id: job.runId }, { $set: { phase: "fetching", "counters.urlsDiscovered": rows.length } });
    return { enqueue: [...pending.map((row) => fetchJob({ siteId, runId: job.runId, urlHash: row.urlHash, priority: recrawlPriority(row) })), {
      agent: CRAWLER_AGENT, type: CRAWLER_JOBS.finalize, payload: { siteId: String(siteId), recheck: 0 }, priority: 9,
      idempotencyKey: `finalize:${job.runId}:0`,
    }], counters: { pagesPlanned: pending.length } };
  };
}
