/**
 * Queue priority bands for crawl work, lowest number first.
 *
 * The bands encode what is most worth knowing when a crawl is cut short — by its page budget, by a
 * failure, or by the next scheduled crawl starting. Everything below the cut is still crawled
 * eventually; the ordering decides what a partial crawl has covered.
 *
 * Each band leaves room for depth to order pages inside it. That matters most on a first crawl,
 * when every page is equally new: without the inner ordering the whole site would share one
 * priority and a truncated crawl would cover an arbitrary slice of it rather than the top of the
 * site.
 */
const CRAWL_PRIORITY = Object.freeze({
  /** Never crawled, ordered by depth: 0 through 3. */
  neverCrawled: 0,
  /** Last crawl returned an error: it either recovered, which is news, or is still broken. */
  previouslyBroken: 4,
  /** The sitemap says this page changed since we last read it. */
  declaredChanged: 5,
  /** Everything else, ordered by depth: 6 through 9. */
  unchanged: 6,
});

/** How many priority steps depth may contribute inside a band. */
const DEPTH_SPREAD = 3;

/** Depth assumed for a page whose distance from the home page is not yet known. */
const UNKNOWN_DEPTH = 2;

/**
 * Chooses a queue priority for one registered URL.
 *
 * This is what makes a repeat crawl cheap rather than merely repeated. A weekly crawl of a stable
 * site spends most of its requests on conditional GETs that come back 304, so the ordering decides
 * which pages are looked at while the budget lasts: pages never seen, then pages that were broken,
 * then pages the site itself says have changed.
 *
 * @param {object} row registry document for the URL
 * @param {Date} [now] current time; defaults to now
 * @returns {number} priority from 0 (soonest) through 9
 */
export function recrawlPriority(row, now = new Date()) {
  const depth = Number.isInteger(row?.depth) ? row.depth : UNKNOWN_DEPTH;
  const offset = Math.min(DEPTH_SPREAD, Math.max(0, depth));

  if (!row?.lastCrawledAt) return CRAWL_PRIORITY.neverCrawled + offset;
  if (Number.isInteger(row.lastStatus) && row.lastStatus >= 400) return CRAWL_PRIORITY.previouslyBroken;
  if (declaredChangedSince(row, now)) return CRAWL_PRIORITY.declaredChanged;
  return CRAWL_PRIORITY.unchanged + offset;
}

/**
 * Reports whether the sitemap claims this page changed after we last crawled it.
 *
 * `lastmod` is a hint, not a guarantee — plenty of sites stamp it with the build date of every
 * page — so it only ever raises a page's priority. It never causes a page to be skipped, because
 * trusting it that far would silently miss changes on every site that maintains it badly.
 *
 * An unparseable or future-dated `lastmod` is ignored rather than treated as a change, so a
 * misconfigured sitemap cannot pin every page at the front of the queue on every crawl.
 */
function declaredChangedSince(row, now) {
  const lastmod = row.sitemap?.lastmod;
  if (typeof lastmod !== "string" || !lastmod) return false;

  const declared = new Date(lastmod);
  if (Number.isNaN(declared.getTime()) || declared > now) return false;
  return declared > new Date(row.lastCrawledAt);
}

/** How long a step that waits for other jobs of its run leaves it before looking again. */
const RECHECK_DELAY_MS = 2000;

/** The same, once the jobs it is waiting for are few and about to finish. */
const RECHECK_SOON_MS = 250;

/** How many outstanding jobs count as few: a couple of rounds of what one worker runs at once. */
const FEW_JOBS = 8;

/**
 * Counts the jobs a waiting step — the barrier before fetching, or finalize — is waiting for, and
 * chooses when it should look again.
 *
 * These steps re-queue themselves until the jobs they wait for have drained. With several jobs
 * of a run in flight, such a step is claimed whenever a slot is free, which includes the moment
 * the last few pages are still being read; a fixed two-second wait from there would end most
 * crawls with two idle seconds, and would be most of the duration of a crawl that had one page
 * due. So the wait shortens when what is left is little and under way. It stays long while there
 * is plenty left, and while anything left is itself waiting — out a retry delay, or a host's
 * hold, which can last an hour — because looking again sooner would then only be more jobs.
 *
 * @param {import("mongodb").Collection} jobs the `agent_jobs` collection
 * @param {object} filter which jobs the step waits for, without their status
 * @param {() => Date} [now] clock; defaults to the system clock
 * @returns {Promise<{outstanding: number, recheckAt: Date}>} how many are pending or running, and
 *   when to check again if that is not none
 */
export async function awaitedJobs(jobs, filter, now = () => new Date()) {
  const current = now();
  const soon = new Date(current.getTime() + RECHECK_SOON_MS);
  const [outstanding, delayed] = await Promise.all([
    jobs.countDocuments({ ...filter, status: { $in: ["pending", "running"] } }),
    jobs.countDocuments({ ...filter, status: "pending", availableAt: { $gt: soon } }),
  ]);
  const underWay = outstanding <= FEW_JOBS && delayed === 0;
  return { outstanding, recheckAt: underWay ? soon : new Date(current.getTime() + RECHECK_DELAY_MS) };
}
