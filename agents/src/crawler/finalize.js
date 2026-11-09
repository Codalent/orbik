import { AgentError, requireObjectId } from "../runtime/errors.js";
import { createEventOutbox, EVENT_TYPES } from "../runtime/eventOutbox.js";
import { CRAWLER_AGENT, CRAWLER_JOBS, LIBRARY_JOBS, libraryJob } from "../jobs.js";
import { createScope } from "./scope.js";
import { derivePatterns } from "./routePattern.js";
import { groupDuplicates } from "./duplicateGroup.js";
import { RUN_STATUS } from "../runtime/runLedger.js";
import { applyCrawlSchedule, getAgentCollections } from "@orbik/core";
import { hashUrl } from "./url.js";
import { parseSiteConfig } from "./siteConfig.js";
import { rateLimitedRunError } from "./throttle.js";
import { blockedRunError } from "./siteBlock.js";
import { awaitedJobs } from "./priority.js";


/** Documents updated per bulk write. */
const BATCH_SIZE = 500;

/**
 * Builds the crawler's finalize step: compute exact link depth once the crawl has finished.
 *
 * Depth cannot be computed correctly while crawling. Pages discovered from a sitemap arrive with
 * no depth at all — a sitemap says nothing about how a page is linked — and pages fetched
 * concurrently see whatever their parent's depth happened to be at that moment. The incremental
 * depth kept during a crawl is therefore a lower bound that converges, not an answer.
 *
 * Running a breadth-first search over the finished link graph gives the real shortest path from
 * the seed to every page, which is what makes "this page is five clicks from the home page" and
 * "nothing links to this page" trustworthy rather than approximate.
 *
 * The handler schedules itself. Rather than requiring a scheduler to notice a crawl has ended, it
 * checks whether any crawl work remains for its run and, if so, re-queues itself a couple of
 * seconds later, or a fraction of one when only a few jobs are left. That keeps run completion a
 * property of the queue rather than of a separate coordinator that could disagree with it.
 *
 * @returns {(job: object, context: object) => Promise<object>} the `crawler.finalize` handler
 */
export function createFinalizeHandler() {
  return async function finalize(job, { database, ledger }) {
    const collections = getAgentCollections(database);
    const siteId = requireObjectId(job.payload?.siteId ?? job.siteId, "siteId");
    const recheck = Number.isInteger(job.payload?.recheck) ? job.payload.recheck : 0;

    let outstanding = 0;
    if (job.runId) {
      // Every crawl job of the run but this step itself, not only the fetches. The job that
      // planned them is one: follow-up jobs become visible in no particular order, so this can be
      // claimed before the fetches queued with it are all written, and the job that queued them
      // is still running until they are. A page explored for its links after the budget ran out
      // is another, and the link graph is not finished until it is.
      const awaited = await awaitedJobs(collections.jobs, {
        runId: job.runId,
        agent: CRAWLER_AGENT,
        type: { $ne: CRAWLER_JOBS.finalize },
      });
      outstanding = awaited.outstanding;
      if (outstanding > 0) {
        return {
          enqueue: [{
            agent: CRAWLER_AGENT,
            type: CRAWLER_JOBS.finalize,
            payload: { siteId: siteId.toHexString(), recheck: recheck + 1 },
            priority: 9,
            availableAt: awaited.recheckAt,
            idempotencyKey: `finalize:${job.runId.toHexString()}:${recheck + 1}`,
          }],
          counters: {},
        };
      }
    }

    const siteDocument = await collections.sites.findOne({ _id: siteId });
    if (!siteDocument) {
      throw new AgentError({ code: "SITE_NOT_FOUND", message: `Site ${siteId.toHexString()} does not exist.` });
    }
    const scope = createScope(parseSiteConfig(siteDocument));
    const seedHash = hashUrl(scope.seed.href);

    const failed = job.runId
      ? await collections.jobs.countDocuments({ runId: job.runId, status: "failed" })
      : 0;
    const run = job.runId
      ? await collections.runs.findOne(
        { _id: job.runId },
        { projection: { counters: 1, cancelRequestedAt: 1, throttle: 1, block: 1 } },
      )
      : null;

    // Whether this run actually saw the whole site, which decides what may be concluded from it.
    // A run cut short by the month's crawl budget, stopped by a person, or left with fetch work
    // still queued has observed a subset — and a subset cannot distinguish "nothing links to this
    // page" from "we never got to the page that links to it".
    const skippedNoBudget = run?.counters?.pagesSkippedNoBudget ?? 0;
    const skippedRateLimited = run?.counters?.pagesSkippedRateLimited ?? 0;
    const rateLimited = Boolean(run?.throttle?.abortedAt);
    // A page answered with a bot-protection page was not read either, even when the run carried
    // on: one is enough to make the run a subset.
    const skippedBlocked = run?.counters?.pagesSkippedBlocked ?? 0;
    const pagesBlocked = run?.counters?.pagesBlocked ?? 0;
    const blocked = Boolean(run?.block?.abortedAt);
    const complete = outstanding === 0 && failed === 0 && skippedNoBudget === 0 && !rateLimited
      && !blocked && pagesBlocked === 0 && !run?.cancelRequestedAt;

    const depths = await computeDepths(collections.links, siteId, seedHash);
    const updated = await applyDepths(collections.urls, siteId, depths);
    const orphans = complete ? await markOrphans(collections.urls, siteId, depths) : 0;

    // Grouping and route patterns are computed here for the same reason depth is: both need the
    // whole site at once. A duplicate cannot be recognised until the page it duplicates has been
    // fetched, and a URL is only an instance of `/blog/[slug]` once its siblings exist.
    const shape = await describeSiteShape(collections, siteId);
    // Rows were only just given their route pattern, so whatever frequencies are already on record
    // are applied to them here. Without this, a pattern set to "daily" by hand would not reach a
    // page this crawl discovered under it.
    if (outstanding === 0) {
      await applyCrawlSchedule({ sites: collections.sites, urls: collections.urls, site: await collections.sites.findOne({ _id: siteId }) });
    }

    const counters = {
      depthsComputed: updated,
      orphanPages: orphans,
      maxDepth: depths.size ? Math.max(...depths.values()) : 0,
      crawlComplete: complete ? 1 : 0,
      duplicateUrls: shape.duplicates,
      uniquePages: shape.uniquePages,
      routePatterns: shape.patterns,
    };

    // Finalize is the only step that knows a crawl is over, so it is also what closes the run.
    // Leaving runs open would make the scheduler's "is this site already crawling" check answer
    // yes forever, and the site would never be crawled again.
    if (job.runId && ledger) {
      // A cancelled crawl is reported as cancelled rather than as a failure, and keeps every page
      // it managed to fetch. Somebody stopping a crawl on purpose has not encountered a fault, and
      // discarding the work already done would make cancelling expensive enough that people let
      // the wrong crawl finish instead.
      // A crawl the site refused is a failure with a named cause, not a success with fewer pages.
      // The cause names the host and the status so the person reading it knows what to allowlist
      // or who to ask, and it takes precedence over dead-lettered jobs because those are usually
      // the same refusals, counted another way.
      const status = run?.cancelRequestedAt
        ? RUN_STATUS.cancelled
        : failed || rateLimited || blocked ? RUN_STATUS.failed : RUN_STATUS.succeeded;
      let outcome = {};
      if (status === RUN_STATUS.failed) {
        // Being turned away comes first: a site that will not let the crawler in explains
        // everything else that went wrong with the run.
        if (blocked) outcome = { error: blockedRunError(run.block, skippedBlocked + pagesBlocked) };
        else if (rateLimited) outcome = { error: rateLimitedRunError(run.throttle, skippedRateLimited) };
        else outcome = { error: { code: "JOBS_FAILED", message: `${failed} job(s) were dead-lettered.` } };
      }
      const finished = await ledger.finish(job.runId, status, outcome);

      await createEventOutbox({ events: collections.events }).publish([{
        type: EVENT_TYPES.crawlCompleted,
        siteId,
        workspaceId: siteDocument.workspaceId,
        runId: job.runId,
        data: {
          status,
          deadLetteredJobs: failed,
          // Whether the run saw the whole site travels with the summary, so a consumer never has
          // to infer completeness from counters that look the same either way.
          complete,
          pagesSkippedNoBudget: skippedNoBudget,
          rateLimited,
          pagesSkippedRateLimited: skippedRateLimited,
          blocked,
          pagesBlocked: skippedBlocked + pagesBlocked,
          // The run's own counters are the crawl's summary, so a consumer needs no second read
          // to know how large the crawl was or what it found.
          counters: { ...(finished?.counters ?? run?.counters ?? {}), ...counters },
          durationMs: finished?.durationMs ?? null,
        },
      }]);
    }

    // The crawl has just rewritten whatever pages changed, and this is where the crawler calls the
    // Library agent: one hand-off per crawl, naming the site, not one per page. Which pages moved
    // is the Library's own question — a content-hash comparison — and it cannot be asked page by
    // page as they are fetched, because what a page should become depends on facts only settled
    // above: its duplicate group, its route, how many pages link to it.
    //
    // Queued here rather than left to a scheduler's next tick because this is the moment it is
    // known, and it is the crawler enqueueing its own follow-up work, which is how every other
    // hand-off in this system is made. The keys are the run, so a retried finalize adds nothing.
    //
    // Two stages rather than a chain: a workspace with no embedding key still gets its pages
    // copied into the Library, and a workspace with no Qdrant does too. Neither should be able to
    // take the other down with it. The third stage, rewriting the Library from the pages chosen
    // for it, follows from the copy itself once it settles.
    const follow = job.runId ? job.runId.toHexString() : siteId.toHexString();
    const handOff = { workspaceId: siteDocument.workspaceId, siteId };
    return {
      counters,
      enqueue: [
        libraryJob(LIBRARY_JOBS.embed, { ...handOff, idempotencyKey: `index:after-crawl:${follow}` }),
        libraryJob(LIBRARY_JOBS.mirror, { ...handOff, idempotencyKey: `sources:after-crawl:${follow}` }),
      ],
    };
  };
}

/**
 * Folds duplicate URLs into groups and labels every URL with its route pattern.
 *
 * Both answers are properties of the site rather than of any one page, so both are computed once
 * per crawl over everything known, and written back onto the registry where every later read — the
 * route tree, the page list, the counts a person is shown — can use them without recomputing.
 *
 * @returns {Promise<{duplicates: number, uniquePages: number, patterns: number}>}
 */
async function describeSiteShape(collections, siteId) {
  const rows = await collections.urls
    .find({ siteId })
    .project({ urlHash: 1, url: 1, discoveredBy: 1 })
    .toArray();
  if (!rows.length) return { duplicates: 0, uniquePages: 0, patterns: 0 };

  const inbound = await inboundCounts(collections.links, siteId);
  const latest = await latestSnapshots(collections.snapshots, siteId);

  const pages = rows.map((row) => {
    const snapshot = latest.get(row.urlHash);
    return {
      urlHash: row.urlHash,
      url: row.url,
      status: snapshot?.status ?? null,
      // A redirect chain that lands somewhere else is the strongest duplicate signal there is.
      finalUrlHash: snapshot?.finalUrl && snapshot.finalUrl !== row.url ? hashUrl(snapshot.finalUrl) : null,
      canonicalHash: snapshot?.canonicalUrl ? hashUrl(snapshot.canonicalUrl) : null,
      selfCanonical: snapshot?.selfCanonical,
      textHash: snapshot?.textHash ?? null,
      wordCount: snapshot?.wordCount ?? 0,
      inbound: inbound.get(row.urlHash) ?? 0,
      inSitemap: (row.discoveredBy ?? []).includes("sitemap"),
    };
  });

  const grouped = groupDuplicates(pages);
  const patterns = derivePatterns(pages.map((entry) => pathOf(entry.url)));

  const operations = pages.map((entry) => {
    const group = grouped.get(entry.urlHash);
    const path = pathOf(entry.url);
    const segments = path.split("/").filter(Boolean);
    return {
      updateOne: {
        filter: { siteId, urlHash: entry.urlHash },
        update: {
          $set: {
            groupKey: group.groupKey,
            variantOf: group.variantOf,
            variantReason: group.reason,
            routePattern: patterns.get(path) ?? path,
            // Stored so the route tree can ask for one branch rather than reading the whole site
            // and filtering in memory.
            pathSegments: segments,
            pathDepth: segments.length,
            inboundCount: entry.inbound,
          },
        },
      },
    };
  });

  for (let offset = 0; offset < operations.length; offset += BATCH_SIZE) {
    await collections.urls.bulkWrite(operations.slice(offset, offset + BATCH_SIZE), { ordered: false });
  }

  const duplicates = [...grouped.values()].filter((entry) => entry.variantOf).length;
  return {
    duplicates,
    uniquePages: pages.length - duplicates,
    patterns: new Set(patterns.values()).size,
  };
}

/** Counts internal links pointing at each URL, which is what decides a group's representative. */
async function inboundCounts(links, siteId) {
  const counts = new Map();
  const cursor = links.aggregate([
    { $match: { siteId, internal: true } },
    { $group: { _id: { from: "$fromUrlHash", to: "$toUrlHash" } } },
    { $group: { _id: "$_id.to", pages: { $sum: 1 } } },
  ]);
  for await (const row of cursor) counts.set(row._id, row.pages);
  return counts;
}

/**
 * Reads the most recent snapshot of every URL, whichever run produced it.
 *
 * Per URL rather than per run because a crawl no longer necessarily covers the whole site: with a
 * monthly budget, the newest picture of a page may come from last month, and grouping only what
 * this run happened to fetch would forget every duplicate it did not revisit.
 */
async function latestSnapshots(snapshots, siteId) {
  const latest = new Map();
  const cursor = snapshots.aggregate([
    { $match: { siteId } },
    { $sort: { fetchedAt: -1 } },
    {
      $group: {
        _id: "$urlHash",
        status: { $first: "$status" },
        finalUrl: { $first: "$finalUrl" },
        canonicalUrl: { $first: "$canonicalUrl" },
        selfCanonical: { $first: "$selfCanonical" },
        textHash: { $first: "$extracted.textHash" },
        wordCount: { $first: "$extracted.wordCount" },
      },
    },
  ]);
  for await (const row of cursor) latest.set(row._id, row);
  return latest;
}

/** Reads a URL's path, falling back to the raw string when it cannot be parsed. */
function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Runs a breadth-first search from the seed over the site's internal links.
 *
 * The whole edge list is loaded into memory. At the scale this system targets — sites up to
 * ~50,000 URLs — that is a few million small entries and comfortably cheaper than the thousands
 * of round trips a database-side traversal would cost. A larger site would need a different
 * approach, and this is the function that would have to change.
 *
 * @returns {Promise<Map<string, number>>} URL hash to shortest link distance from the seed
 */
async function computeDepths(links, siteId, seedHash) {
  const adjacency = new Map();
  const cursor = links.find({ siteId, internal: true }).project({ fromUrlHash: 1, toUrlHash: 1 });
  for await (const edge of cursor) {
    let targets = adjacency.get(edge.fromUrlHash);
    if (!targets) {
      targets = new Set();
      adjacency.set(edge.fromUrlHash, targets);
    }
    targets.add(edge.toUrlHash);
  }

  const depths = new Map([[seedHash, 0]]);
  let frontier = [seedHash];
  let distance = 0;
  while (frontier.length) {
    distance += 1;
    const next = [];
    for (const hash of frontier) {
      for (const target of adjacency.get(hash) ?? []) {
        if (depths.has(target)) continue;
        depths.set(target, distance);
        next.push(target);
      }
    }
    frontier = next;
  }
  return depths;
}

/** Writes computed depths onto the registry in bounded batches. */
async function applyDepths(urls, siteId, depths) {
  const entries = [...depths.entries()];
  let updated = 0;
  for (let offset = 0; offset < entries.length; offset += BATCH_SIZE) {
    const operations = entries.slice(offset, offset + BATCH_SIZE).map(([urlHash, depth]) => ({
      updateOne: { filter: { siteId, urlHash }, update: { $set: { depth } } },
    }));
    const result = await urls.bulkWrite(operations, { ordered: false });
    updated += result.modifiedCount ?? 0;
  }
  return updated;
}

/**
 * Marks in-scope pages the seed cannot reach by following internal links.
 *
 * An orphan is a real finding: the page exists and may even be in the sitemap, but no internal
 * link points at it, so neither a crawler following links nor a visitor browsing the site will
 * arrive there. Recording it as a flag rather than deleting the row keeps the page crawlable
 * while making the problem queryable.
 *
 * Only ever called for a run that saw the whole site. The conclusion this draws — nothing links
 * here — is only available to a crawl that looked everywhere, and on a partial run it would flag
 * every page the crawl simply had not reached yet. The previous verdict is left standing instead,
 * which is stale at worst rather than wrong.
 */
async function markOrphans(urls, siteId, depths) {
  const reachable = [...depths.keys()];
  const result = await urls.updateMany(
    { siteId, inScope: true, urlHash: { $nin: reachable } },
    { $set: { orphan: true } },
  );
  await urls.updateMany({ siteId, urlHash: { $in: reachable } }, { $set: { orphan: false } });
  return result.modifiedCount ?? 0;
}
