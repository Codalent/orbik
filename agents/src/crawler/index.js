import { createDiscoverPageHandler, createStartFetchHandler } from "./discoverPage.js";
import { createFetcher } from "./fetcher.js";
import { createDiscoverHandler } from "./discover.js";
import { createFetchHandler } from "./fetchPage.js";
import { createFinalizeHandler } from "./finalize.js";
import { crawlerUserAgent } from "./siteConfig.js";
import { CRAWLER_AGENT, CRAWLER_JOBS } from "../jobs.js";
import { defineAgent } from "../runtime/registry.js";

/**
 * The crawler: the agent every other agent reads from.
 *
 * Its job is twofold — **discover** which URLs a site has, then **fetch** each one and record what
 * it found. They are separate handlers because they fail differently: discovery is a handful of
 * requests that establish the shape of a crawl, fetching is thousands that fill it in. A third
 * handler, `finalize`, runs once the crawl drains and computes what only the finished link graph
 * can answer: exact click depth, and which pages nothing links to.
 *
 * @param {object} [options] collaborators
 * @param {(config: object) => {fetch: Function}} [options.createFetcherFor] builds a site's HTTP
 *   client; defaults to one polite fetcher per seed URL and host interval
 */
export function createCrawlerAgent(options = {}) {
  const clients = new Map();
  const createFetcherFor = options.createFetcherFor ?? ((config) => {
    const key = `${config.seedUrl}:${config.minHostIntervalMs}`;
    if (!clients.has(key)) {
      if (clients.size >= 100) clients.delete(clients.keys().next().value);
      clients.set(key, createFetcher({ userAgent: crawlerUserAgent(), minHostIntervalMs: config.minHostIntervalMs }));
    }
    return clients.get(key);
  });

  return defineAgent({
    name: CRAWLER_AGENT,
    version: 1,
    handlers: {
      [CRAWLER_JOBS.discover]: createDiscoverHandler({ createFetcherFor }),
      [CRAWLER_JOBS.discoverPage]: createDiscoverPageHandler({ createFetcherFor }),
      [CRAWLER_JOBS.startFetch]: createStartFetchHandler(),
      [CRAWLER_JOBS.fetch]: createFetchHandler({ createFetcherFor }),
      [CRAWLER_JOBS.finalize]: createFinalizeHandler(),
    },
  });
}
