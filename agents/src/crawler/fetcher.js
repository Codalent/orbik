import { lookup } from "node:dns/promises";

import { classifyAddress } from "@orbik/core";

import { AgentError } from "../runtime/errors.js";
import { rateLimitedError, THROTTLE_STATUSES } from "./throttle.js";

/** Defaults chosen to be polite to a third-party server rather than fast for us. */
const FETCH_DEFAULTS = Object.freeze({
  timeoutMs: 15_000,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
  minHostIntervalMs: 500,
  throttleHoldMs: 30_000,
  maxThrottleHoldMs: 60 * 60 * 1000,
  // What a crawl of pages asks for. A caller fetching something else says what.
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
});

/**
 * The header a redirect's target is moved to by {@link withoutRedirects}, so that the client
 * below — which follows `Location` — does not follow it unasked.
 */
export const REDIRECT_HEADER = "x-orbik-redirect";

/**
 * Creates the HTTP client every crawl request goes through.
 *
 * Two properties matter more than throughput:
 *
 * 1. **Politeness is enforced here, not by convention.** Per-host pacing lives inside the fetcher
 *    so no caller can accidentally bypass it. A crawler that hammers a client's server is worse
 *    than a slow one.
 * 2. **HTTP status is data, not failure.** A 404 or a 500 is precisely what the crawl exists to
 *    record, so only transport-level problems throw. Callers that need different handling — as
 *    robots.txt does for 5xx — decide for themselves.
 *
 * @param {object} options client policy
 * @param {string} options.userAgent product token sent on every request, with a contact URL
 * @param {number} [options.timeoutMs=15000] per-request deadline
 * @param {number} [options.maxBytes=5242880] response bytes read before truncating
 * @param {number} [options.maxRedirects=5] redirect hops followed
 * @param {number} [options.minHostIntervalMs=500] minimum gap between requests to one host
 * @param {number} [options.throttleHoldMs=30000] how long a host is left alone after a 429 or 503
 *   that carries no `Retry-After`
 * @param {number} [options.maxThrottleHoldMs=3600000] ceiling on an honoured `Retry-After`, so a
 *   hostile or mistaken header cannot park a crawl for a day
 * @param {string} [options.accept] the `Accept` header sent; a page's by default. The Image alt
 *   text agent asks for images, so a server that chooses a format by this header chooses one the
 *   agent can read
 * @param {typeof globalThis.fetch} [options.fetchImpl] HTTP transport; defaults to the platform
 *   `fetch`
 * @param {typeof lookup} [options.dnsLookup] DNS resolver; defaults to `dns.promises.lookup`
 * @param {() => number} [options.now] clock in epoch milliseconds; defaults to the system clock
 */
export function createFetcher(options) {
  const config = { ...FETCH_DEFAULTS, ...options };
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const dnsLookup = config.dnsLookup ?? lookup;
  const clock = config.now ?? Date.now;
  // Per host, the turn of the request most recently let through: see `pace`.
  const turns = new Map();
  // Hosts that have asked to be left alone, and until when. Kept apart from the pacing map
  // because the two are acted on differently: a pacing gap is waited out, a hold is not.
  const heldUntil = new Map();

  return {
    /**
     * Reports how much longer a URL's host has asked to be left alone, in milliseconds.
     *
     * Zero means a request may be sent now. Callers that pay for a request before sending it
     * check this first, so a held host costs nothing rather than a charge and a refund.
     *
     * @param {string} url absolute URL whose host is being asked about
     */
    holdRemainingMs(url) {
      return remainingHold(heldUntil, new URL(url).host, clock());
    },

    /**
     * Fetches one URL, following redirects manually so the whole chain is recorded.
     *
     * The chain is kept because it is diagnostic output in its own right: redirect hops, loops,
     * and chains that end in an error are among the findings a crawl exists to surface, and a
     * client that silently followed them would throw that evidence away.
     *
     * @param {string} url absolute, already-normalized URL
     * @param {object} [request] conditional-request and cancellation inputs
     * @param {string} [request.etag] previous `ETag`, sent as `If-None-Match`
     * @param {string} [request.lastModified] previous `Last-Modified`, sent as `If-Modified-Since`
     * @param {AbortSignal} [request.signal] cancellation, used on worker shutdown
     * @param {number} [request.hostDelayMs] extra pacing for this host, e.g. robots `Crawl-delay`
     * @returns {Promise<{status: number, url: string, redirects: object[], headers: Record<string,string>,
     *   body: string|null, buffer: Buffer|null, bytes: number, truncated: boolean,
     *   notModified: boolean, elapsedMs: number, retryAfterMs: number|null}>} `elapsedMs` is
     *   the time the request and its redirects took, without the wait for the host's turn;
     *   `retryAfterMs` is set on a 429 or 503 and says how long this host will now be left alone
     * @throws {AgentError} `FETCH_TIMEOUT`, `FETCH_FAILED`, `BLOCKED_ADDRESS`, `TOO_MANY_REDIRECTS`,
     *   or `RATE_LIMITED` when the host is still inside a hold and no request was sent. A
     *   `TOO_MANY_REDIRECTS` error carries the last redirect the server sent as `response`, in
     *   the shape returned here, for a caller that records the address rather than failing on it
     */
    async fetch(url, request = {}) {
      const startedAt = clock();
      // Time spent waiting for the host's turn, kept out of `elapsedMs`: that figure is shown as
      // how long the page took to answer, and with several pages being read at once most of a
      // request's life can be the queue in front of it.
      let waitedMs = 0;
      const redirects = [];
      let target = url;
      let lastRedirect = null;

      for (let hop = 0; hop <= config.maxRedirects; hop += 1) {
        const parsed = new URL(target);
        // Refused rather than waited out. A hold can be an hour long, and a worker slot that sat
        // on it would be an hour of crawling capacity spent doing nothing; the queue can put the
        // job back for exactly that long without costing anyone anything.
        const held = remainingHold(heldUntil, parsed.host, clock());
        if (held > 0) throw rateLimitedError({ url: target, retryAfterMs: held });

        await assertPublicAddress(parsed.hostname, { dnsLookup });
        const queuedAt = clock();
        await pace(turns, parsed.host, Math.max(config.minHostIntervalMs, request.hostDelayMs ?? 0), request.signal, clock);
        waitedMs += clock() - queuedAt;

        // Asked again after the wait. Several requests to one host queue here for their turn,
        // and the answer to the one ahead may have been "slow down": a hold that began while
        // this one was waiting stops it as surely as one that began before it arrived.
        const heldMeanwhile = remainingHold(heldUntil, parsed.host, clock());
        if (heldMeanwhile > 0) throw rateLimitedError({ url: target, retryAfterMs: heldMeanwhile });

        const response = await send(fetchImpl, target, config, request, hop === 0);

        // The hold is recorded here, inside the client, for the same reason pacing is: every
        // caller — page fetch, robots.txt, sitemap walk — shares one host and one quota with the
        // server, so a "slow down" heard by any of them has to be obeyed by all of them.
        if (THROTTLE_STATUSES.has(response.status)) {
          const holdMs = throttleHoldMs(response.headers["retry-after"], config, clock());
          heldUntil.set(parsed.host, clock() + holdMs);
          return { ...response, url: target, redirects, elapsedMs: clock() - startedAt - waitedMs, retryAfterMs: holdMs };
        }

        if (response.status >= 300 && response.status < 400 && response.headers.location) {
          redirects.push({ status: response.status, url: target });
          let next;
          try {
            next = new URL(response.headers.location, target).href;
          } catch {
            throw new AgentError({ code: "FETCH_FAILED", message: "Redirect target could not be parsed.", retryable: false });
          }
          // A loop is a permanent property of the site, so retrying it would only repeat the
          // same hops and consume another attempt.
          lastRedirect = { ...response, url: target, redirects, elapsedMs: clock() - startedAt - waitedMs, retryAfterMs: null };
          if (redirects.some((hopped) => hopped.url === next)) {
            throw unresolvedRedirect("Redirect loop detected.", lastRedirect);
          }
          target = next;
          continue;
        }

        return { ...response, url: target, redirects, elapsedMs: clock() - startedAt - waitedMs, retryAfterMs: null };
      }

      throw unresolvedRedirect(`Redirect chain exceeded ${config.maxRedirects} hops.`, lastRedirect);
    },
  };
}

/**
 * The failure for an address whose redirects never arrive anywhere.
 *
 * The server answered every hop, so the last answer travels with the error: the crawler records
 * such an address as a broken page with the hops it took, where a caller with nothing to record —
 * robots.txt, a sitemap — just lets it fail.
 */
function unresolvedRedirect(message, response) {
  return Object.assign(new AgentError({ code: "TOO_MANY_REDIRECTS", message, retryable: false }), { response });
}

/**
 * Wraps a request function so that a redirect is returned to its caller and never followed.
 *
 * The client above follows redirects itself, which is right for a site whose owner asked for it
 * to be crawled. A caller that has to check each next address before asking for it — is it still
 * the site that was named, does its robots.txt allow it — hands the client this transport instead:
 * the target is moved out of `Location` into {@link REDIRECT_HEADER}, a header the client does not
 * know, so it sees a response with a redirect's status and nowhere to go, and hands it back. Its
 * pacing, its timeout, its size cap and its refusal of non-public addresses all still apply to
 * every hop, because every hop is then one of its own requests.
 *
 * For a reader that is not a crawl of the workspace's own pages — a read of another site, or a
 * fetch of one image — and must still follow redirects one guarded hop at a time.
 *
 * @param {typeof globalThis.fetch} fetchImpl the transport to wrap
 * @returns {typeof globalThis.fetch}
 */
export function withoutRedirects(fetchImpl) {
  return async (url, init) => {
    const response = await fetchImpl(url, init);
    const location = response.headers.get("location");
    if (!location || response.status < 300 || response.status >= 400 || response.status === 304) return response;
    await response.body?.cancel?.().catch(() => {});
    const headers = new Headers(response.headers);
    headers.delete("location");
    headers.set(REDIRECT_HEADER, location);
    return new Response(null, { status: response.status, headers });
  };
}

/**
 * Performs one request and reads a bounded body.
 *
 * @param {boolean} conditional whether validators may be sent; only the first hop carries them,
 *   because a redirect target's representation is unrelated to the original URL's validators
 */
async function send(fetchImpl, target, config, request, conditional) {
  const headers = { "user-agent": config.userAgent, accept: config.accept };
  if (conditional && request.etag) headers["if-none-match"] = request.etag;
  if (conditional && request.lastModified) headers["if-modified-since"] = request.lastModified;

  const timeout = AbortSignal.timeout(config.timeoutMs);
  const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;

  let response;
  try {
    response = await fetchImpl(target, { headers, redirect: "manual", signal });
  } catch (error) {
    if (timeout.aborted) {
      throw new AgentError({ code: "FETCH_TIMEOUT", message: `Request exceeded ${config.timeoutMs}ms.`, retryable: true, cause: error });
    }
    if (request.signal?.aborted) {
      throw new AgentError({ code: "FETCH_ABORTED", message: "Request cancelled during shutdown.", retryable: true, cause: error });
    }
    // DNS failures, refused connections, and TLS errors are frequently transient.
    throw new AgentError({ code: "FETCH_FAILED", message: error.message, retryable: true, cause: error });
  }

  const responseHeaders = Object.fromEntries(response.headers);

  // 304 carries no body by definition; the caller reuses the snapshot it already has.
  if (response.status === 304) {
    return { status: 304, headers: responseHeaders, body: null, buffer: null, bytes: 0, truncated: false, notModified: true };
  }

  const { text, buffer, bytes, truncated } = await readBounded(response, config.maxBytes);
  return { status: response.status, headers: responseHeaders, body: text, buffer, bytes, truncated, notModified: false };
}

/**
 * Reads a response body up to a byte ceiling.
 *
 * The cap is enforced while streaming rather than after: a misconfigured server offering an
 * endless response would otherwise exhaust the worker's memory before any length check ran.
 */
async function readBounded(response, maxBytes) {
  if (!response.body) return { text: "", buffer: Buffer.alloc(0), bytes: 0, truncated: false };

  const chunks = [];
  let bytes = 0;
  let truncated = false;
  for await (const chunk of response.body) {
    const piece = Buffer.from(chunk);
    if (bytes + piece.length > maxBytes) {
      chunks.push(piece.subarray(0, maxBytes - bytes));
      bytes = maxBytes;
      truncated = true;
      break;
    }
    chunks.push(piece);
    bytes += piece.length;
  }
  if (truncated) await response.body.cancel?.().catch(() => {});

  // The raw bytes are kept alongside the decoded text because gzipped sitemaps are served as
  // `application/gzip` with no `Content-Encoding`, so the transport does not decompress them and
  // a UTF-8 decode would destroy the payload.
  const buffer = Buffer.concat(chunks);
  return { text: buffer.toString("utf8"), buffer, bytes, truncated };
}

/**
 * Refuses to request an address that is not on the public internet.
 *
 * Site URLs are user input, so without this check a workspace owner could point the crawler at
 * `http://localhost:4100`, at a cloud provider's metadata endpoint, or at anything else reachable
 * from the worker but not from the internet, and read the response back out of the crawl results.
 *
 * Every address the name resolves to must be public by `classifyAddress` in `@orbik/core`, the
 * allow-list the API's own two checks use: ordinary `unicast` only, with an IPv4 address written
 * inside IPv6 (`::ffff:127.0.0.1`) judged as the IPv4 address it is.
 *
 * Known limitation: the name is resolved here and connected to separately, so a DNS entry that
 * changes between the two calls can still slip through. Closing that gap requires pinning the
 * connection to the resolved address, which the platform fetch does not expose. This check is
 * defence in depth, and workers should also be network-isolated from internal services.
 */
async function assertPublicAddress(hostname, { dnsLookup }) {
  // A URL writes an IPv6 address in brackets and a resolver wants it without them. Left on,
  // `[::1]` is a name that does not resolve: still not requested, but refused as unreachable
  // when what it is, is not public.
  const name = hostname.replace(/^\[|\]$/g, "");
  let addresses;
  try {
    addresses = await dnsLookup(name, { all: true });
  } catch (error) {
    throw new AgentError({ code: "FETCH_FAILED", message: `Host ${hostname} could not be resolved.`, retryable: true, cause: error });
  }

  for (const { address } of addresses) {
    const { isPublic, range } = classifyAddress(address);
    if (range === null) {
      throw new AgentError({ code: "BLOCKED_ADDRESS", message: `Host ${hostname} resolved to an unparseable address.`, retryable: false });
    }
    if (!isPublic) {
      throw new AgentError({
        code: "BLOCKED_ADDRESS",
        message: `Host ${hostname} resolves to a non-public address.`,
        retryable: false,
      });
    }
  }
}

/**
 * Waits for this host's turn: no sooner than the interval after the request before it was sent.
 *
 * Requests to one host queue here in the order they arrive, each behind the one before, so
 * several pages being read at once in one process do not all observe the same stale "last
 * request" time and fire together.
 *
 * The interval is measured from when the previous request was actually let through, not from
 * when it was due. A due time is kept by a timer, and a timer fires late whenever the process is
 * busy — parsing another page takes tens of milliseconds, sometimes hundreds. Spacing by due
 * times would let the request behind a late one go out on schedule, right on its heels, and two
 * whose times both passed during one long parse go out together.
 *
 * When two requests ask for different intervals — a page under a robots.txt `Crawl-delay`, the
 * robots.txt request itself under none — the longer of the two separates them.
 *
 * @param {Map<string, Promise<{sentAt: number, intervalMs: number}>>} turns per host, the turn of
 *   the last request to join the queue, settled when that request is let through
 */
async function pace(turns, host, intervalMs, signal, clock = Date.now) {
  const previous = turns.get(host);
  let letThrough;
  turns.set(host, new Promise((resolve) => { letThrough = resolve; }));
  try {
    const before = previous ? await previous : null;
    if (before) {
      const wait = before.sentAt + Math.max(before.intervalMs, intervalMs) - clock();
      if (wait > 0) await delay(wait, signal);
    }
  } finally {
    letThrough({ sentAt: clock(), intervalMs });
  }
}

/** How much of a host's hold is left, or zero; an expired hold is dropped so the map stays small. */
function remainingHold(heldUntil, host, now) {
  const until = heldUntil.get(host);
  if (until === undefined) return 0;
  if (until <= now) {
    heldUntil.delete(host);
    return 0;
  }
  return until - now;
}

/**
 * Turns a `Retry-After` header into how long to leave the host alone.
 *
 * The header may be a number of seconds or an HTTP date; both forms are honoured, clamped to at
 * least one second and at most the configured ceiling. Absent or unparseable, the default hold
 * applies — a server that says "not now" without saying when is still saying "not now".
 *
 * @param {string|undefined} header raw `Retry-After` value
 * @param {{throttleHoldMs: number, maxThrottleHoldMs: number}} config hold policy
 * @param {number} now current time in epoch milliseconds
 * @returns {number} hold in milliseconds
 */
function throttleHoldMs(header, config, now = Date.now()) {
  let requested = null;
  if (typeof header === "string" && header.trim()) {
    const text = header.trim();
    if (/^\d+$/.test(text)) {
      requested = Number(text) * 1000;
    } else {
      const at = Date.parse(text);
      if (!Number.isNaN(at)) requested = at - now;
    }
  }
  const hold = requested ?? config.throttleHoldMs;
  return Math.min(Math.max(hold, 1000), config.maxThrottleHoldMs);
}

/** Waits, returning early if the crawl is cancelled. */
function delay(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
