/**
 * How often each URL of a site is recrawled, resolved from the three places a decision can come
 * from.
 *
 * Both processes need this. The crawler applies it when a run finishes and its pages have their
 * route patterns; the API applies it when a person changes a pattern's frequency or pins one
 * page. If each kept its own copy of the rule, the frequency shown on a page and the frequency
 * the crawler acted on would eventually be two different numbers.
 *
 * The rule, in order of precedence:
 * 1. A per-URL override (`crawlOverride` on the registry row) wins outright.
 * 2. A per-pattern override the operator saved on the site wins over the AI.
 * 3. The AI's decision for the pattern.
 * 4. Otherwise: never. A URL nobody has decided about is fetched once when it is discovered and
 *    then left alone until a person asks for it — either by choosing a frequency or by triggering a
 *    crawl by hand. Falling back to some default interval instead would spend crawl budget on a
 *    schedule nobody chose.
 *
 * `null` means "never" everywhere in this module: on an override, on a pattern, and as a result.
 */

/** The site-level cadence when nothing narrower has been chosen, in hours. */
const DEFAULT_CRAWL_INTERVAL_HOURS = 168;

/**
 * Resolves the interval one route pattern is crawled at, or null when it is not.
 *
 * @param {object} site the crawl site document
 * @param {string|null|undefined} pattern route pattern, e.g. `/blog/[slug]`
 * @returns {number|null} hours between crawls, or null for never
 */
export function patternIntervalHours(site, pattern) {
  if (!pattern) return null;
  const override = (site.crawlScheduleOverrides ?? []).find((row) => row.pattern === pattern);
  if (override) return override.intervalHours ?? null;
  const planned = (site.crawlSchedule?.patterns ?? []).find((row) => row.pattern === pattern);
  return planned?.intervalHours ?? null;
}

/**
 * Resolves the interval one registry row is crawled at, honouring a per-URL override first.
 *
 * @param {object} site the crawl site document
 * @param {object} row a `crawl_urls` document, or the parts of one that matter here
 * @returns {number|null}
 */
export function effectiveIntervalHours(site, row) {
  if (row?.crawlOverride) return row.crawlOverride.intervalHours ?? null;
  return patternIntervalHours(site, row?.routePattern);
}

/**
 * How often the site as a whole must be visited so that every chosen frequency is honoured.
 *
 * A run is what recrawls pages, so a page due daily needs the site visited daily even if every
 * other pattern is monthly. Patterns and pages set to never contribute nothing; the site's own
 * cadence is the ceiling, and it is what keeps new pages being discovered when nothing else is
 * scheduled.
 *
 * @param {object} options
 * @param {import("mongodb").Collection} options.urls the `crawl_urls` collection
 * @param {object} options.site the crawl site document
 * @returns {Promise<number>} hours between visits
 */
async function discoveryIntervalHours({ urls, site }) {
  const chosen = new Set([
    ...(site.crawlSchedule?.patterns ?? []).map((row) => row.pattern),
    ...(site.crawlScheduleOverrides ?? []).map((row) => row.pattern),
  ]);
  const intervals = [...chosen].map((pattern) => patternIntervalHours(site, pattern)).filter((value) => value !== null);

  const [pinned] = await urls.aggregate([
    { $match: { siteId: site._id, "crawlOverride.intervalHours": { $type: "number" } } },
    { $group: { _id: null, min: { $min: "$crawlOverride.intervalHours" } } },
  ]).toArray();
  if (pinned) intervals.push(pinned.min);

  return Math.min(site.crawlIntervalHours ?? DEFAULT_CRAWL_INTERVAL_HOURS, ...intervals);
}

/**
 * Writes the resolved frequency onto every registry row of a site, and the site's own cadence.
 *
 * Materialised rather than resolved at fetch time because the crawler asks "is this due" once per
 * page it considers, and a rule that needs the site document and two lookups per page is a rule
 * that gets cached badly in four places. Writing the answer once, whenever an input changes, keeps
 * the hot path a comparison of two fields on the row.
 *
 * Rows with a per-URL override are left untouched: the override already is their answer, and the
 * API wrote `crawlIntervalHours` alongside it.
 *
 * @param {object} options
 * @param {import("mongodb").Collection} options.sites the crawl sites collection
 * @param {import("mongodb").Collection} options.urls the `crawl_urls` collection
 * @param {object} options.site the crawl site document, read after any change being applied
 * @returns {Promise<number>} the site's resulting cadence in hours
 */
export async function applyCrawlSchedule({ sites, urls, site }) {
  const chosen = new Set([
    ...(site.crawlSchedule?.patterns ?? []).map((row) => row.pattern),
    ...(site.crawlScheduleOverrides ?? []).map((row) => row.pattern),
  ]);
  for (const pattern of chosen) {
    await urls.updateMany(
      { siteId: site._id, routePattern: pattern, crawlOverride: { $exists: false } },
      { $set: { crawlIntervalHours: patternIntervalHours(site, pattern) } },
    );
  }
  // Everything nobody has decided about, including rows whose pattern the AI has not seen yet.
  await urls.updateMany(
    { siteId: site._id, routePattern: { $nin: [...chosen] }, crawlOverride: { $exists: false } },
    { $set: { crawlIntervalHours: null } },
  );

  const interval = await discoveryIntervalHours({ urls, site });
  await sites.updateOne({ _id: site._id }, { $set: { discoveryIntervalHours: interval } });
  return interval;
}
