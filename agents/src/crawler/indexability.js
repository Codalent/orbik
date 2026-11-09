import { tryNormalizeUrl } from "./url.js";

/**
 * Why a URL is or is not indexable.
 *
 * These codes are the stable vocabulary downstream agents and the UI join on, so they are
 * deliberately specific: "not indexable" is not actionable, while "the canonical tag points
 * somewhere else" tells an operator exactly what to change.
 */
const INDEXABILITY_REASONS = Object.freeze({
  ok: "INDEXABLE",
  notFound: "STATUS_NOT_FOUND",
  serverError: "STATUS_SERVER_ERROR",
  otherStatus: "STATUS_NOT_OK",
  redirected: "REDIRECTED",
  tooManyRedirects: "TOO_MANY_REDIRECTS",
  robotsDisallowed: "ROBOTS_DISALLOWED",
  metaNoindex: "META_NOINDEX",
  headerNoindex: "HEADER_NOINDEX",
  canonicalToOther: "CANONICAL_TO_OTHER",
  notHtml: "NOT_HTML",
});

/**
 * Decides whether one crawled URL is indexable, and records every reason it is not.
 *
 * **This verdict is computed once, here, and stored.** No downstream agent recomputes it. Tools
 * that re-derive indexability in several places end up contradicting themselves — the report says
 * a page is indexed while the audit says it is blocked — and the disagreement is invisible until
 * a client points it out.
 *
 * Every applicable reason is collected rather than stopping at the first. A page that is both
 * `noindex` and canonicalized elsewhere needs two fixes, and reporting only the first would send
 * an operator back for a second round after the first change failed to help.
 *
 * One judgement call worth naming: a URL disallowed by robots.txt is reported as **not
 * indexable**. Strictly, a search engine may index a disallowed URL it has never fetched, using
 * only external signals. But it cannot see the page's content, and for a dataset whose purpose is
 * "what does a crawler see", treating an uncrawlable URL as indexable would be misleading.
 *
 * @param {object} input everything observed about the fetched URL
 * @param {number} input.status final HTTP status
 * @param {string} input.url final URL after redirects, already normalized
 * @param {string} [input.requestedUrl] URL originally requested, when redirects occurred
 * @param {boolean} [input.robotsAllowed=true] whether robots.txt permits this URL
 * @param {string[]} [input.metaRobots] directives from the page's robots meta tags
 * @param {string[]} [input.xRobotsTag] directives from the `X-Robots-Tag` header
 * @param {string|null} [input.canonical] raw canonical href as written in the markup
 * @param {string} [input.contentType] response content type
 * @param {number} [input.redirectCount=0] redirect hops followed
 * @param {boolean} [input.redirectsUnresolved=false] the hops looped or ran past the limit
 * @returns {{indexable: boolean, reasons: string[], canonicalUrl: string|null, selfCanonical: boolean|null}}
 */
export function computeIndexability(input) {
  const reasons = [];
  const status = input.status;
  const redirectCount = input.redirectCount ?? 0;

  if (redirectCount > 0) reasons.push(INDEXABILITY_REASONS.redirected);
  if (input.redirectsUnresolved) reasons.push(INDEXABILITY_REASONS.tooManyRedirects);

  if (status === 404 || status === 410) {
    reasons.push(INDEXABILITY_REASONS.notFound);
  } else if (status >= 500) {
    reasons.push(INDEXABILITY_REASONS.serverError);
  } else if (status < 200 || status >= 300) {
    reasons.push(INDEXABILITY_REASONS.otherStatus);
  }

  if (input.robotsAllowed === false) reasons.push(INDEXABILITY_REASONS.robotsDisallowed);
  if (hasNoindex(input.metaRobots)) reasons.push(INDEXABILITY_REASONS.metaNoindex);
  if (hasNoindex(input.xRobotsTag)) reasons.push(INDEXABILITY_REASONS.headerNoindex);

  // Only HTML carries the signals a page-level audit is about. A PDF or an image is a legitimate
  // crawl result but is not a page, and scoring it against page rules produces noise.
  if (input.contentType !== undefined && status >= 200 && status < 300 && !isHtml(input.contentType)) {
    reasons.push(INDEXABILITY_REASONS.notHtml);
  }

  const canonical = resolveCanonical(input.canonical, input.url);
  const selfCanonical = canonical === null ? null : canonical === input.url;
  if (canonical !== null && !selfCanonical) reasons.push(INDEXABILITY_REASONS.canonicalToOther);

  return {
    indexable: reasons.length === 0,
    reasons: reasons.length ? reasons : [INDEXABILITY_REASONS.ok],
    canonicalUrl: canonical,
    selfCanonical,
  };
}

/**
 * Resolves a canonical href to the same normalized form URLs are keyed by.
 *
 * Comparing a raw canonical against a normalized URL is how a page that is correctly
 * self-canonical gets reported as canonicalized elsewhere: `/page/` and `https://EXAMPLE.com/page/`
 * are the same address written differently. Normalizing both sides is what makes the comparison
 * mean anything.
 *
 * @returns {string|null} the normalized canonical, or null when absent or unusable
 */
function resolveCanonical(canonical, pageUrl) {
  if (typeof canonical !== "string" || !canonical.trim()) return null;
  const normalized = tryNormalizeUrl(canonical, { base: pageUrl });
  return normalized ? normalized.href : null;
}

/** Reports whether a directive list forbids indexing. */
function hasNoindex(directives) {
  if (!Array.isArray(directives)) return false;
  return directives.some((directive) => directive === "noindex" || directive === "none");
}

/** Reports whether a content type describes an HTML document. */
function isHtml(contentType) {
  const value = String(contentType ?? "").toLowerCase();
  return value.includes("text/html") || value.includes("application/xhtml+xml");
}
