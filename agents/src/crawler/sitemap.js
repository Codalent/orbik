import { gunzipSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";

import { tryNormalizeUrl } from "./url.js";

/** Per-file entry ceiling from the sitemaps protocol. */
const MAX_SITEMAP_ENTRIES = 50_000;

/** Bounds on how far a sitemap index may be followed. */
const SITEMAP_LIMITS = Object.freeze({
  maxSitemaps: 50,
  maxDepth: 3,
  maxUrls: 100_000,
});

const parser = new XMLParser({
  ignoreAttributes: true,
  // Namespace prefixes vary between sitemaps (`sitemap:urlset`, `urlset`), and matching on the
  // local name keeps one parser working across both instead of guessing the prefix.
  removeNSPrefix: true,
  trimValues: true,
  // Without this, a single-entry sitemap yields an object where a multi-entry one yields an
  // array, and every consumer needs the same defensive branch.
  isArray: (name) => name === "url" || name === "sitemap",
});

/**
 * Parses one sitemap document into either child sitemaps or URL entries.
 *
 * Sitemaps are the most reliable discovery source a site offers: they list pages the owner wants
 * crawled, including pages that nothing links to and a link crawl would therefore never reach.
 *
 * Malformed XML yields an empty result rather than an exception. A broken sitemap is a finding to
 * record, not a reason to abandon a crawl that can still proceed by following links.
 *
 * @param {string} xml sitemap document
 * @returns {{type: "index"|"urlset"|"unknown", sitemaps: string[], entries: Array<{loc: string, lastmod: string|null, changefreq: string|null, priority: number|null}>}}
 */
function parseSitemap(xml) {
  let document;
  try {
    document = parser.parse(String(xml ?? ""));
  } catch {
    return { type: "unknown", sitemaps: [], entries: [] };
  }

  if (document?.sitemapindex) {
    const children = toArray(document.sitemapindex.sitemap)
      .map((entry) => textOf(entry?.loc))
      .filter(Boolean)
      .slice(0, SITEMAP_LIMITS.maxSitemaps);
    return { type: "index", sitemaps: children, entries: [] };
  }

  if (document?.urlset) {
    const entries = toArray(document.urlset.url)
      .slice(0, MAX_SITEMAP_ENTRIES)
      .map((entry) => ({
        loc: textOf(entry?.loc),
        lastmod: textOf(entry?.lastmod) || null,
        changefreq: textOf(entry?.changefreq) || null,
        priority: toPriority(entry?.priority),
      }))
      .filter((entry) => entry.loc);
    return { type: "urlset", sitemaps: [], entries };
  }

  return { type: "unknown", sitemaps: [], entries: [] };
}

/**
 * Decompresses a sitemap body when it was served gzipped.
 *
 * `.xml.gz` sitemaps are sent as `application/gzip` with no `Content-Encoding`, so the HTTP layer
 * does not decompress them and the decoded text is binary garbage. Detection uses the gzip magic
 * bytes rather than the URL suffix or content type, both of which servers get wrong routinely.
 *
 * @param {Buffer|null} buffer raw response bytes
 * @param {string} fallbackText already-decoded text, used when the body is not gzipped
 * @returns {string} sitemap XML
 */
function decodeSitemapBody(buffer, fallbackText) {
  if (!buffer || buffer.length < 2 || buffer[0] !== 0x1f || buffer[1] !== 0x8b) return fallbackText ?? "";
  try {
    return gunzipSync(buffer).toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Walks a site's sitemaps breadth-first and returns every URL they declare.
 *
 * Every traversal bound exists because sitemaps are attacker- and accident-controlled input: an
 * index that references itself, or a chain thousands deep, would otherwise run until the job's
 * lease expired. Reaching a bound truncates the walk and is reported, never thrown — a partial
 * URL list is far more useful than no crawl at all.
 *
 * @param {object} options traversal inputs
 * @param {{fetch: Function}} options.fetcher HTTP client
 * @param {string[]} options.seeds sitemap URLs to start from, typically from robots.txt
 * @param {AbortSignal} [options.signal] cancellation
 * @param {object} [options.limits] overrides for {@link SITEMAP_LIMITS}
 * @returns {Promise<{entries: Array<object>, fetched: string[], errors: Array<{url: string, code: string}>, truncated: boolean}>}
 */
export async function collectSitemapUrls({ fetcher, seeds, signal, limits = {} }) {
  const bounds = { ...SITEMAP_LIMITS, ...limits };
  const queue = seeds.map((url) => ({ url, depth: 0 }));
  const seen = new Set(seeds);
  const byLocation = new Map();
  const fetched = [];
  const errors = [];
  let truncated = false;

  while (queue.length) {
    if (fetched.length >= bounds.maxSitemaps || byLocation.size >= bounds.maxUrls) {
      truncated = true;
      break;
    }

    const { url, depth } = queue.shift();
    let response;
    try {
      response = await fetcher.fetch(url, { signal });
    } catch (error) {
      // A hold means the walk was interrupted, not that the sitemap is broken; the discover job
      // is retried later and walks again from the start.
      if (error.code === "RATE_LIMITED") throw error;
      errors.push({ url, code: error.code ?? "FETCH_FAILED" });
      continue;
    }
    fetched.push(url);
    if (response.status !== 200) {
      errors.push({ url, code: `HTTP_${response.status}` });
      continue;
    }

    const parsed = parseSitemap(decodeSitemapBody(response.buffer, response.body));
    if (parsed.type === "unknown") {
      errors.push({ url, code: "UNPARSEABLE_SITEMAP" });
      continue;
    }

    if (parsed.type === "index") {
      if (depth >= bounds.maxDepth) {
        truncated = true;
        continue;
      }
      for (const child of parsed.sitemaps) {
        // Resolve against the sitemap that declared it, so a relative reference cannot be
        // mistaken for a URL on a different host.
        const normalized = tryNormalizeUrl(child, { base: url });
        if (!normalized || seen.has(normalized.href)) continue;
        seen.add(normalized.href);
        queue.push({ url: normalized.href, depth: depth + 1 });
      }
      continue;
    }

    for (const entry of parsed.entries) {
      if (byLocation.size >= bounds.maxUrls) {
        truncated = true;
        break;
      }
      const normalized = tryNormalizeUrl(entry.loc, { base: url });
      if (!normalized) continue;
      // The same URL can appear in several sitemaps. Keeping the first occurrence makes the
      // result deterministic regardless of the order files came back in.
      if (byLocation.has(normalized.hash)) continue;
      byLocation.set(normalized.hash, {
        url: normalized.href,
        hash: normalized.hash,
        lastmod: entry.lastmod,
        changefreq: entry.changefreq,
        priority: entry.priority,
        sitemap: url,
      });
    }
  }

  return { entries: [...byLocation.values()], fetched, errors, truncated };
}

/** Reads a possibly-absent, possibly-single XML child as an array. */
function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Extracts trimmed text from an XML value that may be a number, string, or object. */
function textOf(value) {
  if (value === undefined || value === null || typeof value === "object") return "";
  return String(value).trim();
}

/** Parses the optional priority hint, discarding values outside the protocol's range. */
function toPriority(value) {
  const priority = Number(textOf(value));
  return Number.isFinite(priority) && priority >= 0 && priority <= 1 ? priority : null;
}
