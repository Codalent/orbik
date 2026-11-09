import { CRAWLER_AGENT, CRAWLER_JOBS } from "../jobs.js";
import { AgentError, requireObjectId } from "../runtime/errors.js";
import { computeIndexability } from "./indexability.js";
import { createCrawlBudget } from "@orbik/crawl-budget";
import { createEventOutbox, EVENT_TYPES } from "../runtime/eventOutbox.js";
import { createScope } from "./scope.js";
import { createUrlRegistry, DISCOVERY_SOURCES, URL_STATE } from "./urlRegistry.js";
import { extractPage, parseXRobotsTag } from "./extract.js";
import { toMarkdown } from "./markdown.js";
import { describePageKind, getAgentCollections } from "@orbik/core";
import { loadRobotsForSite } from "./robotsStore.js";
import { parseSiteConfig } from "./siteConfig.js";
import { recrawlPriority } from "./priority.js";
import { detectSiteBlock, isRunBlocked, recordBlocked, recordNotBlocked } from "./siteBlock.js";
import {
  canRetry,
  isRunRateLimited,
  rateLimitedError,
  recordServed,
  recordThrottled,
  THROTTLE_STATUSES,
} from "./throttle.js";
import { tryNormalizeUrl } from "./url.js";

/** Retry delay when a throttled response arrives through a fetcher that reports no hold. */
const FALLBACK_RETRY_MS = 30_000;

/**
 * Builds the crawler's fetch step: retrieve one URL and record everything observable about it.
 *
 * One job per URL rather than one job per crawl. A 5,000-page site is 5,000 independently
 * retryable units, so a single slow page cannot fail a whole crawl and a resumed crawl repeats
 * only what it had not finished.
 *
 * @param {object} dependencies collaborators
 * @param {(config: object) => {fetch: Function}} dependencies.createFetcherFor builds a site's HTTP client
 * @returns {(job: object, context: object) => Promise<object>} the `crawler.fetch` handler
 */
export function createFetchHandler({ createFetcherFor }) {
  return async function fetchPage(job, { database, signal, logger }) {
    const collections = getAgentCollections(database);
    const siteId = requireObjectId(job.payload?.siteId ?? job.siteId, "siteId");
    const urlHash = job.payload?.urlHash;
    if (typeof urlHash !== "string" || !/^[0-9a-f]{64}$/.test(urlHash)) {
      throw new AgentError({ code: "INVALID_JOB", message: "urlHash must be a 64-character hex digest." });
    }

    const siteDocument = await collections.sites.findOne({ _id: siteId });
    if (!siteDocument) {
      throw new AgentError({ code: "SITE_NOT_FOUND", message: `Site ${siteId.toHexString()} does not exist.` });
    }
    const config = parseSiteConfig(siteDocument);
    const registry = createUrlRegistry({ urls: collections.urls });

    const record = await registry.find(siteId, urlHash);
    if (!record) {
      // The registry is written before any fetch job is queued, so a missing row means the job
      // outlived its site's data. Retrying cannot recreate it.
      throw new AgentError({ code: "URL_NOT_REGISTERED", message: "The URL is not in this site's registry." });
    }

    // One fetch of a page per run. Several jobs of a run are in flight at once, and a page can be
    // queued a second time in the gap between its fetch finishing, which frees its key, and a
    // page that links to it — read a moment earlier — queueing what it found. The second job
    // costs nothing: no request, no charge. It still queues what the page links to, from the
    // links on record, because the other way to arrive here is a retry of the fetch itself after
    // a crash that came between recording the page and queueing its follow-ups.
    if (sameRun(record.lastRunId, job.runId)) {
      return {
        counters: { pagesAlreadyFetched: 1 },
        enqueue: await queueStoredLinks({ collections, registry, job, siteId, urlHash }),
      };
    }

    // Checked before robots.txt, not just before the page: once the site has made clear it wants
    // no more requests, a robots.txt refresh is one more request it does not want.
    if (await isRunRateLimited(collections.runs, job.runId)) {
      return { counters: await countSkipOnce(collections.urls, job, record, "pagesSkippedRateLimited"), enqueue: [] };
    }
    // The same for a site that will not let the crawler in at all.
    if (await isRunBlocked(collections.runs, job.runId)) {
      return { counters: await countSkipOnce(collections.urls, job, record, "pagesSkippedBlocked"), enqueue: [] };
    }

    const scope = createScope(config);
    const fetcher = createFetcherFor(config);
    const { rules } = await loadRobotsForSite({
      robots: collections.robots,
      fetcher,
      siteId,
      config,
      runId: job.runId,
      signal,
    });

    const target = new URL(record.url);
    if (!scope.allows(target, record.depth ?? 0).allowed || !rules.allows(target.pathname + target.search)) {
      return { counters: { pagesSkippedPolicy: 1 } };
    }

    // Charged before the request goes out, never after. The cost this page imposes — on the
    // target's server and on Orbik — is incurred by *making* the request, so an account with
    // nothing left must be stopped before it sends one, not billed once the bytes have arrived.
    // A conditional request that comes back 304 still counts: it was a real request to a real
    // server, and treating "unchanged" as free would let a large site be re-checked without limit.
    const workspaceId = job.workspaceId ?? siteDocument.workspaceId;
    // A host inside a hold is not charged for: the fetcher would refuse to send anyway, and a
    // charge followed by a refund is two ledger writes to record that nothing happened.
    const held = fetcher.holdRemainingMs?.(record.url) ?? 0;
    if (held > 0) throw rateLimitedError({ url: record.url, retryAfterMs: held });

    const budget = createCrawlBudget({ database });
    const charge = await budget.consume({ workspaceId, pages: 1 });
    if (!charge.ok) {
      // Not an error: an exhausted allowance is a state the account is legitimately in, and
      // failing the job would dead-letter thousands of pages and report the month's limit as a
      // crawler fault. The page stays in the registry, unfetched, and the next run picks it up.
      //
      // It is still read for its links, for free, unless this run's discovery pass has done that
      // already. A crawl that finds its pages while fetching them has not looked past the ones it
      // could not pay for, and what lies beyond them would otherwise be unknown rather than
      // unfetched. Each page explored this way queues the same for the pages it links to, so the
      // rest of the site is walked the way the discovery pass would have walked it.
      return {
        counters: await countSkipOnce(collections.urls, job, record, "pagesSkippedNoBudget"),
        enqueue: job.runId && !sameRun(record.lastExploredRunId, job.runId)
          ? [discoveryJob({ siteId, runId: job.runId, urlHash, priority: job.priority })]
          : [],
      };
    }

    let response;
    // Redirects that loop, or never end, are the site's fault and a finding about the page, the
    // way a 500 is. Failing the job for them would dead-letter it, fail the run over one broken
    // address, and leave the address unfetched for every page that links to it to queue again.
    let redirectsUnresolved = false;
    try {
      response = await fetcher.fetch(record.url, {
        etag: record.etag ?? undefined,
        lastModified: record.lastModified ?? undefined,
        hostDelayMs: rules.crawlDelay ? rules.crawlDelay * 1000 : undefined,
        signal,
      });
    } catch (error) {
      if (error?.code === "TOO_MANY_REDIRECTS" && error.response) {
        // Recorded from the last redirect the server sent. The charge stands: the server answered.
        response = error.response;
        redirectsUnresolved = true;
      } else {
        // The charge bought a page that was never delivered, so it goes back. Without this a site
        // that times out on every request would burn a month's allowance having fetched nothing.
        await budget.refund({ workspaceId, pages: 1, period: charge.period });
        throw error;
      }
    }

    // A bot-protection page is not the page, whatever status it came with, and neither is a home
    // page that answers 401 or 403. Nothing is stored for it: the snapshot and Markdown already on
    // record — the page as it was last actually read — are worth more than a copy of the challenge,
    // which the Library would otherwise take for the page's new content. The charge goes back
    // because nothing was served, and the URL stays unfetched for the next crawl.
    const block = detectSiteBlock(response);
    const seed = urlHash === scope.seed.hash;
    if (block && (block.kind === "challenge" || seed)) {
      await budget.refund({ workspaceId, pages: 1, period: charge.period });
      const streak = await recordBlocked({ runs: collections.runs, runId: job.runId, block, url: record.url, seed });
      if (streak.aborted) {
        logger?.("warn", "crawler.blocked_by_site", {
          runId: job.runId ? String(job.runId) : null,
          siteId: siteId.toHexString(),
          host: target.host,
          status: block.status,
          kind: block.kind,
          service: block.service,
        });
      }
      return { counters: { pagesBlocked: 1 }, enqueue: [] };
    }
    await recordNotBlocked(collections.runs, job.runId);

    // A 429 or 503 is the server asking for a pause, and the fetcher has already granted one to
    // the whole host. This job goes back in the queue for the same interval, so it is retried
    // when the server said it could be rather than on the runtime's generic backoff — and the
    // charge goes back too, because the retry will pay again, and a page the server declined to
    // serve should not cost more than one it served. The exception is the last permitted attempt:
    // a page that is still refusing after every retry is recorded with the status it gave, the
    // way a 500 is, so a permanently broken page stays a finding rather than a dead-lettered job.
    if (THROTTLE_STATUSES.has(response.status)) {
      const streak = await recordThrottled({
        runs: collections.runs,
        runId: job.runId,
        status: response.status,
        url: record.url,
        retryAfterMs: response.retryAfterMs ?? null,
      });
      if (streak.aborted) {
        logger?.("warn", "crawler.rate_limited", {
          runId: job.runId ? String(job.runId) : null,
          siteId: siteId.toHexString(),
          host: target.host,
          status: response.status,
          consecutive: streak.consecutive,
        });
      }
      if (canRetry(job)) {
        await budget.refund({ workspaceId, pages: 1, period: charge.period });
        throw rateLimitedError({
          status: response.status,
          url: record.url,
          retryAfterMs: response.retryAfterMs ?? FALLBACK_RETRY_MS,
        });
      }
    } else {
      await recordServed(collections.runs, job.runId);
    }

    // A 304 means the page is byte-identical to the snapshot already stored. Re-extracting it
    // would produce the same result at the cost of the bandwidth the conditional request just
    // saved, so the previous verdict is carried forward instead.
    if (response.notModified) {
      await collections.urls.updateOne(
        { siteId, urlHash },
        { $set: { state: URL_STATE.crawled, lastCrawledAt: new Date(), lastStatus: 304, lastRunId: job.runId ?? null } },
      );
      // The page is unchanged, so its links are too — but they still have to be *followed*.
      // Returning here without queueing them would strand every page reachable only through an
      // unchanged one, and an incremental crawl of a stable site would fetch nothing but the seed.
      return {
        counters: { pagesNotModified: 1 },
        enqueue: await queueStoredLinks({ collections, registry, job, siteId, urlHash }),
      };
    }

    // The previous snapshot is read before the new one is written, so change detection compares
    // this crawl against the last one rather than against itself.
    const previous = await collections.snapshots.findOne(
      { siteId, urlHash, runId: { $ne: job.runId ?? null } },
      { sort: { fetchedAt: -1 } },
    );

    const finalUrl = tryNormalizeUrl(response.url, normalizeOptionsFor(config));
    const contentType = response.headers["content-type"] ?? null;
    const extracted = isHtml(contentType) ? extractPage(response.body, { url: response.url }) : null;

    const verdict = computeIndexability({
      status: response.status,
      url: finalUrl?.href ?? record.url,
      robotsAllowed: rules.allows(`${new URL(record.url).pathname}${new URL(record.url).search}`),
      metaRobots: extracted?.metaRobots ?? [],
      xRobotsTag: parseXRobotsTag(response.headers["x-robots-tag"]),
      canonical: extracted?.canonical ?? null,
      contentType,
      redirectCount: response.redirects.length,
      redirectsUnresolved,
    });

    // Links are recorded before the snapshot so the snapshot can carry what this page found. That
    // is what makes a live crawl readable — "fetched /pricing, found 3 new URLs" — from the rows
    // the crawler already writes, without a second event stream to keep in step with them.
    const discovered = extracted
      ? await recordLinks({ collections, registry, job, siteId, config, scope, rules, record, extracted })
      : { edges: 0, newUrls: 0, newEligible: 0, discoveredUrls: [], enqueue: [] };

    // The page's content as Markdown, written while the HTML is still in hand. Only a page that
    // was actually served: an error page's Markdown is the error, and a redirect's is somebody
    // else's page. A 304 never reaches here, so an unchanged page keeps what it has.
    if (extracted && response.status >= 200 && response.status < 300) {
      await saveMarkdown(collections.markdown, {
        siteId,
        urlHash,
        url: record.url,
        runId: job.runId ?? null,
        title: extracted.title ?? null,
        extracted,
        // Normalised as the crawler normalises, so a link in the text names the page it stored.
        conversion: toMarkdown(response.body, {
          url: response.url, extracted, fetchedAt: new Date(), normalizeOptions: normalizeOptionsFor(config),
        }),
      });
    }

    await writeSnapshot(collections.snapshots, {
      siteId,
      runId: job.runId ?? null,
      urlHash,
      url: record.url,
      finalUrl: finalUrl?.href ?? response.url,
      depth: record.depth ?? null,
      status: response.status,
      redirects: response.redirects,
      contentType,
      bytes: response.bytes,
      truncated: response.truncated,
      elapsedMs: response.elapsedMs,
      etag: response.headers.etag ?? null,
      lastModified: response.headers["last-modified"] ?? null,
      indexable: verdict.indexable,
      indexabilityReasons: verdict.reasons,
      canonicalUrl: verdict.canonicalUrl,
      selfCanonical: verdict.selfCanonical,
      extracted,
      discovered: {
        links: discovered.edges,
        newUrls: discovered.newUrls,
        // A handful of addresses, not all of them: this exists to be read as it scrolls past, and
        // a page linking to four hundred others would otherwise put four hundred URLs in a row.
        sample: discovered.discoveredUrls.slice(0, 5),
      },
      fetchedAt: new Date(),
    });

    const events = createEventOutbox({ events: collections.events });
    const changes = detectChanges({ previous, status: response.status, verdict, extracted, isFirstCrawl: !previous });
    await events.publish(changes.map((change) => ({
      type: change.type,
      siteId,
      workspaceId: job.workspaceId ?? siteDocument.workspaceId,
      runId: job.runId,
      urlHash,
      url: record.url,
      data: change.data,
    })));

    await collections.urls.updateOne(
      { siteId, urlHash },
      {
        $set: {
          state: URL_STATE.crawled,
          lastCrawledAt: new Date(),
          lastStatus: response.status,
          lastRunId: job.runId ?? null,
          indexable: verdict.indexable,
          // Validators are stored so the next run can ask the server whether anything changed
          // instead of downloading the page again.
          etag: response.headers.etag ?? null,
          lastModified: response.headers["last-modified"] ?? null,
        },
      },
    );

    return {
      counters: {
        pagesFetched: 1,
        [verdict.indexable ? "pagesIndexable" : "pagesNotIndexable"]: 1,
        ...(response.status >= 400 || redirectsUnresolved ? { pagesBroken: 1 } : {}),
        ...(response.redirects.length ? { pagesRedirected: 1 } : {}),
        linksFound: discovered.edges,
        urlsNew: discovered.newUrls,
        // Kept in step with the registry as pages are found. The fetching phase begins with the
        // count of URLs known then, and a crawl with no discovery pass finds most of its pages
        // after that.
        urlsDiscovered: discovered.newEligible,
        ...(changes.length ? { pagesChanged: 1 } : {}),
      },
      enqueue: discovered.enqueue,
    };
  };
}

/**
 * Queues the pages an unchanged page links to, using the link graph already on record.
 *
 * The stored edges are current by construction: they are replaced whenever the page is fetched or
 * explored, and a 304 means the page has not changed since that fetch.
 *
 * @param {object} input
 * @param {boolean} [input.discovery] queue the pages for exploring rather than fetching
 */
export async function queueStoredLinks({ collections, registry, job, siteId, urlHash, discovery = false }) {
  const edges = await collections.links
    .find({ siteId, fromUrlHash: urlHash, internal: true })
    .project({ toUrlHash: 1 })
    .toArray();
  if (!edges.length) return [];

  const pending = await registry.pendingForRun({
    siteId,
    runId: job.runId,
    discovery,
    hashes: [...new Set(edges.map((edge) => edge.toUrlHash))],
  });
  const build = discovery ? discoveryJob : fetchJob;
  return pending.map((row) =>
    build({ siteId, runId: job.runId, urlHash: row.urlHash, priority: recrawlPriority(row) }));
}

/** Whether a registry row's run stamp names the run a job belongs to. */
export function sameRun(stamp, runId) {
  return Boolean(stamp && runId) && String(stamp) === String(runId);
}

/**
 * Counts a page a run left unfetched, once per run however many jobs come for it.
 *
 * These counters are read as numbers of pages: "2,600 pages deferred". A page left unfetched has
 * no fetch on record, so it is queued again by every page that links to it and finishes later —
 * which, with several pages being read at once, the ones already in flight when the budget ran
 * out or the run was stopped all do. The registry row is stamped with the run at the first skip,
 * and only that one is counted.
 *
 * @param {import("mongodb").Collection} urls the `crawl_urls` collection
 * @param {object} job the fetch job
 * @param {object} record the page's registry row, as read when the job began
 * @param {string} counter which counter the skip belongs under
 * @returns {Promise<Record<string, number>>} the counters to report
 */
async function countSkipOnce(urls, job, record, counter) {
  if (!job.runId) return { [counter]: 1 };
  if (sameRun(record.lastSkippedRunId, job.runId)) return {};
  await urls.updateOne({ _id: record._id }, { $set: { lastSkippedRunId: job.runId } });
  return { [counter]: 1 };
}

/**
 * Compares this crawl of a page against the previous one and reports what changed.
 *
 * Change detection is what makes downstream agents affordable. Without it, every agent has to
 * re-examine every page after every crawl to find the handful that moved; with it, an agent reads
 * a short event stream and touches only what actually changed.
 *
 * Each dimension is a separate event because consumers care about different ones: a broken-links
 * report wants status changes, a content agent wants text changes, and neither wants to filter
 * the other's noise out of a single "page changed" signal.
 *
 * @returns {Array<{type: string, data: object}>} events to publish, empty when nothing changed
 */
function detectChanges({ previous, status, verdict, extracted, isFirstCrawl }) {
  if (isFirstCrawl) {
    return [{ type: EVENT_TYPES.pageDiscovered, data: { status, indexable: verdict.indexable } }];
  }

  const changes = [];
  if (previous.status !== status) {
    changes.push({ type: EVENT_TYPES.pageStatusChanged, data: { from: previous.status, to: status } });
  }
  if (previous.indexable !== verdict.indexable) {
    changes.push({
      type: EVENT_TYPES.pageIndexabilityChanged,
      data: { from: previous.indexable, to: verdict.indexable, reasons: verdict.reasons },
    });
  }
  if ((previous.canonicalUrl ?? null) !== (verdict.canonicalUrl ?? null)) {
    changes.push({
      type: EVENT_TYPES.pageCanonicalChanged,
      data: { from: previous.canonicalUrl ?? null, to: verdict.canonicalUrl ?? null },
    });
  }
  // Only compare text when both crawls produced some. A page that stopped being HTML has already
  // been reported as a status or indexability change, and calling that a content change too would
  // double-count one event as two.
  const previousHash = previous.extracted?.textHash ?? null;
  const currentHash = extracted?.textHash ?? null;
  if (previousHash && currentHash && previousHash !== currentHash) {
    changes.push({
      type: EVENT_TYPES.pageContentChanged,
      data: { wordCountFrom: previous.extracted?.wordCount ?? null, wordCountTo: extracted.wordCount },
    });
  }
  return changes;
}

/**
 * Stores a page's Markdown, once per change.
 *
 * The hash is compared before writing so a crawl of a stable site rewrites nothing: the row's
 * `updatedAt` then genuinely means "when the content last changed", which is what a reader of
 * the file wants to know. `renderedAt` says when it was last confirmed current.
 *
 * A few of the page's own claims about itself are stored beside the text: what kind of thing it
 * says it is (`og:type`, the JSON-LD types), its H1, and the dates it gives for publication and
 * last change. They are written here because the extraction is already in hand and the alternative
 * is a lookup into a snapshot for every row of every content listing — on a two-thousand-page
 * site, that is the difference between an agent being told "these forty routes are articles" and
 * being told nothing at all.
 *
 * The dates are what makes "skip a blog post nobody has touched in three years" a rule rather than
 * a guess. Nothing else stored answers it: `last-modified` is absent on most generated sites, and
 * a sitemap's `lastmod` is the date of the deployment.
 */
async function saveMarkdown(markdown, { siteId, urlHash, url, runId, title, extracted, conversion }) {
  const contentType = describePageKind({
    structuredDataTypes: extracted?.structuredDataTypes ?? [],
    openGraphType: extracted?.openGraph?.type ?? null,
  });
  const heading = extracted?.headings?.h1?.[0] ?? null;
  const publishedAt = extracted?.dates?.published ?? null;
  const modifiedAt = extracted?.dates?.modified ?? null;
  const now = new Date();
  const existing = await markdown.findOne({ siteId, urlHash }, { projection: { hash: 1 } });
  if (existing?.hash === conversion.hash) {
    // The content is unchanged, but the signals may not have been stored at all when this row was
    // first written, so they are refreshed even on a no-op render.
    await markdown.updateOne(
      { siteId, urlHash },
      {
        $set: {
          renderedAt: now, runId, contentType, heading, publishedAt, modifiedAt,
          structuredDataTypes: extracted?.structuredDataTypes ?? [],
        },
      },
    );
    return;
  }
  await markdown.updateOne(
    { siteId, urlHash },
    {
      $set: {
        url,
        title,
        runId,
        markdown: conversion.markdown,
        hash: conversion.hash,
        bytes: conversion.bytes,
        words: conversion.words,
        truncated: conversion.truncated,
        contentType,
        structuredDataTypes: extracted?.structuredDataTypes ?? [],
        heading,
        publishedAt,
        modifiedAt,
        updatedAt: now,
        renderedAt: now,
      },
      $setOnInsert: { siteId, urlHash, createdAt: now },
    },
    { upsert: true },
  );
}

/**
 * Writes the page snapshot, replacing any partial result from a previous attempt.
 *
 * An upsert rather than an insert because a fetch job that died after writing its snapshot will
 * be retried, and a second insert would leave two snapshots of the same page in the same run
 * disagreeing with each other.
 */
function writeSnapshot(snapshots, snapshot) {
  const { siteId, runId, urlHash, ...fields } = snapshot;
  return snapshots.updateOne(
    { siteId, runId, urlHash },
    { $set: { siteId, runId, urlHash, ...fields } },
    { upsert: true },
  );
}

/**
 * Registers the URLs a page links to, rebuilds its outbound edges, and queues what is new.
 *
 * The link graph is **replaced per page** rather than appended per run: the delete-then-insert
 * keeps storage bounded by the size of the site instead of by the number of crawls, and the graph
 * always reflects the latest fetch of every page. The trade-off is that historical link diffs are
 * not available; adding them later means keeping edges per run and pruning old ones on a schedule.
 */
export async function recordLinks({ collections, registry, job, siteId, config, scope, rules, record, extracted, discovery = false }) {
  const normalizeOptions = normalizeOptionsFor(config);
  const depth = Number.isInteger(record.depth) ? record.depth + 1 : null;
  const targets = new Map();
  const edges = [];

  for (const link of extracted.links) {
    const normalized = tryNormalizeUrl(link.href, { base: record.url, ...normalizeOptions });
    if (!normalized) continue;

    const decision = scope.allows(normalized, depth ?? 0);
    const internal = decision.reason !== "OUT_OF_SCOPE_HOST";
    edges.push({
      siteId,
      fromUrlHash: record.urlHash,
      toUrlHash: normalized.hash,
      toUrl: normalized.href,
      anchor: link.anchor,
      rel: link.rel,
      nofollow: link.nofollow,
      internal,
      updatedAt: new Date(),
    });

    // An address on another host is recorded as an edge and nothing more. It is a fact about this
    // page — "it links out here" — but it is not one of this site's URLs, and registering it would
    // fill the registry with the outbound web and count somebody else's pages as this site's. A
    // subdomain is another host by the same rule: it is a separate site with its own workspace.
    if (!internal) continue;

    if (targets.has(normalized.hash)) continue;
    const allowed = rules.allows(`${normalized.pathname}${normalized.search}`);
    targets.set(normalized.hash, {
      url: normalized.href,
      hash: normalized.hash,
      host: normalized.host,
      source: DISCOVERY_SOURCES.link,
      // Depth is the parent's depth plus one. Because the frontier is drained shallowest-first
      // and the registry keeps the minimum, this converges on the true shortest path from the
      // seed without a separate graph traversal.
      depth,
      inScope: decision.allowed,
      scopeReason: decision.reason ?? null,
      robotsAllowed: allowed,
    });
  }

  await collections.links.deleteMany({ siteId, fromUrlHash: record.urlHash });
  if (edges.length) await collections.links.insertMany(edges, { ordered: false });

  // Every discovered URL is registered, without a cap. Discovery is free — it is what tells an
  // owner how large their site actually is — and the monthly crawl budget limits what is
  // *fetched*, one page at a time, at the moment each fetch is about to happen. A site larger
  // than the remaining allowance is therefore fully known and partly crawled, rather than partly
  // known, which is the difference between "we have not got to these yet" and "these do not
  // exist as far as we can tell".
  const entries = [...targets.values()];

  const written = entries.length
    ? await registry.record({ siteId, workspaceId: job.workspaceId, runId: job.runId, entries })
    : { inserted: 0, insertedHashes: [] };
  // Which URLs are new is taken from the write, not counted: the live log needs their addresses
  // — "found /pricing and 3 others" — and when several pages are read at once, only the write
  // knows which of them was first to a URL they all link to.
  const inserted = new Set(written.insertedHashes);
  const firstSeen = entries.filter((entry) => inserted.has(entry.hash));
  const discoveredUrls = firstSeen.map((entry) => entry.url);

  // The registry, not this page's view, decides what still needs fetching: a page linked from
  // here may already have been crawled earlier in the same run.
  const pending = await registry.pendingForRun({
    siteId,
    runId: job.runId,
    discovery,
    hashes: entries.filter((entry) => entry.inScope && entry.robotsAllowed).map((entry) => entry.hash),
  });

  return {
    edges: edges.length,
    newUrls: written.inserted,
    // Of the new URLs, the ones a crawl may fetch: what "URLs known" counts.
    newEligible: firstSeen.filter((entry) => entry.inScope && entry.robotsAllowed).length,
    discoveredUrls,
    enqueue: pending.map((row) =>
      fetchJob({ siteId, runId: job.runId, urlHash: row.urlHash, priority: recrawlPriority(row) })),
  };
}

/**
 * Builds one `crawler.fetch` job.
 *
 * The idempotency key is scoped to the run and the URL, so a page linked from twenty others is
 * fetched once per run, and the next run is free to fetch it again.
 */
export function fetchJob({ siteId, runId, urlHash, priority }) {
  return {
    agent: CRAWLER_AGENT,
    type: CRAWLER_JOBS.fetch,
    payload: { siteId: siteId.toHexString(), urlHash },
    priority,
    idempotencyKey: `fetch:${runId ?? "manual"}:${urlHash}`,
  };
}

/**
 * Builds one `crawler.discover-page` job: read a page for its links, free of charge.
 *
 * Keyed like a fetch, by run and URL, so a page is explored once per run however many pages link
 * to it.
 */
export function discoveryJob({ siteId, runId, urlHash, priority = 0 }) {
  return {
    agent: CRAWLER_AGENT,
    type: CRAWLER_JOBS.discoverPage,
    payload: { siteId: String(siteId), urlHash },
    priority,
    idempotencyKey: `discover-page:${runId}:${urlHash}`,
  };
}

/** Builds the normalization policy from a site's configuration. */
function normalizeOptionsFor(config) {
  return {
    stripParams: config.stripParams,
    keepTrackingParams: config.keepTrackingParams,
    sortQuery: config.sortQuery,
  };
}

/** Reports whether a content type describes an HTML document worth extracting. */
function isHtml(contentType) {
  const value = String(contentType ?? "").toLowerCase();
  return value.includes("text/html") || value.includes("application/xhtml+xml");
}
