import { isCanonicalObjectId, parseBounded, plainObject, validationError } from "./shared.js";
import { canonicalizePublicUrl } from "./workspaceValidators.js";

/** Bounds mirrored from the crawler's own configuration validator. */
const BOUNDS = Object.freeze({
  crawlIntervalHours: { min: 1, max: 8760 },
  maxDepth: { min: 0, max: 50 },
});

/** Page listing bounds, kept small enough that one response stays renderable. */
const PAGE_LIMIT = Object.freeze({ min: 1, max: 200, fallback: 50 });

/**
 * How many sitemaps one site may be told about by hand.
 *
 * Sitemaps declared in robots.txt are uncapped, because there the site is describing itself. This
 * bound is on operator input, and each entry becomes an outbound request the crawler makes before
 * it has fetched a single page.
 */
const MAX_SITEMAP_URLS = 20;

/**
 * Validates a crawl configuration body.
 *
 * The bounds here repeat the crawler's own, on purpose. The API must reject a value at its edge
 * with a field-level message a form can display, rather than accepting it and leaving a worker to
 * fail hours later on a job nobody is watching. The crawler still validates independently, because
 * a stored document is not proof that anything checked it.
 */
export function validateCrawlSite(req, _res, next) {
  const fields = [];
  const body = plainObject(req.body);
  const allowed = new Set(["seedUrl", "enabled", "crawlIntervalHours", "maxDepth", "sitemapUrls", "crawlScheduleOverrides"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
    }
  }

  // An absent seed URL is valid: the workspace's own website is used instead.
  let seedUrl;
  if (body.seedUrl !== undefined) {
    try {
      seedUrl = canonicalizePublicUrl(body.seedUrl);
    } catch (error) {
      fields.push({ field: "seedUrl", code: "INVALID", message: error.message });
    }
  }

  const settings = {};
  for (const [field, bound] of Object.entries(BOUNDS)) {
    if (body[field] === undefined) continue;
    const value = body[field];
    if (!Number.isInteger(value) || value < bound.min || value > bound.max) {
      fields.push({
        field,
        code: "RANGE",
        message: `Enter a whole number from ${bound.min} to ${bound.max}.`,
      });
      continue;
    }
    settings[field] = value;
  }

  // An interval of null is a decision too: it means never, and a person choosing it for a pattern
  // is saying "leave these pages alone until I ask".
  if (body.crawlScheduleOverrides !== undefined) {
    const rows = body.crawlScheduleOverrides;
    if (!Array.isArray(rows) || rows.length > 100 || rows.some((row) =>
      !row || !isPattern(row.pattern) || !isIntervalOrNever(row.intervalHours))
      || new Set(rows.map((row) => row.pattern)).size !== rows.length) {
      fields.push({ field: "crawlScheduleOverrides", code: "INVALID", message: "Provide up to 100 unique patterns, each with an interval from 1 to 8760 hours or null for never." });
    } else settings.crawlScheduleOverrides = rows.map(({ pattern, intervalHours }) => ({ pattern, intervalHours }));
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      fields.push({ field: "enabled", code: "INVALID", message: "Enabled must be true or false." });
    } else {
      settings.enabled = body.enabled;
    }
  }


  // Sitemaps are canonicalized through the same rule the seed URL uses, so a sitemap entry can
  // never name a target the seed itself would have been refused for. Whether they belong to the
  // site being crawled is settled by the service, which is the only layer that knows the effective
  // seed once an absent one has fallen back to the workspace's own website.
  if (body.sitemapUrls !== undefined) {
    if (!Array.isArray(body.sitemapUrls)) {
      fields.push({ field: "sitemapUrls", code: "INVALID", message: "Sitemap URLs must be a list." });
    } else if (body.sitemapUrls.length > MAX_SITEMAP_URLS) {
      fields.push({ field: "sitemapUrls", code: "RANGE", message: `Enter at most ${MAX_SITEMAP_URLS} sitemap URLs.` });
    } else {
      const canonical = [];
      for (const entry of body.sitemapUrls) {
        try {
          canonical.push(canonicalizePublicUrl(entry));
        } catch (error) {
          fields.push({ field: "sitemapUrls", code: "INVALID", message: error.message });
        }
      }
      settings.sitemapUrls = [...new Set(canonical)];
    }
  }

  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, seedUrl, settings };
  next();
}

/** A route pattern as the crawler writes it: a path, possibly with `[param]` segments. */
function isPattern(value) {
  return typeof value === "string" && value.startsWith("/") && value.length <= 2048;
}

/** A crawl interval within the crawler's bounds, or null meaning never. */
function isIntervalOrNever(value) {
  return value === null || (Number.isInteger(value) && value >= BOUNDS.crawlIntervalHours.min && value <= BOUNDS.crawlIntervalHours.max);
}

/**
 * Validates a change to one page's own crawl frequency.
 *
 * The body says one of three things: follow the pattern again (`override: null`), crawl this page
 * at its own interval, or never crawl it again on a timer (`override: { intervalHours: null }`).
 * The shape mirrors what is stored on the registry row so that reading it back needs no mapping.
 */
export function validatePageSchedule(req, _res, next) {
  const body = plainObject(req.body);
  const fields = [];
  for (const key of Object.keys(body)) {
    if (key !== "override") fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
  }
  const { override } = body;
  const valid = override === null
    || (override && typeof override === "object" && !Array.isArray(override)
      && Object.keys(override).every((key) => key === "intervalHours") && isIntervalOrNever(override.intervalHours));
  if (!valid) {
    fields.push({ field: "override", code: "INVALID", message: "Send null to follow the pattern, or { intervalHours } from 1 to 8760 or null for never." });
  }
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, override: override === null ? null : { intervalHours: override.intervalHours } };
  next();
}

/**
 * Validates a request to crawl: an empty body for the due pages, or `{ fresh: true }` for all of
 * them. Anything else is rejected rather than ignored, as everywhere.
 */
export function validateCrawlRequest(req, _res, next) {
  const body = plainObject(req.body);
  const fields = [];
  for (const key of Object.keys(body)) {
    if (key !== "fresh") fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
  }
  if (body.fresh !== undefined && typeof body.fresh !== "boolean") {
    fields.push({ field: "fresh", code: "INVALID", message: "Send true for a fresh crawl of every page, or leave it out." });
  }
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, fresh: body.fresh === true };
  next();
}

/** Validates the Markdown library's paging: an optional limit and offset, nothing else. */
export function validateMarkdownQuery(req, _res, next) {
  const fields = [];
  for (const key of Object.keys(req.query ?? {})) {
    if (!["limit", "skip"].includes(key)) fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This filter is not accepted." });
  }
  const parse = (raw, fallback, max, name) => {
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < (name === "skip" ? 0 : 1) || value > max) {
      fields.push({ field: name, code: "RANGE", message: `Enter a whole number up to ${max}.` });
      return fallback;
    }
    return value;
  };
  const limit = parse(req.query?.limit, 200, 500, "limit");
  const skip = parse(req.query?.skip, 0, 1_000_000, "skip");
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, limit, skip };
  next();
}

/** How many pages and folders one frequency change may name at once. */
const FREQUENCY_TARGETS = Object.freeze({ urlHashes: 1000, paths: 200 });

/**
 * Validates a bulk frequency change: a selection of pages and folders, and one interval.
 *
 * At least one target is required. A body naming none would mean "every page", which is a
 * decision big enough to deserve the deliberate act of selecting the root folder.
 */
export function validateFrequencies(req, _res, next) {
  const body = plainObject(req.body);
  const fields = [];
  for (const key of Object.keys(body)) {
    if (!["targets", "intervalHours"].includes(key)) fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
  }
  const targets = body.targets && typeof body.targets === "object" && !Array.isArray(body.targets) ? body.targets : null;
  const urlHashes = targets?.urlHashes ?? [];
  const paths = targets?.paths ?? [];
  const targetKeysOk = targets && Object.keys(targets).every((key) => ["urlHashes", "paths"].includes(key));
  const hashesOk = Array.isArray(urlHashes) && urlHashes.length <= FREQUENCY_TARGETS.urlHashes
    && urlHashes.every((value) => typeof value === "string" && /^[0-9a-f]{64}$/i.test(value));
  const pathsOk = Array.isArray(paths) && paths.length <= FREQUENCY_TARGETS.paths
    && paths.every((value) => typeof value === "string" && value.startsWith("/") && value.length <= 2048 && !value.includes("\0"));
  if (!targetKeysOk || !hashesOk || !pathsOk) {
    fields.push({ field: "targets", code: "INVALID", message: `Provide { urlHashes, paths }: up to ${FREQUENCY_TARGETS.urlHashes} page hashes and ${FREQUENCY_TARGETS.paths} folder paths beginning with /.` });
  } else if (urlHashes.length === 0 && paths.length === 0) {
    fields.push({ field: "targets", code: "REQUIRED", message: "Select at least one page or folder." });
  }
  if (!isIntervalOrNever(body.intervalHours)) {
    fields.push({ field: "intervalHours", code: "INVALID", message: "Provide an interval from 1 to 8760 hours, or null for manual trigger." });
  }
  if (fields.length) return next(validationError(fields));
  req.validated = {
    ...req.validated,
    targets: { urlHashes: urlHashes.map((value) => value.toLowerCase()), paths: paths.map(normalizePath) },
    intervalHours: body.intervalHours,
  };
  next();
}

/** Collapses repeated and trailing slashes so "/blog/" and "/blog" name one folder. */
function normalizePath(value) {
  const segments = value.split("/").filter(Boolean);
  return `/${segments.join("/")}`;
}

/**
 * Validates a request to crawl one page, or every page of one route pattern, by hand.
 *
 * Exactly one target is accepted. A body naming both would have to choose which one it meant,
 * and a body naming neither would mean "the whole site", which is what the runs endpoint is for.
 */
export function validateRecrawl(req, _res, next) {
  const body = plainObject(req.body);
  const fields = [];
  for (const key of Object.keys(body)) {
    if (key !== "urlHash" && key !== "pattern") fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
  }
  const hasHash = body.urlHash !== undefined;
  const hasPattern = body.pattern !== undefined;
  if (hasHash === hasPattern) {
    fields.push({ field: hasHash ? "pattern" : "urlHash", code: "INVALID", message: "Name either one page by urlHash or one route pattern, not both." });
  } else if (hasHash && !(typeof body.urlHash === "string" && /^[0-9a-f]{64}$/.test(body.urlHash))) {
    fields.push({ field: "urlHash", code: "FORMAT", message: "Page identifier is invalid." });
  } else if (hasPattern && !isPattern(body.pattern)) {
    fields.push({ field: "pattern", code: "INVALID", message: "Route pattern is invalid." });
  }
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, target: hasHash ? { urlHash: body.urlHash } : { pattern: body.pattern } };
  next();
}

/** Longest URL path the route tree will expand, matching the crawler's own segment ceiling. */
const MAX_TREE_PATH_LENGTH = 2048;

/** Bounds on one page of tree children, kept small enough that a branch renders at once. */
const TREE_LIMIT = Object.freeze({ min: 1, max: 200, fallback: 20 });

/**
 * Validates a route tree request.
 *
 * The path is user input that becomes part of a database query, so it is bounded and stripped of
 * traversal segments here rather than trusted because it looks like a path. `.` and `..` carry no
 * meaning in a route tree and their only use would be to address something the caller should not.
 */
export function validateTreeQuery(req, _res, next) {
  const fields = [];
  const query = req.query ?? {};
  const allowed = new Set(["path", "limit", "skip"]);
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) {
      fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This filter is not accepted." });
    }
  }

  let path = "/";
  if (query.path !== undefined) {
    const raw = String(query.path);
    if (raw.length > MAX_TREE_PATH_LENGTH) {
      fields.push({ field: "path", code: "RANGE", message: "That path is too long." });
    } else if (raw.split("/").some((segment) => segment === "." || segment === "..")) {
      fields.push({ field: "path", code: "INVALID", message: "That path is not valid." });
    } else {
      path = raw;
    }
  }

  const limit = parseBounded(query.limit, TREE_LIMIT, "limit", fields, { blankIsZero: true });
  const skip = query.skip === undefined ? 0 : parseBounded(query.skip, { min: 0, max: 100_000, fallback: 0 }, "skip", fields, { blankIsZero: true });

  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, path, limit, skip };
  next();
}

/** Validates a crawl activity request. */
export function validateActivityQuery(req, _res, next) {
  const fields = [];
  const query = req.query ?? {};
  const allowed = new Set(["before", "limit"]);
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) {
      fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This filter is not accepted." });
    }
  }

  let before;
  if (query.before !== undefined) {
    const parsed = new Date(String(query.before));
    if (Number.isNaN(parsed.getTime())) {
      fields.push({ field: "before", code: "INVALID", message: "Enter a valid timestamp." });
    } else {
      before = parsed.toISOString();
    }
  }

  const limit = parseBounded(query.limit, { min: 1, max: 100, fallback: 25 }, "limit", fields, { blankIsZero: true });

  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, before, limit };
  next();
}

/** Validates the URL hash addressing one page's detail. */
export function validateUrlHash(req, _res, next) {
  const { urlHash } = req.params;
  if (typeof urlHash !== "string" || !/^[0-9a-f]{64}$/.test(urlHash)) {
    return next(validationError([{ field: "urlHash", code: "FORMAT", message: "Page identifier is invalid." }]));
  }
  req.validated = { ...req.validated, urlHash };
  next();
}

/** Validates the optional filters and paging of a page listing. */
export function validatePageQuery(req, _res, next) {
  const fields = [];
  const query = req.query ?? {};
  const allowed = new Set(["runId", "indexable", "status", "limit", "page"]);
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) {
      fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This filter is not accepted." });
    }
  }

  let runId;
  if (query.runId !== undefined) {
    if (!isCanonicalObjectId(query.runId)) {
      fields.push({ field: "runId", code: "FORMAT", message: "Run identifier is invalid." });
    } else {
      runId = String(query.runId).toLowerCase();
    }
  }

  let indexable;
  if (query.indexable !== undefined) {
    if (query.indexable !== "true" && query.indexable !== "false") {
      fields.push({ field: "indexable", code: "INVALID", message: "Indexable must be true or false." });
    } else {
      indexable = query.indexable === "true";
    }
  }

  let status;
  if (query.status !== undefined) {
    const parsed = Number(query.status);
    if (!Number.isInteger(parsed) || parsed < 100 || parsed > 599) {
      fields.push({ field: "status", code: "RANGE", message: "Status must be an HTTP status code." });
    } else {
      status = parsed;
    }
  }

  const limit = parseBounded(query.limit, PAGE_LIMIT, "limit", fields);
  const page = parseBounded(query.page, { min: 1, max: 10_000, fallback: 1 }, "page", fields);

  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, runId, indexable, status, limit, page };
  next();
}

/** Validates the optional listing size of a run listing. */
export function validateRunQuery(req, _res, next) {
  const fields = [];
  for (const key of Object.keys(req.query ?? {})) {
    if (key !== "limit") fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This filter is not accepted." });
  }
  const limit = parseBounded(req.query?.limit, { min: 1, max: 50, fallback: 10 }, "limit", fields);
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, limit };
  next();
}

/** A route pattern as the crawler writes it: a path, possibly with `[param]` segments. */
const ROUTE_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%[\]/-]{0,300}$/;

/** Validates the optional size of a route listing. */
export function validateRouteQuery(req, _res, next) {
  const fields = [];
  const query = req.query ?? {};
  for (const key of Object.keys(query)) {
    if (key !== "limit") fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This filter is not accepted." });
  }
  const limit = parseBounded(query.limit, { min: 1, max: 500, fallback: 200 }, "limit", fields);
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, limit };
  next();
}

/** Validates a request for the pages of one route pattern. */
export function validateRoutePagesQuery(req, _res, next) {
  const fields = [];
  const query = req.query ?? {};
  for (const key of Object.keys(query)) {
    if (!["pattern", "search", "limit"].includes(key)) fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This filter is not accepted." });
  }
  const pattern = typeof query.pattern === "string" ? query.pattern : "";
  if (!pattern || !ROUTE_PATTERN.test(pattern)) {
    fields.push({ field: "pattern", code: "INVALID", message: "Name the route pattern, such as /blog/[slug]." });
  }
  let search = "";
  if (query.search !== undefined) {
    if (typeof query.search !== "string" || query.search.length > 100) {
      fields.push({ field: "search", code: "INVALID", message: "Search is at most 100 characters." });
    } else {
      search = query.search.trim();
    }
  }
  const limit = parseBounded(query.limit, { min: 1, max: 200, fallback: 50 }, "limit", fields);
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, pattern, search, limit };
  next();
}
