import { INVALID_URL, hashUrl, normalizeUrl as normalizeToCanonical } from "@orbik/core";

import { AgentError } from "../runtime/errors.js";

/**
 * The crawler's view of the one URL normaliser.
 *
 * The rules themselves are `normalizeUrl` in `@orbik/core` (`packages/core/src/url/url.js`), not
 * the crawler's own: they lived here until something else had to key its rows by the same hash,
 * and one set of rules means such a row and a crawled page cannot disagree about whether they are
 * the same address. Read that module for what is normalised and what deliberately is not.
 *
 * What stays here is how the crawler wants a refusal reported: as an `AgentError` that is not
 * retryable, because a malformed URL is malformed on every attempt.
 */

/**
 * Converts a raw or relative URL into the single canonical form the whole system keys on.
 *
 * @param {string} input absolute or relative URL, typically taken from page markup
 * @param {object} [options] normalization policy; see `normalizeUrl` in `@orbik/core`
 * @returns {{href: string, hash: string, protocol: string, host: string, hostname: string, pathname: string, search: string}}
 * @throws {AgentError} `INVALID_URL` when the input cannot be a crawlable page address
 */
export function normalizeUrl(input, options = {}) {
  try {
    return normalizeToCanonical(input, options);
  } catch (error) {
    if (error?.code === INVALID_URL) throw new AgentError({ code: INVALID_URL, message: error.message });
    throw error;
  }
}

export { hashUrl };

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
