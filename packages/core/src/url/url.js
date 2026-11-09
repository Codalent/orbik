import { createHash } from "node:crypto";

/**
 * The one canonical form of a URL, and the hash every crawl collection keys on.
 *
 * These rules lived inside the crawler (`agents/src/crawler/url.js`) until something other than
 * the crawler had to produce the same key: a page's address reported by another system (a search
 * engine's data, say) only joins to a crawled page when it is normalised by the very rules the
 * crawler applied to it. Two copies of the rules would be two answers to "is this the
 * same page", so there is one, here, and the crawler's module calls it.
 */

/**
 * Query parameters removed before a URL becomes a dedup key.
 *
 * These are analytics and click identifiers: they change the URL string without changing the
 * page. Leaving them in would report one page as dozens of distinct URLs, inflating every count
 * downstream and scattering a single page's link equity across phantom duplicates.
 */
const DEFAULT_TRACKING_PARAMS = Object.freeze([
  "gclid", "gclsrc", "dclid", "fbclid", "msclkid", "yclid", "twclid", "igshid", "ttclid",
  "mc_cid", "mc_eid", "_ga", "_gl", "vero_id", "vero_conv", "hsa_cam", "hsa_grp", "hsa_ad",
  "wickedid", "otc", "oly_anon_id", "oly_enc_id", "s_kwcid", "ef_id", "epik", "irclickid",
]);

/** Prefixes whose every parameter is a tracking identifier. */
const TRACKING_PREFIXES = Object.freeze(["utm_", "pk_", "piwik_", "matomo_"]);

const MAX_URL_LENGTH = 2048;

/** The code every refusal below carries, so a caller can tell it from a fault. */
export const INVALID_URL = "INVALID_URL";

/** Builds the refusal: an ordinary error carrying the stable code. */
function invalidUrl(message) {
  const error = new Error(message);
  error.code = INVALID_URL;
  return error;
}

/**
 * Converts a raw or relative URL into the single canonical form the whole system keys on.
 *
 * Every count, diff, and link-graph edge is joined on the hash of this output, so the rules below
 * are the difference between "this site has 4,000 pages" and "this site has 40,000 URLs". They
 * are deliberately conservative: a normalization that merges two URLs the server treats as
 * different silently loses a page, which is far harder to notice than an over-counted duplicate.
 *
 * Applied unconditionally:
 * - **Scheme and host lowercased**, internationalized hosts punycoded — both are case- and
 *   encoding-insensitive per RFC 3986, so a difference there is never a different page.
 * - **Fragment removed** — it is never sent to the server, so it cannot identify a distinct
 *   response.
 * - **Default port removed** (`:80` on http, `:443` on https) — the same endpoint.
 * - **Credentials removed** — `user:pass@host` must never be persisted or replayed, and they do
 *   not identify a page.
 * - **Empty query removed** — a bare trailing `?` is not a distinct resource.
 *
 * Deliberately *not* applied by default:
 * - **Query order is preserved.** Sorting would change the URL actually requested, and some
 *   servers are order-sensitive. Enable `sortQuery` only for a site known to be insensitive.
 * - **Trailing slashes are preserved.** `/a` and `/a/` are genuinely different resources on many
 *   servers; deciding they are the same is the canonical tag's job, not the normalizer's.
 *
 * @param {string} input absolute or relative URL, typically taken from page markup
 * @param {object} [options] normalization policy
 * @param {string} [options.base] absolute URL that relative input is resolved against
 * @param {string[]} [options.stripParams] extra parameter names to remove
 * @param {boolean} [options.keepTrackingParams=false] retain the default tracking parameters
 * @param {boolean} [options.sortQuery=false] sort query parameters alphabetically
 * @returns {{href: string, hash: string, protocol: string, host: string, hostname: string, pathname: string, search: string}}
 * @throws {Error} with `code` {@link INVALID_URL} when the input cannot be a crawlable page address
 */
export function normalizeUrl(input, options = {}) {
  if (typeof input !== "string" || !input.trim()) {
    throw invalidUrl("URL must be a non-empty string.");
  }

  const raw = input.trim();
  // The URL parser silently strips some control characters, which would turn markup damage into
  // a plausible-looking but wrong address rather than a rejection.
  if (hasControlOrSpace(raw)) {
    throw invalidUrl("URL contains control characters or whitespace.");
  }

  let parsed;
  try {
    parsed = options.base ? new URL(raw, options.base) : new URL(raw);
  } catch {
    throw invalidUrl("URL could not be parsed.");
  }

  // `mailto:`, `tel:`, `javascript:`, and `data:` appear constantly in real markup. They are not
  // pages, and treating them as such would poison the URL registry with unfetchable entries.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalidUrl(`Unsupported scheme ${parsed.protocol}`);
  }
  if (!parsed.hostname) {
    throw invalidUrl("URL has no host.");
  }

  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";

  const stripped = new Set([
    ...(options.keepTrackingParams ? [] : DEFAULT_TRACKING_PARAMS),
    ...(options.stripParams ?? []),
  ].map((name) => name.toLowerCase()));

  // The prefix families are part of the same tracking policy as the named list, so the opt-out
  // has to cover both; gating only the named list would make `keepTrackingParams` silently drop
  // every `utm_*` parameter it promised to keep.
  const prefixes = options.keepTrackingParams ? [] : TRACKING_PREFIXES;
  const parameters = [...parsed.searchParams.entries()].filter(([name]) => {
    const lowered = name.toLowerCase();
    return !stripped.has(lowered) && !prefixes.some((prefix) => lowered.startsWith(prefix));
  });
  if (options.sortQuery) parameters.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const search = new URLSearchParams(parameters).toString();
  parsed.search = search ? `?${search}` : "";

  const href = parsed.href;
  if (href.length > MAX_URL_LENGTH) {
    throw invalidUrl(`URL exceeds ${MAX_URL_LENGTH} characters.`);
  }

  return {
    href,
    hash: hashUrl(href),
    protocol: parsed.protocol,
    host: parsed.host,
    hostname: parsed.hostname,
    pathname: parsed.pathname,
    search: parsed.search,
  };
}

/**
 * Reports whether a string contains a control character or an interior space.
 *
 * Written as a scan rather than a regular expression because a character class over the control
 * range has to embed literal control characters, which are invisible in review — the kind of
 * thing that silently changes meaning when a file is edited.
 */
function hasControlOrSpace(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Hashes a normalized URL into the fixed-width key used for deduplication and indexing.
 *
 * A hash rather than the URL itself because URLs run to 2 KB while index entries should not, and
 * because a fixed-width key keeps the compound indexes on the URL registry and link graph small
 * enough to stay resident at the scale a 50,000-URL crawl produces.
 *
 * @param {string} normalizedHref output of {@link normalizeUrl}
 * @returns {string} 64-character lowercase hex SHA-256
 */
export function hashUrl(normalizedHref) {
  return createHash("sha256").update(normalizedHref).digest("hex");
}

/**
 * Attempts normalization, returning null instead of throwing.
 *
 * Page markup contains broken and non-page hrefs as a matter of course. A crawl that aborted on
 * the first `javascript:void(0)` would never finish a real site, so link extraction skips what it
 * cannot normalize rather than failing the page.
 *
 * @returns {ReturnType<typeof normalizeUrl> | null}
 */
export function tryNormalizeUrl(input, options = {}) {
  try {
    return normalizeUrl(input, options);
  } catch {
    return null;
  }
}
