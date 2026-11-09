import { MAX_ROBOTS_BYTES, createRobotsRules } from "@orbik/core";

import { CRAWLER_PRODUCT_TOKEN } from "./siteConfig.js";

/** How long a stored robots.txt is reused before it is fetched again. */
const ROBOTS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Loads a site's robots.txt rules, fetching only when what is stored is missing or stale.
 *
 * Without this cache, a 5,000-page crawl would request robots.txt 5,000 times: once per page job,
 * since each job runs independently and cannot pass rules to the next. That is both rude to the
 * site and slow. The stored copy keeps the raw text, not just the parsed summary, so the rules can
 * be rebuilt exactly rather than approximated from what a previous version chose to record.
 *
 * @param {object} options collaborators and policy
 * @param {import("mongodb").Collection} options.robots the `crawl_robots` collection
 * @param {{fetch: Function}} options.fetcher HTTP client
 * @param {import("mongodb").ObjectId} options.siteId site being crawled
 * @param {object} options.config validated site configuration
 * @param {import("mongodb").ObjectId} [options.runId] run to attribute a fresh fetch to
 * @param {AbortSignal} [options.signal] cancellation
 * @param {number} [options.maxAgeMs] override for the reuse window
 * @param {() => Date} [options.now] clock; defaults to the system clock
 * @returns {Promise<{rules: object, status: number|null, fromCache: boolean}>}
 */
export async function loadRobotsForSite({
  robots,
  fetcher,
  siteId,
  config,
  runId,
  signal,
  maxAgeMs = ROBOTS_MAX_AGE_MS,
  now = () => new Date(),
}) {
  const current = now();
  const cached = await robots.findOne(
    { siteId, fetchedAt: { $gte: new Date(current.getTime() - maxAgeMs) } },
    { sort: { fetchedAt: -1 } },
  );

  if (cached) {
    return {
      rules: applyOverride(createRobotsRules({ status: cached.status, text: cached.text ?? "" }, CRAWLER_PRODUCT_TOKEN), config),
      status: cached.status,
      fromCache: true,
    };
  }

  const robotsUrl = new URL("/robots.txt", config.seedUrl).href;
  let response;
  try {
    response = await fetcher.fetch(robotsUrl, { signal });
  } catch (error) {
    // A host inside a hold was never asked, so nothing is known about its permissions. Caching
    // "unknown" for the run would turn a request to slow down into a ban the site never issued.
    if (error.code === "RATE_LIMITED") throw error;
    // A transport failure is indistinguishable from a 5xx for permission purposes: the file may
    // exist and forbid us, and we cannot know which.
    response = { status: null, body: "", code: error.code };
  }

  const text = typeof response.body === "string" ? response.body.slice(0, MAX_ROBOTS_BYTES) : "";
  const parsed = createRobotsRules({ status: response.status, text }, CRAWLER_PRODUCT_TOKEN);

  await robots.insertOne({
    siteId,
    runId: runId ?? null,
    status: response.status,
    // The raw text is stored so a later job rebuilds the same rules, and so a change in what a
    // site permits is auditable rather than inferred from a summary.
    text,
    source: parsed.source,
    matchedAgent: parsed.matchedAgent,
    crawlDelay: parsed.crawlDelay,
    sitemaps: parsed.sitemaps,
    respected: config.respectRobots,
    fetchedAt: current,
  });

  return { rules: applyOverride(parsed, config), status: response.status, fromCache: false };
}

/**
 * Applies an acknowledged robots override.
 *
 * The file is still fetched, parsed, and stored when a site owner has chosen to ignore it — the
 * crawl simply does not obey the result. What a site asked for is worth recording even on
 * property whose owner has decided not to follow it.
 */
function applyOverride(rules, config) {
  if (config.respectRobots) return rules;
  return { ...rules, allows: () => true };
}
