import { escapeRegExp, isWwwPair } from "@orbik/core";

import { normalizeUrl, tryNormalizeUrl } from "./url.js";

/**
 * Finding the host a site actually lives on.
 *
 * A person types `example.com`; the site answers on `www.example.com` and the bare name only
 * redirects there (or the other way round). A crawl covers one hostname, so one that stayed on
 * the name that was typed would follow every relative link through a redirect, refuse every
 * absolute link and every sitemap entry as another site's, and end having read a fraction of the
 * site, each page of it at the cost of an extra request.
 *
 * So discovery asks for the seed once, before anything is registered, and looks at where it
 * landed. When that is the seed's `www.` twin, the site moves there: the seed becomes the same
 * address on the origin that answered, and the hostname it left is recorded on the site as
 * `redirectedFrom`. From then on the crawl registers, scopes and fetches on the host that answers,
 * and an address still written with the old spelling is read as its twin (`createScope().onSiteHost`).
 *
 * Nothing wider than that pair is ever adopted. A seed that redirects to a subdomain, to another
 * domain, or nowhere, leaves the site exactly where it was.
 */

/**
 * Asks for the seed and reports the origin it should move to, if it redirects to its `www.` twin.
 *
 * The request is free — discovery's requests are not charged — and it is made on every crawl, so
 * a site that later swaps which of the two names redirects is followed there by its next crawl.
 * It is not made when robots.txt forbids the seed: a page the crawler may not fetch is not
 * fetched to find out where it goes.
 *
 * Only a seed that was actually answered moves the site: the chain has to end, on the twin, with
 * a 2xx. A redirect into an error or a refusal says where the site points but not that anything
 * is there, and a crawl moved onto a host that serves nothing would have nothing left to compare
 * against.
 *
 * @param {object} options
 * @param {{fetch: Function}} options.fetcher the site's HTTP client
 * @param {object} options.config validated site configuration
 * @param {{allows: (target: string) => boolean, crawlDelay?: number|null}} options.rules the
 *   robots.txt rules in force for the seed
 * @param {AbortSignal} [options.signal] cancellation
 * @returns {Promise<{seedUrl: string, from: {url: string, host: string}, landedOn: string}|null>}
 *   the address the seed should become and the one it was, or null when it stays
 * @throws {AgentError} `RATE_LIMITED` when the host is inside a hold, and `FETCH_ABORTED` on
 *   shutdown: both mean the question was not asked, and the job is retried
 */
export async function findSeedHost({ fetcher, config, rules, signal }) {
  const seed = normalizeUrl(config.seedUrl);
  if (!rules.allows(`${seed.pathname}${seed.search}`)) return null;

  let response;
  try {
    response = await fetcher.fetch(seed.href, {
      signal,
      hostDelayMs: rules.crawlDelay ? rules.crawlDelay * 1000 : undefined,
    });
  } catch (error) {
    if (error?.code === "RATE_LIMITED" || error?.code === "FETCH_ABORTED") throw error;
    // Unreachable, looping, or pointing somewhere the crawler will not go. None of them says the
    // site lives elsewhere, and the fetch of the seed reports the problem in its own words.
    return null;
  }
  if (response.status < 200 || response.status >= 300) return null;

  const landed = tryNormalizeUrl(response.url);
  if (!landed || !isWwwPair(landed.hostname, seed.hostname)) return null;

  // The address that was typed, on the origin that answered. Its path is kept: where on the host
  // the redirect led — a language folder, a trailing slash — is that host's own redirect to make
  // again, as it is for any seed, and taking it from one response would pin the crawl to whatever
  // one visit happened to be sent to.
  const moved = new URL(seed.href);
  moved.protocol = landed.protocol;
  moved.host = landed.host;
  return {
    seedUrl: normalizeUrl(moved.href).href,
    from: { url: seed.href, host: seed.hostname },
    landedOn: landed.href,
  };
}

/**
 * Moves a site's seed to the host that answered, and records the spelling it left.
 *
 * Written only while the site still starts where this crawl read it from: somebody saving another
 * start address in the meantime has said something newer than this request did.
 *
 * @param {object} options
 * @param {import("mongodb").Collection} options.sites the `crawl_sites` collection
 * @param {object} options.document the site as this crawl read it
 * @param {{seedUrl: string, from: {url: string, host: string}}} options.moved from {@link findSeedHost}
 * @param {import("mongodb").ObjectId} [options.runId] the run that saw the redirect
 * @param {() => Date} [options.now] clock
 * @returns {Promise<object|null>} the site as it now stands, or null when it had changed meanwhile
 */
export async function moveSeedHost({ sites, document, moved, runId, now = () => new Date() }) {
  const at = now();
  try {
    return await sites.findOneAndUpdate(
      { _id: document._id, seedUrl: document.seedUrl },
      {
        $set: {
          seedUrl: moved.seedUrl,
          // The host a source is known by follows its seed: each host is read by one source.
          host: new URL(moved.seedUrl).hostname.toLowerCase(),
        // `to` is the seed as this move left it, which is how the API tells a seed that still
        // follows the website from one a person has since chosen for themselves.
          redirectedFrom: { url: moved.from.url, host: moved.from.host, to: moved.seedUrl, at, runId: runId ?? null },
          updatedAt: at,
        },
      },
      { returnDocument: "after" },
    );
  } catch (error) {
    // Another source of the workspace already reads the twin (a unique index on its sources'
    // hosts): this one stays where it is rather than reading that source's pages again.
    if (error?.code === 11000) return null;
    throw error;
  }
}

/**
 * The registry rows a site still holds under the spelling it moved away from.
 *
 * A site crawled before its seed moved has its pages registered on the old hostname, each one a
 * redirect to the page itself. Discovery registers their twins on the site's host, so the crawl
 * goes on knowing every page it knew, and then retires these ({@link retireRows}).
 *
 * Found by what the registry says rather than by "the seed moved in this job": a discovery that
 * moved the seed and died before registering anything is retried against a seed that no longer
 * redirects, and must still finish the move.
 *
 * @param {import("mongodb").Collection} urls the `crawl_urls` collection
 * @param {import("mongodb").ObjectId} siteId the site
 * @param {string} aliasHost the hostname the site moved away from
 * @returns {Promise<object[]>} rows not yet retired
 */
export function rowsOnOldHost(urls, siteId, aliasHost) {
  return urls
    .find({
      siteId,
      // The registry keeps `host`, which carries a port when the address had one.
      host: new RegExp(`^${escapeRegExp(aliasHost)}(:\\d+)?$`),
      inScope: { $ne: false },
    })
    .project({ url: 1, urlHash: 1, discoveredBy: 1, depth: 1, sitemap: 1, crawlOverride: 1 })
    .toArray();
}

/**
 * Takes the rows of the old spelling out of the crawl, once their twins are registered.
 *
 * They are marked out of scope, which is what they are — the scope is the seed's hostname — and
 * so are never fetched again, counted as known pages, or judged for whether anything links to
 * them. They are not deleted: what was read at each is the only copy of the page until its twin
 * has been read, and finalize then gives each its twin's duplicate group (`describeSiteShape`),
 * which is how the Library hands a page's copy from one to the other.
 *
 * A frequency somebody chose for one of them is given to its twin first, where none was chosen
 * there: the page did not change, only its address. The old row then gives it up. Left on a row
 * nobody can select any more, it would go on deciding how often the whole site is visited — the
 * site's cadence is the shortest frequency pinned on any of its rows — whatever the person chose
 * for the page afterwards.
 *
 * @param {object} options
 * @param {import("mongodb").Collection} options.urls the `crawl_urls` collection
 * @param {import("mongodb").ObjectId} options.siteId the site
 * @param {Array<{row: object, twinHash: string}>} options.moved each old row with its twin's hash
 * @returns {Promise<number>} rows retired
 */
export async function retireRows({ urls, siteId, moved }) {
  if (!moved.length) return 0;
  const pinned = moved.filter(({ row }) => row.crawlOverride);
  if (pinned.length) {
    await urls.bulkWrite(pinned.map(({ row, twinHash }) => ({
      updateOne: {
        filter: { siteId, urlHash: twinHash, crawlOverride: { $exists: false } },
        // Both fields, as the API writes them when a person pins a page.
        update: { $set: { crawlOverride: row.crawlOverride, crawlIntervalHours: row.crawlOverride.intervalHours ?? null } },
      },
    })), { ordered: false });
  }
  const result = await urls.updateMany(
    { siteId, _id: { $in: moved.map(({ row }) => row._id) } },
    // `orphan` goes with them: it is a verdict only a row in scope is ever given again, and one
    // left standing would be counted beside its twin's for good.
    {
      $set: { inScope: false, eligible: false, scopeReason: "OUT_OF_SCOPE_HOST", orphan: false, crawlIntervalHours: null },
      $unset: { crawlOverride: "" },
    },
  );
  return result.modifiedCount ?? 0;
}
