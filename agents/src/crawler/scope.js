import { escapeRegExp, readOntoSiteHost } from "@orbik/core";

import { AgentError } from "../runtime/errors.js";
import { hashUrl, normalizeUrl } from "./url.js";

/** Reasons a URL was refused, stored so a skipped page can be explained rather than guessed at. */
const SCOPE_REASONS = Object.freeze({
  outOfScopeHost: "OUT_OF_SCOPE_HOST",
  excludedPath: "EXCLUDED_PATH",
  notIncluded: "NOT_INCLUDED",
  maxDepth: "MAX_DEPTH",
});

const MAX_PATTERNS = 100;
const MAX_PATTERN_LENGTH = 500;

/**
 * Builds the in-scope test every discovered URL passes through.
 *
 * Scope is enforced at discovery rather than at fetch time so that out-of-scope URLs never enter
 * the frontier at all. A crawler that filters late still pays to store, queue, and dedup the
 * entire outbound web that a single site links to.
 *
 * Patterns are wildcard globs, never caller-supplied regular expressions. Site configuration is
 * user input, and compiling it as a regex would hand an operator the ability to hang a worker on
 * a pathological pattern.
 *
 * A crawl covers exactly one hostname. A subdomain is a different site — different content,
 * different owner in many organisations, and a different set of findings — so it belongs to its
 * own workspace rather than being folded into this one's totals. That also keeps a crawl's page
 * count honest: `blog.example.com` cannot silently double the size of a crawl of `example.com`.
 *
 * One hostname, which may have two spellings. When the address a person typed redirects to its
 * `www.` twin (or the reverse), discovery moves the seed to the host that answers and records the
 * spelling it left (`./seedHost.js`). The scope is still the seed's hostname alone; an address
 * written with the other spelling is first read as the same address on the seed's host
 * ({@link createScope}'s `onSiteHost`), so it is one URL in the registry rather than two.
 *
 * @param {object} config validated crawl scope
 * @param {string} config.seedUrl absolute URL the crawl starts from
 * @param {string|null} [config.aliasHost] the other spelling of the seed's hostname, when it was
 *   seen redirecting to the seed's
 * @param {string|null} [config.aliasProtocol] the scheme that spelling was seen redirecting from
 * @param {string[]} [config.includePatterns] when present, a URL must match one to be in scope
 * @param {string[]} [config.excludePatterns] a URL matching any of these is out of scope
 * @param {number} [config.maxDepth=10] link hops from the seed, 0 through 50
 * @returns {{seed: object, onSiteHost: (url: object) => object, allows: (url: object, depth: number) => {allowed: boolean, reason?: string}}}
 * @throws {AgentError} `INVALID_SCOPE` listing every rejected field
 */
export function createScope(config) {
  const errors = [];

  let seed = null;
  try {
    seed = normalizeUrl(config.seedUrl);
  } catch {
    errors.push("seedUrl must be an absolute http(s) URL.");
  }

  const maxDepth = config.maxDepth ?? 10;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 50) {
    errors.push("maxDepth must be an integer from 0 through 50.");
  }

  const includePatterns = compilePatterns(config.includePatterns, "includePatterns", errors);
  const excludePatterns = compilePatterns(config.excludePatterns, "excludePatterns", errors);

  if (errors.length) {
    throw new AgentError({
      code: "INVALID_SCOPE",
      message: `Invalid crawl scope: ${errors.join(" ")}`,
      retryable: false,
    });
  }

  const alias = {
    seedUrl: seed?.href,
    aliasHost: typeof config.aliasHost === "string" && config.aliasHost ? config.aliasHost : null,
    aliasProtocol: config.aliasProtocol ?? null,
  };

  return {
    seed,

    /**
     * Reads an address written with the site's other spelling as the same address on its host.
     *
     * The hostname changes, and the scheme with it when the address has the scheme the old
     * spelling was seen redirecting from (`readOntoSiteHost` in `@orbik/core`). The port, path and
     * query stay as they were written, so the result is what following the host's redirect is
     * expected to arrive at, and anything else about it is still decided by the server when it is
     * fetched. Every other address comes back as it was given.
     *
     * Called wherever an address enters the registry or the link graph — a link on a page, a
     * sitemap entry — before {@link allows}. Without it a site whose pages or sitemap still name
     * the spelling that redirects would have each of those pages twice, once as a redirect, and
     * would pay for both.
     *
     * @param {ReturnType<typeof normalizeUrl>} url normalized URL
     * @returns {ReturnType<typeof normalizeUrl>} the same URL, or its twin on the seed's hostname
     */
    onSiteHost(url) {
      const href = readOntoSiteHost(url.href, alias);
      if (href === url.href) return url;
      // Rebuilt by hand rather than normalised again: nothing but the origin differs, and a
      // second pass would apply default rules where the site's own had already been applied.
      const moved = new URL(href);
      return {
        href: moved.href,
        hash: hashUrl(moved.href),
        protocol: moved.protocol,
        host: moved.host,
        hostname: moved.hostname,
        pathname: moved.pathname,
        search: moved.search,
      };
    },

    /**
     * Decides whether one normalized URL belongs to this crawl.
     *
     * Exclusions are evaluated before inclusions, so a narrow exclusion can carve a hole in a
     * broad inclusion — the order an operator expects when they add `/admin/*` to a site that
     * already includes `/*`.
     *
     * @param {ReturnType<typeof normalizeUrl>} url normalized URL
     * @param {number} [depth=0] link hops from the seed
     * @returns {{allowed: boolean, reason?: string}}
     */
    allows(url, depth = 0) {
      if (url.hostname !== seed.hostname) {
        return { allowed: false, reason: SCOPE_REASONS.outOfScopeHost };
      }
      if (Number.isInteger(depth) && depth > maxDepth) {
        return { allowed: false, reason: SCOPE_REASONS.maxDepth };
      }
      const target = `${url.pathname}${url.search}`;
      if (excludePatterns.some((pattern) => pattern.test(target))) {
        return { allowed: false, reason: SCOPE_REASONS.excludedPath };
      }
      if (includePatterns.length && !includePatterns.some((pattern) => pattern.test(target))) {
        return { allowed: false, reason: SCOPE_REASONS.notIncluded };
      }
      return { allowed: true };
    },
  };
}

/**
 * Compiles wildcard globs into anchored regular expressions.
 *
 * Every character except `*` is escaped, and `*` becomes `[^]*`. The result contains no nested
 * quantifiers, so matching is linear in the input length regardless of what an operator writes.
 *
 * @throws nothing — problems are appended to `errors` so the caller reports them together
 */
function compilePatterns(patterns, field, errors) {
  if (patterns === undefined || patterns === null) return [];
  if (!Array.isArray(patterns)) {
    errors.push(`${field} must be an array of patterns.`);
    return [];
  }
  if (patterns.length > MAX_PATTERNS) {
    errors.push(`${field} must contain at most ${MAX_PATTERNS} patterns.`);
    return [];
  }

  const compiled = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || !pattern || pattern.length > MAX_PATTERN_LENGTH) {
      errors.push(`${field} entries must be non-empty strings of at most ${MAX_PATTERN_LENGTH} characters.`);
      continue;
    }
    const source = pattern
      .split("*")
      .map((literal) => escapeRegExp(literal))
      .join("[^]*");
    compiled.push(new RegExp(`^${source}$`));
  }
  return compiled;
}
