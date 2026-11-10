import { AgentError } from "../runtime/errors.js";
import { normalizeUrl } from "./url.js";

/**
 * Bounds on how one crawl behaves, sized for the sites this system targets.
 *
 * How *much* a crawl may cover is no longer among them: that is the account's monthly crawl
 * budget, which belongs to the account rather than to any one site, and is spent one page at a
 * time as fetches happen.
 */
const SITE_LIMITS = Object.freeze({
  minHostIntervalCeilingMs: 60_000,
});

/**
 * Defaults applied to any crawl setting the operator did not specify.
 *
 * `minHostIntervalMs` is the least time between two requests to one host: four a second. That is
 * the fastest a crawl goes, and the site can only slow it down — a robots.txt `Crawl-delay` widens
 * the interval, and a 429 or 503 stops requests to the host altogether for as long as it asks.
 */
const SITE_DEFAULTS = Object.freeze({
  maxDepth: 10,
  respectRobots: true,
  minHostIntervalMs: 250,
  crawlIntervalHours: 168,
  enabled: true,
  keepTrackingParams: false,
  sortQuery: false,
});

/**
 * Validates and canonicalizes one site's crawl configuration.
 *
 * Every field here is operator input that ends up governing outbound requests to somebody else's
 * server, so it is validated before a single request is made rather than trusted because it came
 * from the database. A configuration that was valid when it was written can still be invalid when
 * it is read: limits change, and a stored document is not proof of anything.
 *
 * @param {object} document stored site configuration
 * @returns {Readonly<object>} canonical crawl configuration
 * @throws {AgentError} `INVALID_SITE` listing every rejected field
 */
export function parseSiteConfig(document) {
  const errors = [];
  const source = document ?? {};

  let seedUrl = null;
  try {
    seedUrl = normalizeUrl(source.seedUrl).href;
  } catch {
    errors.push("seedUrl must be an absolute http(s) URL.");
  }

  const maxDepth = source.maxDepth ?? SITE_DEFAULTS.maxDepth;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 50) {
    errors.push("maxDepth must be an integer from 0 through 50.");
  }

  const minHostIntervalMs = source.minHostIntervalMs ?? SITE_DEFAULTS.minHostIntervalMs;
  if (
    !Number.isInteger(minHostIntervalMs) ||
    minHostIntervalMs < 0 ||
    minHostIntervalMs > SITE_LIMITS.minHostIntervalCeilingMs
  ) {
    errors.push(`minHostIntervalMs must be an integer from 0 through ${SITE_LIMITS.minHostIntervalCeilingMs}.`);
  }

  // One hour is the floor, and a year the ceiling: below an hour a crawl of any real site would
  // still be running when the next one is due, and above a year the schedule stops being one.
  const crawlIntervalHours = source.crawlIntervalHours ?? SITE_DEFAULTS.crawlIntervalHours;
  if (!Number.isInteger(crawlIntervalHours) || crawlIntervalHours < 1 || crawlIntervalHours > 8760) {
    errors.push("crawlIntervalHours must be an integer from 1 through 8760.");
  }

  const enabled = source.enabled ?? SITE_DEFAULTS.enabled;
  if (typeof enabled !== "boolean") {
    errors.push("enabled must be a boolean.");
  }

  const respectRobots = source.respectRobots ?? SITE_DEFAULTS.respectRobots;
  if (typeof respectRobots !== "boolean") {
    errors.push("respectRobots must be a boolean.");
  }

  // Ignoring robots.txt is only defensible on a site the operator owns. Gating it on a recorded
  // acknowledgement means the override cannot be switched on by a stray configuration edit, and
  // that who accepted responsibility is auditable afterwards.
  const acknowledgedAt = source.robotsOverrideAcknowledgedAt ?? null;
  if (respectRobots === false) {
    if (!(acknowledgedAt instanceof Date) || Number.isNaN(acknowledgedAt.getTime())) {
      errors.push("respectRobots may only be false when robotsOverrideAcknowledgedAt records site ownership.");
    }
    if (typeof source.robotsOverrideAcknowledgedBy !== "string" || !source.robotsOverrideAcknowledgedBy) {
      errors.push("respectRobots may only be false when robotsOverrideAcknowledgedBy identifies who accepted it.");
    }
  }

  for (const field of ["keepTrackingParams", "sortQuery"]) {
    const value = source[field] ?? SITE_DEFAULTS[field];
    if (typeof value !== "boolean") errors.push(`${field} must be a boolean.`);
  }

  // Sitemaps named by the operator, on top of whatever robots.txt declares. Each becomes an
  // outbound request before a single page is fetched, so the host is pinned to the seed's: a
  // sitemap elsewhere lists another site's pages, and a stored document is not proof that anything
  // checked where it points.
  const sitemapUrls = source.sitemapUrls ?? [];
  if (!Array.isArray(sitemapUrls) || sitemapUrls.length > 20) {
    errors.push("sitemapUrls must be an array of at most 20 URLs.");
  } else if (seedUrl) {
    const seedHost = new URL(seedUrl).hostname;
    for (const candidate of sitemapUrls) {
      let parsed = null;
      try { parsed = new URL(normalizeUrl(candidate).href); } catch { parsed = null; }
      if (!parsed) errors.push("sitemapUrls entries must be absolute http(s) URLs.");
      else if (parsed.hostname !== seedHost) errors.push(`sitemapUrls must all be on ${seedHost}.`);
    }
  }

  const stripParams = source.stripParams ?? [];
  if (!Array.isArray(stripParams) || stripParams.some((name) => typeof name !== "string" || !name)) {
    errors.push("stripParams must be an array of non-empty strings.");
  } else if (stripParams.length > 100) {
    errors.push("stripParams must contain at most 100 names.");
  }

  if (errors.length) {
    throw new AgentError({
      code: "INVALID_SITE",
      message: `Invalid site configuration: ${errors.join(" ")}`,
      retryable: false,
    });
  }

  return Object.freeze({
    seedUrl,
    sitemapUrls: Array.isArray(sitemapUrls) ? sitemapUrls.map((url) => normalizeUrl(url).href) : [],
    includePatterns: source.includePatterns ?? [],
    excludePatterns: source.excludePatterns ?? [],
    maxDepth,
    respectRobots,
    robotsOverrideAcknowledgedAt: acknowledgedAt,
    robotsOverrideAcknowledgedBy: source.robotsOverrideAcknowledgedBy ?? null,
    minHostIntervalMs,
    crawlIntervalHours,
    enabled,
    stripParams,
    keepTrackingParams: source.keepTrackingParams ?? SITE_DEFAULTS.keepTrackingParams,
    sortQuery: source.sortQuery ?? SITE_DEFAULTS.sortQuery,
  });
}

/** The name the crawler goes by, as a site's logs and firewall rules see it. */
export const CRAWLER_PRODUCT_NAME = "OrbikBot";

/**
 * The page the User-Agent names when the install's operator names none of their own
 * (`ORBIK_CRAWLER_CONTACT_URL`): what OrbikBot is and how to block it. It is docs/orbikbot.md as
 * the docs site publishes it. Release 0.1.0 named that file on GitHub instead, so the file keeps
 * its path for as long as those crawlers are about.
 */
export const DEFAULT_CRAWLER_CONTACT_URL = "https://orbik.io/docs/orbikbot";

/**
 * Builds the product token sent on every request for a site.
 *
 * The contact URL is not decoration: it is how a site owner who sees unexpected traffic finds out
 * who is crawling and asks them to stop, and it is what distinguishes a crawler acting in good
 * faith from one that hides. Each install is run by someone else, so an operator should point it
 * at a page of their own; the agents' config checks the value at start.
 *
 * @param {string} [contactUrl] page describing the crawler and how to contact its operator
 */
export function crawlerUserAgent(contactUrl = process.env.ORBIK_CRAWLER_CONTACT_URL?.trim() || DEFAULT_CRAWLER_CONTACT_URL) {
  return `Mozilla/5.0 (compatible; ${CRAWLER_PRODUCT_NAME}/1.0; +${contactUrl})`;
}

/** Product token matched against robots.txt `User-agent` groups. */
export const CRAWLER_PRODUCT_TOKEN = "orbikbot";
