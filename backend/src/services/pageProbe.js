import { lookup } from "node:dns/promises";

import { classifyAddress, createRobotsRules, crawlerUserAgent } from "@orbik/core";

/** How long the check of one address may take, robots.txt included. */
const PROBE_TIMEOUT_MS = 8_000;

/** Redirects followed before the address is called unreachable. */
const MAX_REDIRECTS = 4;

/** The most of a page read to find its title: the `<head>` is near the top. */
const MAX_PAGE_BYTES = 256 * 1024;

/** The most of a robots.txt read. */
const MAX_ROBOTS_BYTES = 128 * 1024;

/** The product token robots.txt is read for, as the crawler reads it. */
const ROBOTS_AGENT = "orbikbot";

/**
 * Looks at one address a person is about to add as a source, the way the crawler would: as
 * OrbikBot, obeying robots.txt, refusing anything that is not on the public internet.
 *
 * One request for robots.txt and one for the page, made only because a person typed the address
 * and asked: what it learns — the page's title, whether it answers, whether robots.txt lets the
 * crawler in — is what the Add a source dialog shows before anything is saved. Nothing is stored.
 *
 * Addresses are checked as the crawler checks them (`assertPublicAddress` in its fetcher): every
 * address the name resolves to must be public by `classifyAddress`, at every redirect. The same
 * limitation applies — the name is resolved and then connected to separately — and the same
 * answer: this is a check on input, and the API should not be able to reach internal services.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {typeof lookup} [options.dnsLookup]
 * @param {string} [options.userAgent]
 */
export function createPageProbe({ fetchImpl = fetch, dnsLookup = lookup, userAgent = crawlerUserAgent() } = {}) {
  /** Refuses a host that resolves anywhere but the public internet. */
  async function assertPublic(hostname) {
    const name = hostname.replace(/^\[|\]$/g, "");
    let addresses;
    try {
      addresses = await dnsLookup(name, { all: true });
    } catch {
      throw probeError("UNREACHABLE", `${hostname} could not be found.`);
    }
    for (const { address } of addresses) {
      if (!classifyAddress(address).isPublic) throw probeError("BLOCKED_ADDRESS", `${hostname} is not on the public internet.`);
    }
  }

  /** One GET, following redirects by hand so every hop is checked. */
  async function get(url, { maxBytes, signal }) {
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const parsed = new URL(target);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw probeError("UNREACHABLE", "Only web addresses can be read.");
      await assertPublic(parsed.hostname);
      let response;
      try {
        response = await fetchImpl(target, {
          redirect: "manual",
          signal,
          headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
        });
      } catch (error) {
        if (signal.aborted) throw probeError("TIMEOUT", `${parsed.hostname} took too long to answer.`);
        throw probeError("UNREACHABLE", `${parsed.hostname} could not be reached.`, error);
      }
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel().catch(() => {});
        target = new URL(location, target).href;
        continue;
      }
      return { status: response.status, url: target, contentType: response.headers.get("content-type") ?? "", text: await readText(response, maxBytes) };
    }
    throw probeError("UNREACHABLE", "The address redirects too many times.");
  }

  return {
    /**
     * @param {string} url an absolute, canonical address
     * @returns {Promise<{status: number|null, finalUrl: string|null, title: string|null,
     *   robotsAllowed: boolean|null, error: {code: string, message: string}|null}>}
     */
    async probe(url) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      try {
        const target = new URL(url);
        let robotsAllowed = null;
        try {
          const robots = await get(new URL("/robots.txt", target).href, { maxBytes: MAX_ROBOTS_BYTES, signal: controller.signal });
          robotsAllowed = createRobotsRules({ status: robots.status, text: robots.text }, ROBOTS_AGENT)
            .allows(`${target.pathname}${target.search}`);
        } catch (error) {
          // An unreadable robots.txt says nothing either way; the page's own answer is next.
          if (error.code === "BLOCKED_ADDRESS") throw error;
        }
        if (robotsAllowed === false) {
          return { status: null, finalUrl: null, title: null, robotsAllowed, error: null };
        }
        const page = await get(url, { maxBytes: MAX_PAGE_BYTES, signal: controller.signal });
        return {
          status: page.status,
          finalUrl: page.url,
          title: page.status < 400 && /html/i.test(page.contentType) ? titleOf(page.text) : null,
          robotsAllowed,
          error: null,
        };
      } catch (error) {
        return {
          status: null,
          finalUrl: null,
          title: null,
          robotsAllowed: null,
          error: { code: error.code ?? "UNREACHABLE", message: error.code ? error.message : "The address could not be read." },
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Reads a response's body as text, stopping after `maxBytes`. */
async function readText(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(parts.map((part) => Buffer.from(part))).subarray(0, maxBytes).toString("utf8");
}

/** The text of a page's `<title>`, with the common entities decoded, or null. */
function titleOf(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html ?? "");
  if (!match) return null;
  const text = match[1]
    .replace(/&#(\d+);/g, (_, code) => codePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => codePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 200) : null;
}

/** A character by its number, or nothing for a number that names none. */
function codePoint(value) {
  try {
    return String.fromCodePoint(value);
  } catch {
    return "";
  }
}

function probeError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}
