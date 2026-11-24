import { WEBSITE_SOURCE, describeSource, effectiveIntervalHours, isWwwPair, patternIntervalHours } from "@orbik/core";
import { BUDGET_STATE } from "@orbik/crawl-budget";

import { AppError } from "../errors/appError.js";
import { toPageSummary, toRunSummary, toSiteSummary } from "../repositories/crawlRepository.js";
import { listRoutePages, listRoutePatterns } from "../repositories/crawlRouteRepository.js";
import { createWorkspaceAccessCheck } from "./workspaceAccess.js";

/** Runs the API will report as "a crawl is happening right now". */
const ACTIVE_STATUS = "running";

/**
 * Creates crawl configuration and reporting use cases, for the people who can open the workspace.
 *
 * Every method starts from the workspace access check, with the role the operation needs, rather
 * than from the crawl site itself. A site identifier is not an authorization token: reaching the crawl data through the
 * workspace means a user who guesses another workspace's site identifier is refused by the same
 * check that protects the workspace, instead of by a second one that could drift out of step.
 *
 * @param {object} dependencies collaborators
 * @param {object} dependencies.workspaceRepository workspace access by owner or membership
 * @param {object} dependencies.crawlRepository crawl dataset access
 * @param {object} dependencies.crawlBudget the workspace's monthly page-fetch allowance
 * @param {import("mongodb").Db} dependencies.database for `listRoutePatterns` and `listRoutePages`
 * @param {() => Date} [dependencies.now] clock; defaults to the system clock
 */
export function createCrawlService({ workspaceRepository, crawlRepository, crawlBudget, database, now = () => new Date() }) {
  const requireWorkspaceAccess = createWorkspaceAccessCheck(workspaceRepository);

  /**
   * Refuses sitemaps that describe some other site than the one being crawled.
   *
   * Checked here rather than in the validator because only this layer knows the effective seed: an
   * absent one falls back to the workspace's own website, and the rule is about the site actually
   * being crawled. A sitemap on another hostname lists another site's pages, and following it
   * would both fold a second site's URLs into this workspace's totals and let operator input aim
   * the crawler's first outbound requests at a host of its choosing.
   *
   * The start address's `www.` twin is not another hostname for this purpose. The crawler moves
   * the start address between the two when one only redirects to the other, so a sitemap may be
   * named under either spelling, before or after that move; `parseSiteConfig` in the agents
   * applies the same rule to what is stored.
   */
  function requireSitemapsOnSeedHost(seedUrl, sitemapUrls) {
    if (!sitemapUrls?.length) return;
    const host = new URL(seedUrl).hostname;
    const foreign = sitemapUrls.filter((url) => {
      const named = new URL(url).hostname;
      return named !== host && !isWwwPair(named, host);
    });
    if (!foreign.length) return;
    const twin = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
    throw new AppError({
      status: 400,
      code: "VALIDATION_FAILED",
      message: "Request validation failed.",
      fields: foreign.map((url) => ({
        field: "sitemapUrls",
        code: "INVALID",
        message: `${url} is not on ${host} or ${twin}. A sitemap on another hostname describes another site.`,
      })),
    });
  }

  /**
   * Refuses to ask for a crawl that could not fetch a single page.
   *
   * A crawl asked for with nothing to pay for its pages would sit on the page as "queued" and then
   * end having read nothing a person can see, so it is refused here, with the reason, instead. The
   * two reasons are worded apart on purpose: a plan that includes no crawl pages is not a month
   * whose pages are used up, and only the second can promise a date crawling comes back by itself.
   * With no limit set — the open-source edition — this never refuses.
   */
  async function requireCrawlBudget(workspace) {
    const budget = await crawlBudget.statusFor({ workspaceId: workspace._id });
    if (budget.state === BUDGET_STATE.notIncluded) {
      throw new AppError({
        status: 403,
        code: "CRAWL_NOT_INCLUDED",
        message: budget.resumesAt
          ? `This workspace's plan includes no crawl pages this month, so no page can be fetched. Crawling can start ${formatDay(budget.resumesAt)}.`
          : "This workspace's plan includes no crawl pages, so no page can be fetched.",
      });
    }
    if (budget.state === BUDGET_STATE.spent) {
      throw new AppError({
        status: 409,
        code: "CRAWL_BUDGET_SPENT",
        message: `This month's ${budget.allowance.toLocaleString("en-US")} crawl pages are spent, so no page can be fetched.${budget.resumesAt ? ` Crawling resumes ${formatDay(budget.resumesAt)}.` : ""}`,
      });
    }
  }

  /**
   * Resolves the workspace and one of its sources — its website unless a source is named —
   * requiring it to exist. A source of another workspace is not found, as a missing one is not.
   */
  async function requireSite(userId, workspaceId, role, sourceId) {
    const workspace = await requireWorkspaceAccess(userId, workspaceId, { role });
    const site = await crawlRepository.findSource(workspace._id, sourceId);
    if (!site) throw missingSource(sourceId);
    return { workspace, site };
  }

  /** The answer for a source that is not there: the website not set up, or no such source. */
  function missingSource(sourceId) {
    if (sourceId && sourceId !== WEBSITE_SOURCE) {
      return new AppError({ status: 404, code: "SOURCE_NOT_FOUND", message: "This workspace has no such source." });
    }
    return new AppError({ status: 404, code: "CRAWL_NOT_CONFIGURED", message: "This workspace has no crawl configuration yet." });
  }

  return {
    /**
     * Returns the workspace's crawl configuration together with enough state to render a status.
     *
     * A workspace with no configuration is a normal, expected state rather than an error: it is
     * what every workspace looks like before its first crawl is set up, so the endpoint reports
     * `site: null` and lets the interface offer setup instead of an error page.
     */
    async getOverview({ userId, workspaceId, sourceId }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      const site = await crawlRepository.findSource(workspace._id, sourceId);
      // A source that is not there is an error; a website not set up yet is a state.
      if (!site && sourceId && sourceId !== WEBSITE_SOURCE) throw missingSource(sourceId);

      // The budget is reported whether or not crawling is set up. It is the workspace's rather
      // than any one site's, so somebody deciding whether to crawl another site from it needs to
      // see what is left before they configure it, not after.
      const budget = await crawlBudget.statusFor({ workspaceId: workspace._id });

      if (!site) {
        return {
          site: null,
          activeRun: null,
          latestRun: null,
          urls: { total: 0, eligible: 0, orphans: 0, duplicates: 0, broken: 0, pages: 0 },
          budget,
          defaults: { seedUrl: workspace.websiteUrl },
        };
      }

      const [activeRun, latestRun, urls] = await Promise.all([
        crawlRepository.findActiveRun(site._id),
        crawlRepository.findLatestRun(site._id),
        crawlRepository.summarizeUrls(site._id),
      ]);

      const described = describeSource(site);
      return {
        site: toSiteSummary(site),
        // Which source this is, for a page that shows any of them.
        source: { id: site._id.toHexString(), name: described.name, primary: described.primary, relation: described.relation, mode: described.mode },
        activeRun: activeRun ? toRunSummary(activeRun) : null,
        latestRun: latestRun ? toRunSummary(latestRun) : null,
        // Asked for, not yet started: the scheduler picks a due site up on its next pass, which
        // can be up to a minute away, and the page must say "queued" for that minute — through a
        // reload — rather than offer the button again.
        queued: Boolean(site.crawlRequestedAt) && !activeRun,
        urls,
        budget,
        defaults: { seedUrl: workspace.websiteUrl },
      };
    },

    /**
     * Creates or replaces the workspace's crawl configuration.
     *
     * The seed URL defaults to the workspace's own website, because a workspace already records
     * the site it is about and asking for it twice invites the two to disagree.
     */
    async saveSite({ userId, workspaceId, seedUrl, settings }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "member" });
      const effectiveSeedUrl = seedUrl ?? workspace.websiteUrl;
      requireSitemapsOnSeedHost(effectiveSeedUrl, settings.sitemapUrls);
      // The first save is also the first crawl's request, so it is refused when that crawl could
      // fetch nothing; later saves only change settings and are always accepted.
      if (!(await crawlRepository.findSiteByWorkspace(workspace._id))) await requireCrawlBudget(workspace);
      const site = await crawlRepository.upsertSite({
        workspaceId: workspace._id,
        seedUrl: effectiveSeedUrl,
        settings,
        now: now(),
        // Setting a site up asks for its first crawl, so whoever set it up started that crawl.
        startedBy: userId,
      });
      return { site: toSiteSummary(site) };
    },

    /**
     * Asks for a crawl to start as soon as the scheduler's next pass runs.
     *
     * A crawl already in progress is reported rather than queued twice: two overlapping crawls of
     * one site would double its outbound request rate and produce two runs writing the same
     * snapshots.
     *
     * A fresh crawl asks for every page, not only the due ones, and forgets the cached versions
     * so nothing comes back "unchanged": every page is fetched and read in full again. History is
     * kept — it is a new reading of the site, not a new site.
     */
    async requestCrawl({ userId, workspaceId, sourceId, fresh = false }) {
      const { workspace, site } = await requireSite(userId, workspaceId, "member", sourceId);
      const activeRun = await crawlRepository.findActiveRun(site._id);
      if (activeRun) {
        return { status: ACTIVE_STATUS, run: toRunSummary(activeRun), alreadyRunning: true, fresh: false, pages: 0 };
      }
      await requireCrawlBudget(workspace);

      const pages = fresh ? await crawlRepository.requestFreshCrawl(site._id, now()) : 0;
      const marked = await crawlRepository.requestCrawlNow(site._id, now(), userId);
      if (!marked) {
        throw new AppError({ status: 404, code: "CRAWL_NOT_CONFIGURED", message: "This workspace has no crawl configuration yet." });
      }
      return { status: "queued", run: null, alreadyRunning: false, fresh, pages };
    },

    /**
     * Deletes everything crawled for the workspace's site, keeping its settings.
     *
     * Refused while a crawl is running: the workers would keep writing pages into a registry
     * that had just been emptied, and what was left would be neither the old crawl nor a new one.
     */
    async clearData({ userId, workspaceId, sourceId }) {
      const { site } = await requireSite(userId, workspaceId, "admin", sourceId);
      if (await crawlRepository.findActiveRun(site._id)) {
        throw new AppError({
          status: 409,
          code: "CRAWL_RUNNING",
          message: "A crawl is running. Wait for it to finish before clearing its data.",
        });
      }
      return { pages: await crawlRepository.clearSiteData(site._id) };
    },

    /**
     * Stops the source's crawl that is running: the pages it has not read yet are left for the
     * next one, and what it read stays. A crawl that has not started yet is simply no longer asked
     * for. Answers what there was to stop.
     */
    async stopCrawl({ userId, workspaceId, sourceId }) {
      const { site } = await requireSite(userId, workspaceId, "member", sourceId);
      const activeRun = await crawlRepository.findActiveRun(site._id);
      if (activeRun) {
        await crawlRepository.requestStop(activeRun._id, now());
        return { stopped: "running", run: toRunSummary(activeRun) };
      }
      const withdrawn = await crawlRepository.withdrawRequest(site._id);
      return { stopped: withdrawn ? "queued" : null, run: null };
    },

    /**
     * Reports how often each route pattern is crawled, and where that decision came from.
     *
     * Every pattern the registry knows is listed, not only the ones the AI decided about. The
     * difference is the point: a pattern with no decision is never recrawled, and the only way
     * that becomes visible — and fixable — is to show it next to the ones that have one.
     */
    async getSchedule({ userId, workspaceId, sourceId }) {
      const { site } = await requireSite(userId, workspaceId, "read-only", sourceId);
      const rows = await crawlRepository.listPatterns(site._id);
      const planned = new Map((site.crawlSchedule?.patterns ?? []).map((row) => [row.pattern, row]));
      const overrides = new Map((site.crawlScheduleOverrides ?? []).map((row) => [row.pattern, row]));
      return {
        status: site.crawlSchedule?.status ?? "pending",
        error: site.crawlSchedule?.error ?? null,
        model: site.crawlSchedule?.model ?? null,
        updatedAt: site.crawlSchedule?.updatedAt ? new Date(site.crawlSchedule.updatedAt).toISOString() : null,
        patterns: rows.map((row) => {
          const ai = planned.get(row._id);
          const override = overrides.get(row._id);
          return {
            pattern: row._id,
            pages: row.pages,
            pinnedPages: row.pinned,
            ai: ai ? { intervalHours: ai.intervalHours, reason: ai.reason } : null,
            override: override ? { intervalHours: override.intervalHours ?? null } : null,
            intervalHours: patternIntervalHours(site, row._id),
          };
        }),
      };
    },

    /**
     * Sets one crawl frequency on a selection of pages and folders.
     *
     * This is how frequencies are chosen: by a person, from the page list, for as many pages at
     * once as they like. Nothing is decided on their behalf — a page nobody has chosen for is
     * crawled only when they ask.
     */
    async setFrequencies({ userId, workspaceId, sourceId, targets, intervalHours }) {
      const { site } = await requireSite(userId, workspaceId, "member", sourceId);
      const pages = await crawlRepository.setFrequencyForTargets({ site, targets, intervalHours, now: now() });
      if (pages === 0) {
        throw new AppError({ status: 404, code: "PAGE_NOT_FOUND", message: "None of the selected pages are in the crawl." });
      }
      return { pages, intervalHours };
    },

    /** Lists the pages that have Markdown, as a library index. */
    async listMarkdown({ userId, workspaceId, sourceId, limit, skip }) {
      const { site } = await requireSite(userId, workspaceId, "read-only", sourceId);
      const { items, total } = await crawlRepository.listMarkdown({ siteId: site._id, limit, skip });
      return {
        items: items.map((row) => ({
          urlHash: row.urlHash,
          url: row.url,
          title: row.title ?? null,
          bytes: row.bytes,
          words: row.words ?? null,
          truncated: row.truncated === true,
          updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
        })),
        total,
        skip,
        limit,
      };
    },

    /**
     * A page's content as Markdown.
     *
     * Served as text rather than wrapped in JSON, so the same route works for a browser, a
     * download, and a script piping it somewhere.
     */
    async getPageMarkdown({ userId, workspaceId, sourceId, urlHash }) {
      const { site } = await requireSite(userId, workspaceId, "read-only", sourceId);
      const document = await crawlRepository.findMarkdown({ siteId: site._id, urlHash });
      if (!document) {
        throw new AppError({ status: 404, code: "MARKDOWN_NOT_FOUND", message: "This page has no Markdown yet. It is written when the page is next crawled." });
      }
      return { markdown: document.markdown, url: document.url, updatedAt: document.updatedAt };
    },

    /** Pins one page to its own crawl frequency, or returns it to its pattern's. */
    async setPageSchedule({ userId, workspaceId, sourceId, urlHash, override }) {
      const { site } = await requireSite(userId, workspaceId, "member", sourceId);
      const registry = await crawlRepository.findUrl({ siteId: site._id, urlHash });
      if (!registry) {
        throw new AppError({ status: 404, code: "PAGE_NOT_FOUND", message: "This page is not in the crawl." });
      }
      const updated = await crawlRepository.setUrlOverride({ site, urlHash, override, now: now() });
      return { schedule: toPageSchedule(site, updated) };
    },

    /**
     * Asks for one page, or every page of one route pattern, to be crawled on the next pass.
     *
     * This is the manual trigger that a frequency of "never" relies on: the pages are marked
     * wanted and the site is made due, and the scheduler starts the crawl exactly as it would
     * for the whole site.
     */
    async requestRecrawl({ userId, workspaceId, sourceId, target }) {
      const { workspace, site } = await requireSite(userId, workspaceId, "member", sourceId);
      await requireCrawlBudget(workspace);
      const pages = await crawlRepository.requestRecrawl({ siteId: site._id, target, now: now(), startedBy: userId });
      if (pages === 0) {
        throw new AppError({ status: 404, code: "PAGE_NOT_FOUND", message: target.urlHash ? "This page is not in the crawl." : "No page has this route pattern." });
      }
      const activeRun = await crawlRepository.findActiveRun(site._id);
      return { status: activeRun ? ACTIVE_STATUS : "queued", pages, alreadyRunning: Boolean(activeRun) };
    },

    /** Lists the workspace's recent crawl runs, newest first. */
    async listRuns({ userId, workspaceId, sourceId, limit }) {
      const { site } = await requireSite(userId, workspaceId, "read-only", sourceId);
      const runs = await crawlRepository.listRuns(site._id, limit);
      return { items: runs.map(toRunSummary) };
    },

    /**
     * Returns what the crawl is doing right now: the pages just fetched, and what they turned up.
     *
     * A crawl that has been asked for and shows nothing reads as broken. This is the feedback that
     * makes it legible — each entry is a page that was actually fetched, with the URLs it led to —
     * and it is assembled from the snapshots the crawler writes anyway rather than from a separate
     * log that could disagree with them.
     *
     * @param {object} options
     * @param {string} [options.before] ISO time to page back from, for older entries
     */
    async getActivity({ userId, workspaceId, sourceId, before, limit }) {
      const { site } = await requireSite(userId, workspaceId, "read-only", sourceId);
      const run = (await crawlRepository.findActiveRun(site._id))
        ?? (await crawlRepository.findLatestRun(site._id));
      if (!run) return { run: null, entries: [], progress: null };

      const [rows, outstanding, details] = await Promise.all([
        crawlRepository.listActivity({
          siteId: site._id,
          runId: run._id,
          before: before ? new Date(before) : undefined,
          limit,
        }),
        crawlRepository.countOutstandingJobs(run._id),
        crawlRepository.liveDetails(run),
      ]);

      const fetched = (run.counters?.pagesFetched ?? 0) + (run.counters?.pagesNotModified ?? 0);
      return {
        run: toRunSummary(run),
        // A denominator, not a percentage: "412 of about 1,830" is honest about the fact that a
        // crawl discovers more work as it goes, where a percentage that slides backwards is not.
        logs: details.logs,
        progress: {
          queuePosition: details.queuePosition,
          skipped: run.counters?.pagesSkippedNoBudget ?? 0,
          // Set while the run is still draining, so the person watching learns the site said
          // stop before the run closes and its error message says the same.
          rateLimited: run.throttle?.abortedAt
            ? {
              host: run.throttle.host ?? null,
              status: run.throttle.lastStatus ?? null,
              skipped: run.counters?.pagesSkippedRateLimited ?? 0,
            }
            : null,
          // The same for a site that will not let the crawler in.
          blocked: run.block?.abortedAt
            ? {
              host: run.block.host ?? null,
              service: run.block.service ?? null,
              status: run.block.status ?? null,
            }
            : null,
          phase: phaseOf(run, outstanding),
          fetched,
          outstanding,
          discovered: run.counters?.urlsDiscovered ?? 0,
        },
        entries: rows.map((row) => ({
          url: row.url,
          urlHash: row.urlHash,
          title: row.extracted?.title ?? null,
          status: row.status ?? null,
          indexable: row.indexable === true,
          elapsedMs: row.elapsedMs ?? null,
          bytes: row.bytes ?? null,
          fetchedAt: row.fetchedAt.toISOString(),
          discovered: {
            links: row.discovered?.links ?? 0,
            newUrls: row.discovered?.newUrls ?? 0,
            sample: row.discovered?.sample ?? [],
          },
        })),
      };
    },

    /**
     * Returns one level of the site's route tree.
     *
     * The tree is read a branch at a time rather than built in the browser, because a site can
     * have fifty thousand URLs and a person looks at a dozen. Every child carries its subtree's
     * health, so a collapsed branch still reports what is under it.
     *
     * @param {object} options
     * @param {string} [options.path] node to expand, as a URL path; the root when absent
     */
    async getTree({ userId, workspaceId, sourceId, path, limit, skip }) {
      const { site } = await requireSite(userId, workspaceId, "read-only", sourceId);
      const prefix = segmentsOf(path);

      const [{ items, total }, self] = await Promise.all([
        crawlRepository.listTreeChildren({ siteId: site._id, prefix, limit, skip }),
        // A path can be both a folder and a page — `/blog` usually is, and the root always is:
        // the homepage sits at depth zero and is nobody's child. The node itself is resolved
        // alongside its children rather than being lost between them.
        crawlRepository.pageAtPath({ siteId: site._id, segments: prefix }),
      ]);

      return {
        path: `/${prefix.join("/")}`,
        page: self ? toTreePage(site, self) : null,
        children: items.map((row) => toTreeNode(site, row)),
        total,
        skip,
        limit,
      };
    },

    /**
     * Lists the pages behind one of the crawl page's figures, so "Broken 9" can be followed to the
     * nine: flat, by address, with what each answered and, for a duplicate, the page it is folded
     * into. Counted by the same filters as the figures in `getOverview`'s `urls`.
     *
     * @param {object} options
     * @param {"broken"|"orphans"|"duplicates"} options.kind
     */
    async getFindings({ userId, workspaceId, sourceId, kind, limit, skip }) {
      const { site } = await requireSite(userId, workspaceId, "read-only", sourceId);
      const { items, total } = await crawlRepository.listFindings({ siteId: site._id, kind, limit, skip });
      return {
        kind,
        items: items.map((row) => ({
          url: row.url,
          urlHash: row.urlHash,
          status: row.lastStatus ?? null,
          indexable: row.indexable === true,
          uncrawled: row.state === "discovered",
          inboundCount: row.inboundCount ?? 0,
          duplicateOf: row.variantOf ? { urlHash: row.variantOf, url: row.variantOfUrl, reason: row.variantReason ?? null } : null,
        })),
        total,
        skip,
        limit,
      };
    },

    /**
     * Returns everything the crawl recorded about one page.
     *
     * Assembled here rather than left to the interface to fetch in pieces: a detail panel that
     * made six requests would render in six stages, and the parts are meaningless apart — an
     * inbound link list without the anchors, or a status without the history that says whether it
     * is new.
     */
    async getPage({ userId, workspaceId, sourceId, urlHash }) {
      const { site } = await requireSite(userId, workspaceId, "read-only", sourceId);
      const registry = await crawlRepository.findUrl({ siteId: site._id, urlHash });
      if (!registry) {
        throw new AppError({ status: 404, code: "PAGE_NOT_FOUND", message: "This page is not in the crawl." });
      }

      const [snapshot, history, inbound, outbound, variants, markdown] = await Promise.all([
        crawlRepository.latestSnapshot({ siteId: site._id, urlHash }),
        crawlRepository.snapshotHistory({ siteId: site._id, urlHash }),
        crawlRepository.listInboundLinks({ siteId: site._id, urlHash }),
        crawlRepository.listOutboundLinks({ siteId: site._id, urlHash }),
        registry.groupKey
          ? crawlRepository.listVariants({ siteId: site._id, groupKey: registry.groupKey })
          : [],
        crawlRepository.markdownSummary({ siteId: site._id, urlHash }),
      ]);

      const sources = await crawlRepository.resolveUrls({
        siteId: site._id,
        hashes: inbound.map((edge) => edge.fromUrlHash),
      });

      return {
        page: toPageDetail(registry, snapshot),
        schedule: toPageSchedule(site, registry),
        // What the panel needs to offer the Markdown — that there is one, how big, how fresh —
        // without shipping the text with every detail read.
        markdown: markdown
          ? {
            bytes: markdown.bytes,
            words: markdown.words ?? null,
            truncated: markdown.truncated === true,
            updatedAt: markdown.updatedAt ? new Date(markdown.updatedAt).toISOString() : null,
            renderedAt: markdown.renderedAt ? new Date(markdown.renderedAt).toISOString() : null,
          }
          : null,
        variants: variants
          .filter((variant) => variant.urlHash !== urlHash)
          .map((variant) => ({
            url: variant.url,
            urlHash: variant.urlHash,
            reason: variant.variantReason ?? null,
            status: variant.lastStatus ?? null,
          })),
        inbound: inbound.map((edge) => ({
          url: sources.get(edge.fromUrlHash) ?? null,
          urlHash: edge.fromUrlHash,
          anchor: edge.anchor ?? null,
          nofollow: edge.nofollow === true,
        })),
        outbound: outbound.map((edge) => ({
          url: edge.toUrl,
          urlHash: edge.toUrlHash,
          anchor: edge.anchor ?? null,
          nofollow: edge.nofollow === true,
          internal: edge.internal === true,
        })),
        history: history
          .map((entry) => ({
            status: entry.status,
            indexable: entry.indexable === true,
            wordCount: entry.extracted?.wordCount ?? 0,
            textHash: entry.extracted?.textHash ?? null,
            fetchedAt: entry.fetchedAt.toISOString(),
          }))
          .reverse(),
      };
    },

    /**
     * Lists crawled pages from one run.
     *
     * Defaults to the latest run that produced pages, so the interface can ask for "the pages"
     * without first resolving which crawl they came from.
     */
    async listPages({ userId, workspaceId, sourceId, runId, indexable, status, limit, page }) {
      const { site } = await requireSite(userId, workspaceId, "read-only", sourceId);

      const run = runId
        ? (await crawlRepository.listRuns(site._id, 50)).find((candidate) => candidate._id.toHexString() === runId)
        : await crawlRepository.findLatestRun(site._id);
      if (!run) {
        return { items: [], total: 0, page, limit, runId: null };
      }

      const filter = {};
      if (indexable !== undefined) filter.indexable = indexable;
      if (status !== undefined) filter.status = status;

      const { items, total } = await crawlRepository.listPages({
        runId: run._id,
        filter,
        limit,
        skip: (page - 1) * limit,
      });
      return { items: items.map(toPageSummary), total, page, limit, runId: run._id.toHexString() };
    },

    /**
     * Lists the site's routes as the crawler found them, grouped by pattern.
     *
     * Grouped because that is how a person thinks about a templated site: `/blog/[slug]` is one
     * kind of page, and one or two posts can stand for all of them.
     */
    async listRoutes({ userId, workspaceId, limit }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      const site = await crawlRepository.findSiteByWorkspace(workspace._id);
      if (!site) return { items: [], crawled: false };
      const latestRun = await crawlRepository.findLatestRun(site._id);
      const items = await listRoutePatterns(database, { siteId: site._id, limit });
      return {
        crawled: Boolean(latestRun),
        items: items.map((route) => ({
          pattern: route.pattern,
          pages: route.pages,
          url: route.sampleUrl,
          urlHash: route.sampleHash,
          broken: route.broken,
          notIndexable: route.notIndexable,
        })),
      };
    },

    /** Lists the pages of one route pattern, with the title each was last crawled with. */
    async listRoutePages({ userId, workspaceId, pattern, search, limit }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      const site = await crawlRepository.findSiteByWorkspace(workspace._id);
      if (!site) return { items: [] };
      const items = await listRoutePages(database, { siteId: site._id, pattern, search, limit });
      const titleOf = await crawlRepository.latestTitles({ siteId: site._id, urlHashes: items.map((item) => item.urlHash) });
      return { items: items.map((item) => ({ ...item, title: titleOf.get(item.urlHash) ?? null })) };
    },
  };
}

/**
 * A day as a sentence carries it, "December 1", in UTC: the budget's months are UTC months, and
 * the day a month turns over must not move with the server's timezone.
 */
function formatDay(iso) {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/** Splits a URL path into the segments the route tree is keyed by. */
function segmentsOf(path) {
  return String(path ?? "").split("/").filter(Boolean);
}

/**
 * Shapes one aggregated tree child.
 *
 * `kind` is what the interface draws: a folder opens, a page opens a detail panel, and a pattern
 * is a folder whose children are all instances of one route rather than a named section.
 */
function toTreeNode(site, row) {
  const isLeaf = row.pages === row.leaves && row.pages === 1;
  const patterns = (row.patterns ?? []).filter(Boolean);
  const pattern = patterns.length === 1 ? patterns[0] : null;
  return {
    segment: row._id ?? "",
    kind: isLeaf ? "page" : "folder",
    pattern,
    // A page's own frequency; a folder's only when everything under it shares one pattern, since
    // a folder spanning several patterns has no single answer worth printing on its row.
    intervalHours: isLeaf
      ? effectiveIntervalHours(site, { routePattern: pattern, crawlOverride: row.sampleOverride })
      : pattern ? patternIntervalHours(site, pattern) : undefined,
    pages: row.pages,
    broken: row.broken,
    notIndexable: row.notIndexable,
    orphans: row.orphans,
    uncrawled: row.uncrawled,
    worstStatus: row.worstStatus ?? null,
    urlHash: isLeaf ? row.sampleHash : null,
    url: isLeaf ? row.sampleUrl : null,
  };
}

/** Shapes the page that sits at a tree node's own path, with what its row needs to say. */
function toTreePage(site, row) {
  return {
    url: row.url,
    urlHash: row.urlHash,
    status: row.lastStatus ?? null,
    indexable: row.indexable === true,
    orphan: row.orphan === true,
    uncrawled: row.state === "discovered",
    routePattern: row.routePattern ?? null,
    intervalHours: effectiveIntervalHours(site, row),
  };
}

/**
 * Shapes how often one page is crawled and why.
 *
 * Both the page's own answer and its pattern's are reported, so the interface can say "monthly,
 * because /blog/[slug] is" and offer "follow the pattern" as a choice that means something.
 */
function toPageSchedule(site, row) {
  return {
    intervalHours: effectiveIntervalHours(site, row),
    override: row.crawlOverride ? { intervalHours: row.crawlOverride.intervalHours ?? null } : null,
    patternIntervalHours: patternIntervalHours(site, row.routePattern),
    recrawlRequestedAt: row.recrawlRequestedAt ? new Date(row.recrawlRequestedAt).toISOString() : null,
  };
}

/**
 * Shapes one page's full detail.
 *
 * Everything here was already stored by the crawler and dropped by the list projection, which is
 * why the panel needs no new crawling to exist — only a read that does not throw it away.
 */
function toPageDetail(registry, snapshot) {
  return {
    url: registry.url,
    urlHash: registry.urlHash,
    routePattern: registry.routePattern ?? null,
    state: registry.state,
    depth: registry.depth ?? null,
    orphan: registry.orphan === true,
    eligible: registry.eligible !== false,
    scopeReason: registry.scopeReason ?? null,
    robotsAllowed: registry.robotsAllowed !== false,
    discoveredBy: registry.discoveredBy ?? [],
    inboundCount: registry.inboundCount ?? 0,
    firstSeenAt: registry.firstSeenAt ? registry.firstSeenAt.toISOString() : null,
    lastCrawledAt: registry.lastCrawledAt ? registry.lastCrawledAt.toISOString() : null,
    sitemap: registry.sitemap ?? null,
    isVariant: Boolean(registry.variantOf),
    variantReason: registry.variantReason ?? null,
    status: snapshot?.status ?? registry.lastStatus ?? null,
    indexable: snapshot ? snapshot.indexable === true : registry.indexable === true,
    indexabilityReasons: snapshot?.indexabilityReasons ?? [],
    canonicalUrl: snapshot?.canonicalUrl ?? null,
    selfCanonical: snapshot?.selfCanonical ?? null,
    finalUrl: snapshot?.finalUrl ?? null,
    redirects: snapshot?.redirects ?? [],
    contentType: snapshot?.contentType ?? null,
    bytes: snapshot?.bytes ?? null,
    elapsedMs: snapshot?.elapsedMs ?? null,
    fetchedAt: snapshot?.fetchedAt ? snapshot.fetchedAt.toISOString() : null,
    title: snapshot?.extracted?.title ?? null,
    titleLength: snapshot?.extracted?.titleLength ?? 0,
    metaDescription: snapshot?.extracted?.metaDescription ?? null,
    metaDescriptionLength: snapshot?.extracted?.metaDescriptionLength ?? 0,
    metaRobots: snapshot?.extracted?.metaRobots ?? [],
    lang: snapshot?.extracted?.lang ?? null,
    hreflang: snapshot?.extracted?.hreflang ?? [],
    headings: snapshot?.extracted?.headings ?? { h1: [], h2: [], h3: [] },
    wordCount: snapshot?.extracted?.wordCount ?? 0,
    images: snapshot?.extracted?.images ?? null,
    structuredDataTypes: snapshot?.extracted?.structuredDataTypes ?? [],
    openGraph: snapshot?.extracted?.openGraph ?? null,
    linkCount: snapshot?.extracted?.linkCount ?? 0,
  };
}

/**
 * Names what a run is doing, which a bare set of counters cannot.
 *
 * The finalize step is the reason this exists: after the last page is fetched it re-queues itself
 * every couple of seconds while it computes depth, grouping and route patterns over the whole
 * site. Counters are frozen throughout, so without a name for that phase a crawl looks hung
 * exactly when it is doing its most useful work.
 */
function phaseOf(run, outstanding) {
  if (run.status !== "running") return "idle";
  if (run.phase === "discovering") return run.phase;
  if (!run.phase && !Object.keys(run.counters ?? {}).length) return "queued";
  if (outstanding > 0) return "fetching";
  return (run.counters?.pagesFetched ?? 0) > 0 ? "finalizing" : "discovering";
}
