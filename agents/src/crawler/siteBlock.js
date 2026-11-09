import { CRAWLER_PRODUCT_NAME } from "./siteConfig.js";

/** Statuses by which a server says "not you" rather than "not found" or "not now". */
const REFUSAL_STATUSES = Object.freeze(new Set([401, 403]));

/**
 * How many pages in a row may come back as a bot-protection page before a run stops.
 *
 * One is a page; five with nothing served between them is the site's firewall having decided
 * about this crawler. Each further request would be answered the same way, and asking again and
 * again is what turns a challenge into a ban on the address every workspace crawls from.
 */
const BLOCK_ABORT_AFTER = 5;

/** A page with no more visible words than this has nothing on it but the challenge. */
const THIN_PAGE_WORDS = 30;

/** How much of a body is searched for a signature; they all sit in the first few kilobytes. */
const SCAN_BYTES = 200_000;

/**
 * How each bot-protection service can be recognised.
 *
 * - `challenge`: a response header that is only ever sent with a challenge or a block.
 * - `blockPage`: text only the service's own block page carries. Enough on a refused request, or
 *   on a page with nothing else on it.
 * - `script`: something the service also adds to pages it lets through, so it means a challenge
 *   only when the page has nothing else on it.
 * - `present`: a header that says the service is in front of the site at all. It names who refused
 *   a request; it is never evidence that one was refused.
 *
 * Imperva is the one checked against a live site (2026-10-09); the rest are the markers those
 * services document or are widely observed to send.
 */
const SERVICES = Object.freeze([
  {
    name: "Imperva",
    blockPage: /Incapsula incident ID/i,
    script: /_Incapsula_Resource/,
    present: (headers) => /imperva|incapsula/i.test(headers["x-cdn"] ?? "") || "x-iinfo" in headers,
  },
  {
    name: "Cloudflare",
    challenge: (headers) => /challenge/i.test(headers["cf-mitigated"] ?? ""),
    blockPage: /Attention Required! \| Cloudflare|Sorry, you have been blocked/i,
    script: /\/cdn-cgi\/challenge-platform\//,
    present: (headers) => /cloudflare/i.test(headers.server ?? "") || "cf-ray" in headers,
  },
  {
    name: "DataDome",
    blockPage: /captcha-delivery\.com/i,
    present: (headers) => "x-datadome" in headers || "x-dd-b" in headers,
  },
  {
    name: "Akamai",
    blockPage: /errors\.edgesuite\.net/i,
    present: (headers) => /akamai/i.test(headers.server ?? ""),
  },
  {
    name: "AWS WAF",
    challenge: (headers) => /challenge|captcha/i.test(headers["x-amzn-waf-action"] ?? ""),
    script: /awswaf\.com|AwsWafIntegration/,
  },
  {
    name: "HUMAN",
    blockPage: /px-captcha/i,
    script: /_pxAppId/,
  },
  {
    name: "Sucuri",
    blockPage: /Sucuri WebSite Firewall - Access Denied/i,
    present: (headers) => "x-sucuri-id" in headers,
  },
  {
    name: "Vercel",
    challenge: (headers) => /challenge/i.test(headers["x-vercel-mitigated"] ?? ""),
    present: (headers) => /vercel/i.test(headers.server ?? ""),
  },
]);

/**
 * Decides whether a response is the site turning the crawler away rather than a page.
 *
 * Two kinds are told apart because they deserve different trust. A `challenge` is a
 * bot-protection service's own page — "prove you are a browser" — and is recognised whatever its
 * status, because several of them answer 200: stored as a page it would be an empty, `noindex`
 * home page in the Library. A `refused` response is a bare 401 or 403, which on one page is a
 * finding (a members' area, a login) and only on the home page means the site will not be read.
 * The caller makes that distinction; this only says what the response is.
 *
 * @param {{status: number, headers?: Record<string, string>, body?: string|null}} response what the
 *   fetcher returned
 * @returns {{kind: "challenge"|"refused", service: string|null, status: number}|null} null for
 *   anything that is a page, including an ordinary error page
 */
export function detectSiteBlock(response) {
  const headers = response.headers ?? {};
  const status = response.status;
  const refused = REFUSAL_STATUSES.has(status);

  for (const service of SERVICES) {
    if (service.challenge?.(headers)) return { kind: "challenge", service: service.name, status };
  }

  const head = typeof response.body === "string" ? response.body.slice(0, SCAN_BYTES) : "";
  if (head) {
    let thin = null;
    const isThin = () => (thin ??= countVisibleWords(head) <= THIN_PAGE_WORDS);
    for (const service of SERVICES) {
      const blockPage = service.blockPage?.test(head) && (refused || isThin());
      const scriptOnly = service.script?.test(head) && isThin();
      if (blockPage || scriptOnly) return { kind: "challenge", service: service.name, status };
    }
  }

  if (!refused) return null;
  const service = SERVICES.find((candidate) => candidate.present?.(headers))?.name ?? null;
  return { kind: "refused", service, status };
}

/** Counts the words a person would see, which is what separates a challenge from a page. */
function countVisibleWords(html) {
  const text = html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ");
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Reports whether a run has been stopped because the site will not let the crawler in.
 *
 * The counterpart of `isRunRateLimited`: jobs check it before touching the network, so the work
 * still queued for a stopped run drains as no-ops rather than each collecting its own refusal.
 *
 * @param {import("mongodb").Collection} runs the `agent_runs` collection
 * @param {import("mongodb").ObjectId|null|undefined} runId run the job belongs to
 */
export async function isRunBlocked(runs, runId) {
  if (!runId) return false;
  const run = await runs.findOne({ _id: runId }, { projection: { "block.abortedAt": 1 } });
  return Boolean(run?.block?.abortedAt);
}

/**
 * Records one blocked response against its run and decides whether the run should stop.
 *
 * The home page is decisive on its own: a public site that will not serve its front door to the
 * crawler has nothing else to offer it, and the crawl stops before a page of budget is spent.
 * Anywhere else it takes an unbroken streak, kept with `$inc` because many workers report on one
 * run at once and reset by {@link recordNotBlocked} the moment a page is served.
 *
 * @param {object} input what happened
 * @param {import("mongodb").Collection} input.runs the `agent_runs` collection
 * @param {import("mongodb").ObjectId|null|undefined} input.runId run the job belongs to
 * @param {{kind: string, service: string|null, status: number}} input.block what {@link detectSiteBlock} found
 * @param {string} input.url page that was asked for
 * @param {boolean} input.seed whether that page is the site's seed
 * @returns {Promise<{consecutive: number, aborted: boolean}>} the streak, and whether this response
 *   was the one that stopped the run
 */
export async function recordBlocked({ runs, runId, block, url, seed }) {
  if (!runId) return { consecutive: 0, aborted: false };
  const now = new Date();
  const run = await runs.findOneAndUpdate(
    { _id: runId },
    {
      $inc: { "block.consecutive": 1 },
      $set: {
        "block.kind": block.kind,
        "block.service": block.service,
        "block.status": block.status,
        "block.lastUrl": url,
        "block.lastAt": now,
        updatedAt: now,
      },
    },
    { returnDocument: "after", projection: { block: 1 } },
  );
  const consecutive = run?.block?.consecutive ?? 0;
  if ((!seed && consecutive < BLOCK_ABORT_AFTER) || run?.block?.abortedAt) return { consecutive, aborted: false };

  // The filter repeats the condition so two workers crossing the threshold together produce one
  // abort, not two.
  const result = await runs.updateOne(
    { _id: runId, "block.abortedAt": { $exists: false } },
    { $set: { "block.abortedAt": now, "block.host": new URL(url).host, "block.seed": seed, updatedAt: now } },
  );
  return { consecutive, aborted: result.modifiedCount === 1 };
}

/**
 * Notes that a page was served, ending any streak of blocked responses.
 *
 * Free for the common case: a run that has never been blocked has no positive count to reset, so
 * the write matches nothing.
 *
 * @param {import("mongodb").Collection} runs the `agent_runs` collection
 * @param {import("mongodb").ObjectId|null|undefined} runId run the job belongs to
 */
export async function recordNotBlocked(runs, runId) {
  if (!runId) return;
  await runs.updateOne(
    { _id: runId, "block.consecutive": { $gt: 0 } },
    { $set: { "block.consecutive": 0 } },
  );
}

/**
 * The error a run is closed with when its site would not let the crawler in.
 *
 * Written for the person who has to get it fixed, who is usually not the person who runs the
 * firewall: it names the host, who answered and with what, and the one thing to ask for.
 *
 * @param {object} block the run's `block` record
 * @param {number} unfetched pages the run left unfetched because it stopped
 */
export function blockedRunError(block, unfetched) {
  const host = block?.host ?? "The site";
  const by = block?.service ? `${block.service}, the bot protection in front of it,` : "it";
  const what = REFUSAL_STATUSES.has(block?.status) || block?.kind !== "challenge"
    ? `${by} refused the request`
    : `${by} answered with a browser check instead of the page`;
  const where = block?.seed ? "the home page" : `${BLOCK_ABORT_AFTER} pages in a row`;
  const left = unfetched > 0 ? ` ${unfetched.toLocaleString("en-US")} page(s) were left unfetched.` : "";
  const allow = block?.service ? `${block.service}'s bot rules` : "its firewall or server rules";
  return {
    code: "ACCESS_REFUSED",
    message: `${host} is not letting the crawler in: ${what} (HTTP ${block?.status ?? 403}) for ${where}, so the crawl was stopped.${left} `
      + `Whoever manages the site can let it through by allowing the user agent "${CRAWLER_PRODUCT_NAME}" in ${allow}; then crawl again.`,
  };
}
