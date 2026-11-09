import { escapeRegExp } from "@orbik/core";

import { AgentError } from "../runtime/errors.js";
import { normalizeUrl } from "./url.js";

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
 * @param {object} config validated crawl scope
 * @param {string} config.seedUrl absolute URL the crawl starts from
 * @param {string[]} [config.includePatterns] when present, a URL must match one to be in scope
 * @param {string[]} [config.excludePatterns] a URL matching any of these is out of scope
 * @param {number} [config.maxDepth=10] link hops from the seed, 0 through 50
 * @returns {{seed: object, allows: (url: object, depth: number) => {allowed: boolean, reason?: string}}}
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

  return {
    seed,

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
