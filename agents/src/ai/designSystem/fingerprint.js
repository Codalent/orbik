import { createHash } from "node:crypto";

import * as cheerio from "cheerio";

import { crawlerUserAgent } from "../../crawler/siteConfig.js";

/**
 * Bumped when what the agent extracts, or how, changes enough that a system derived by the
 * release before should be derived again even though the site did not move.
 */
export const EXTRACTOR_VERSION = 1;

/** How long one plain request may take. */
const TIMEOUT_MS = 15_000;

/** The largest document or stylesheet read, in bytes. A stylesheet beyond this is hashed as far as it was read. */
const MAX_BYTES = 3 * 1024 * 1024;

/** How many stylesheets of the home page are read. */
const MAX_STYLESHEETS = 12;

/**
 * Works out a fingerprint of how a site is styled, without opening a browser.
 *
 * A design system changes when a site is redesigned, which is a few times a year; the agent is
 * scheduled weekly. Rendering eight pages and asking a model two questions every week to learn
 * that nothing moved would be the cost of the agent fifty times over, and would also re-word a
 * proposal a person has already read. So a run begins here: two or three plain requests, a hash,
 * and — when the hash is the one the system was derived at — nothing else.
 *
 * What is hashed is chosen so that **content can change and the fingerprint does not**:
 *
 * - the *contents* of the home page's same-origin stylesheets, never their addresses — a build
 *   renames `app.3f9c.css` on every deploy without changing a rule in it;
 * - the home page's inline `<style>` blocks;
 * - the home page's skeleton: its tags and class names in order, with every word of text and
 *   every attribute but `class` left out. A new headline leaves it alone; a new section, or a
 *   different component in an old one, does not.
 *
 * With it go the things that are not the site's but still decide what a derivation produces: which
 * pages it renders, and the version of the extractor.
 *
 * @param {object} options
 * @param {string} options.homeUrl the site's home page
 * @param {string[]} options.pageUrls the pages the derivation would render
 * @param {(url: string) => Promise<void>} options.assertPublicAddress refuses a non-public address
 * @param {AbortSignal} [options.signal] cancellation
 * @param {typeof fetch} [options.fetchImpl] the request function
 * @returns {Promise<{fingerprint: string|null, reason: string|null, stylesheets: number}>} a null
 *   fingerprint means the home page could not be read, and the run should render rather than skip
 */
export async function styleFingerprint({ homeUrl, pageUrls, assertPublicAddress, signal, fetchImpl = fetch }) {
  const home = await read(homeUrl, { assertPublicAddress, signal, fetchImpl, accept: "text/html" });
  if (!home.ok) return { fingerprint: null, reason: home.reason, stylesheets: 0 };

  const $ = cheerio.load(home.text);
  const origin = new URL(home.url).origin;
  const hrefs = [];
  $('link[rel~="stylesheet"][href]').each((_index, element) => {
    try {
      const href = new URL($(element).attr("href"), home.url);
      if (href.origin === origin && !hrefs.includes(href.href)) hrefs.push(href.href);
    } catch {
      // An address that is not one names no stylesheet.
    }
  });

  const sheets = [];
  for (const href of hrefs.slice(0, MAX_STYLESHEETS)) {
    const sheet = await read(href, { assertPublicAddress, signal, fetchImpl, accept: "text/css" });
    // A stylesheet that could not be read is recorded as that, so the fingerprint changes when it
    // comes back rather than matching a derivation that never saw it.
    sheets.push(sheet.ok ? digest(sheet.text) : `unreadable:${sheet.reason}`);
  }
  // Sorted, because the order two stylesheets are linked in can change with a build and their
  // contents are what matters here.
  sheets.sort();

  const inline = [];
  $("style").each((_index, element) => { inline.push(digest($(element).text())); });

  const skeleton = [];
  $("body *").each((_index, element) => {
    if (["script", "style", "noscript", "template"].includes(element.tagName)) return;
    const classes = String($(element).attr("class") ?? "").split(/\s+/).filter(Boolean).sort().join(".");
    skeleton.push(classes ? `${element.tagName}.${classes}` : element.tagName);
  });

  const fingerprint = digest(JSON.stringify({
    extractor: EXTRACTOR_VERSION,
    pages: [...pageUrls].sort(),
    sheets,
    inline: inline.sort(),
    skeleton: digest(skeleton.join(">")),
  }));
  return { fingerprint, reason: null, stylesheets: sheets.length };
}

/** A short stable hash of some text. */
function digest(text) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 32);
}

/**
 * Reads one address as text, following a few redirects and checking each hop is public.
 *
 * @returns {Promise<{ok: true, text: string, url: string} | {ok: false, reason: string}>}
 */
async function read(url, { assertPublicAddress, signal, fetchImpl, accept }) {
  let target = url;
  try {
    for (let hop = 0; hop < 5; hop += 1) {
      await assertPublicAddress(target);
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const response = await fetchImpl(target, {
        redirect: "manual",
        // The crawler's own name: this is the same kind of plain read the crawler makes.
        headers: { Accept: accept, "User-Agent": crawlerUserAgent() },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        target = new URL(location, target).href;
        continue;
      }
      if (!response.ok) return { ok: false, reason: `HTTP_${response.status}` };
      const bytes = Buffer.from(await response.arrayBuffer());
      return { ok: true, text: bytes.subarray(0, MAX_BYTES).toString("utf8"), url: target };
    }
    return { ok: false, reason: "TOO_MANY_REDIRECTS" };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, reason: error?.code ?? "FETCH_FAILED" };
  }
}
