import {
  SOURCE_KNOWLEDGE_USE,
  SOURCE_LIMITS,
  SOURCE_MODE,
  SOURCE_PURPOSES,
  SOURCE_RELATION,
  WEBSITE_SOURCE,
  describeSource,
  hostOf,
  isUnderDomain,
  normalizeSection,
  ownDomainOf,
  sourcePurpose,
  toObjectId,
} from "@orbik/core";
import { BUDGET_STATE } from "@orbik/crawl-budget";
import { slugifySegment, sourceFolderPath } from "@orbik/library";

import { AppError } from "../errors/appError.js";
import { toRunSummary } from "../repositories/crawlRepository.js";
import { comparableUrl, describeKnownPage } from "./sourceHosts.js";
import { createWorkspaceAccessCheck } from "./workspaceAccess.js";

/** Suggestions "Found on your website" shows at most. */
const MAX_SUGGESTIONS = 6;

/** How a crawl run's error codes read as a source's state. */
const FAILURE_STATES = Object.freeze({ ACCESS_REFUSED: "refused", RATE_LIMITED: "rate-limited" });

/**
 * Everything Orbik reads for a workspace: its sources, what each is, how much of each is in the
 * Library, and how to add, change and remove one.
 *
 * A source is a crawl site. The website is the one every workspace has, set up by its first crawl
 * and changed on the crawl page as before; this adds the rest. The crawl itself — runs, pages,
 * frequencies — stays the crawl service's, which serves every source under
 * `/sources/:sourceId/crawl`; this service is about the sources as a set.
 *
 * @param {object} dependencies
 * @param {object} dependencies.workspaceRepository
 * @param {object} dependencies.crawlRepository the sites, their runs and pages
 * @param {object} dependencies.sourceRepository what the Library holds of each source
 * @param {object} dependencies.userRepository to name who added a source
 * @param {object} dependencies.crawlBudget the workspace's month of page fetches
 * @param {{probe: (url: string) => Promise<object>}} dependencies.pageProbe reads an address as the crawler would
 * @param {{erasePages: Function}|null} [dependencies.indexEraser] removes a removed source's pages from the index
 * @param {(level: string, message: string, context?: object) => void} [dependencies.logger]
 * @param {() => Date} [dependencies.now]
 */
export function createSourceService({
  workspaceRepository,
  crawlRepository,
  sourceRepository,
  userRepository,
  crawlBudget,
  pageProbe,
  indexEraser = null,
  logger = () => {},
  now = () => new Date(),
}) {
  const requireWorkspaceAccess = createWorkspaceAccessCheck(workspaceRepository);

  /** The workspace, its website and one named source of it, which must exist. */
  async function requireSource(userId, workspaceId, sourceId, role) {
    const workspace = await requireWorkspaceAccess(userId, workspaceId, { role });
    const site = await crawlRepository.findSource(workspace._id, sourceId);
    if (!site) {
      throw sourceId === WEBSITE_SOURCE
        ? new AppError({ status: 404, code: "CRAWL_NOT_CONFIGURED", message: "This workspace's website is not set up yet." })
        : new AppError({ status: 404, code: "SOURCE_NOT_FOUND", message: "This workspace has no such source." });
    }
    return { workspace, site };
  }

  /** The people some account ids name, by id. */
  async function peopleNamed(ids) {
    const users = await userRepository.listEmailsByIds(ids.filter(Boolean));
    return new Map(users.map((user) => [user._id.toHexString(), { userId: user._id.toHexString(), email: user.email }]));
  }

  /**
   * Each source's crawl as of now: its run, its pages, and the one state the page words.
   *
   * The state is decided here, from the runs, so every page that shows a source shows the same
   * one: `queued`, `first-read` (the first crawl is running), `reading`, `up-to-date`,
   * `out-of-budget` (the last crawl stopped for want of pages), `refused` (the site would not let
   * the crawler in), `rate-limited`, `failed`, `stopped`, or `never-read`.
   */
  async function describeAll(workspace, sites) {
    const siteIds = sites.map((site) => site._id);
    const [library, known, people] = await Promise.all([
      sourceRepository.libraryCounts(workspace._id, siteIds),
      sourceRepository.knownCounts(siteIds),
      peopleNamed(sites.flatMap((site) => [site.addedBy, site.crawlRequestedBy])),
    ]);
    const runs = await Promise.all(sites.map(async (site) => {
      const [active, latest] = await Promise.all([crawlRepository.findActiveRun(site._id), crawlRepository.findLatestRun(site._id)]);
      const firstSucceeded = active ? await crawlRepository.findFirstSucceededRun(site._id) : null;
      const outstanding = active ? await crawlRepository.countOutstandingJobs(active._id) : 0;
      return { active, latest, firstSucceeded, outstanding };
    }));
    return sites.map((site, index) => {
      const key = site._id.toHexString();
      const { active, latest, firstSucceeded, outstanding } = runs[index];
      return toSourceSummary(site, {
        workspace,
        active,
        latest,
        firstRead: Boolean(active && !firstSucceeded),
        outstanding,
        library: library.get(key) ?? { copied: 0, chosen: 0 },
        known: known.get(key) ?? 0,
        addedBy: site.addedBy ? people.get(site.addedBy.toHexString()) ?? null : null,
      });
    });
  }

  /** Refuses to add a source the month cannot read a page of, as the website's first crawl is. */
  async function requireBudget(workspace) {
    const budget = await crawlBudget.statusFor({ workspaceId: workspace._id });
    if (budget.state === BUDGET_STATE.notIncluded) {
      throw new AppError({ status: 403, code: "CRAWL_NOT_INCLUDED", message: "This workspace's plan includes no crawl pages, so no source can be read." });
    }
    if (budget.state === BUDGET_STATE.spent) {
      throw new AppError({ status: 409, code: "CRAWL_BUDGET_SPENT", message: "This month's crawl pages are spent, so a new source could not be read yet." });
    }
  }

  /**
   * The folder a source's pages are copied into: named after where they come from — `docs` for
   * docs.example.com, `clutch` for clutch.co — so it reads the same whatever the source is called.
   */
  function folderFor(url, relation, sites) {
    const parts = url.hostname.toLowerCase().replace(/^www\./, "").split(".");
    const label = relation === SOURCE_RELATION.own && parts.length > 2 ? parts[0] : (parts.at(-2) ?? parts[0]);
    return freeFolder(label, sites);
  }

  /** A folder under /sources the workspace has not used, from a name. */
  function freeFolder(name, sites) {
    const taken = new Set(sites.map((site) => describeSource(site).folder));
    const base = (slugifySegment(name) || "source").slice(0, SOURCE_LIMITS.folderLength).replace(/-+$/, "") || "source";
    if (!taken.has(base)) return base;
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const candidate = `${base.slice(0, SOURCE_LIMITS.folderLength - String(suffix).length - 1)}-${suffix}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base.slice(0, 30)}-${Date.now().toString(36)}`;
  }

  /** A name for a source from the address and what is known of it. */
  function suggestedName(url, { known, title, relation }) {
    const host = url.hostname.replace(/^www\./, "");
    const brand = host.split(".").at(-2) ?? host;
    const site = brand.charAt(0).toUpperCase() + brand.slice(1);
    if (relation === SOURCE_RELATION.own) {
      const sub = host.split(".").length > 2 ? host.split(".")[0] : null;
      return sub ? sub.charAt(0).toUpperCase() + sub.slice(1) : site;
    }
    if (known?.purpose === "reviews") return `${site} reviews`;
    // A title is usually "What it is · Where it is": the part naming the site is the better name.
    const parts = String(title ?? "").split(/\s[|·—–-]\s/).map((part) => part.trim()).filter(Boolean);
    const named = parts.find((part) => part.toLowerCase().replace(/\s/g, "").includes(brand.toLowerCase()));
    if (named) return named.slice(0, SOURCE_LIMITS.nameLength);
    return site;
  }

  /** The 409 a unique index raised on a race, said as the conflict it is. */
  function conflictFrom(error) {
    if (error?.code !== 11000) throw error;
    const key = Object.keys(error.keyPattern ?? {});
    if (key.includes("host")) throw new AppError({ status: 409, code: "SOURCE_HOST_TAKEN", message: "Another source already reads that site." });
    if (key.includes("folder")) throw new AppError({ status: 409, code: "SOURCE_FOLDER_TAKEN", message: "Another source already uses that folder." });
    throw error;
  }

  return {
    /** Every source of the workspace, the website first, with the figures the Sources page heads with. */
    async list({ userId, workspaceId }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      const sites = await crawlRepository.listSources(workspace._id);
      const [sources, budget, lastChangeAt] = await Promise.all([
        describeAll(workspace, sites),
        crawlBudget.statusFor({ workspaceId: workspace._id }),
        sourceRepository.latestChange(sites.map((site) => site._id)),
      ]);
      return {
        sources,
        totals: {
          sources: sources.length,
          own: sources.filter((source) => source.relation === SOURCE_RELATION.own).length,
          elsewhere: sources.filter((source) => source.relation === SOURCE_RELATION.elsewhere).length,
          libraryPages: sources.reduce((total, source) => total + source.pages.copied, 0),
          onTheWay: sources
            .filter((source) => source.progress && source.progress.outstanding > 0)
            .map((source) => ({ id: source.id, name: source.name, pages: source.progress.outstanding })),
          readThisMonth: budget.consumed ?? 0,
          needsAttention: sources
            .filter((source) => ["refused", "rate-limited", "failed"].includes(source.state))
            .map((source) => ({ id: source.id, name: source.name, state: source.state, message: source.latestRun?.error?.message ?? null })),
          reading: sources.filter((source) => ["reading", "first-read"].includes(source.state)).length,
          lastChangeAt: lastChangeAt ? lastChangeAt.toISOString() : null,
        },
        budget,
        limits: { sources: SOURCE_LIMITS.perWorkspace, pages: SOURCE_LIMITS.pages },
        // What a source can be, in the words the knowledge base is given: the pages offer these.
        purposes: SOURCE_PURPOSES,
      };
    },

    /**
     * One source in full: its settings, its crawl, what its last read found, what is in the
     * Library from it and which of the knowledge base's files quote it.
     */
    async get({ userId, workspaceId, sourceId }) {
      const { workspace, site } = await requireSource(userId, workspaceId, sourceId, "read-only");
      const [summary] = await describeAll(workspace, [site]);
      const described = describeSource(site);
      const runId = summary.activeRun?.id ?? summary.latestRun?.id ?? null;
      const website = described.primary ? site : await crawlRepository.findSiteByWorkspace(workspace._id);
      const [latestRead, leftOut, files, quoted, pages, sitemaps, linkedFrom] = await Promise.all([
        sourceRepository.latestRead(site._id, runId ? toObjectId(runId) : null),
        sourceRepository.leftOut(site._id),
        sourceRepository.libraryFiles(workspace._id, described.folder),
        sourceRepository.quotedIn(workspace._id, site._id),
        described.mode === SOURCE_MODE.pages ? sourceRepository.pagesOf(site._id) : null,
        described.mode === SOURCE_MODE.pages ? [] : sourceRepository.sitemapsOf(site._id),
        !described.primary && described.relation === SOURCE_RELATION.own && website
          ? sourceRepository.websitePagesLinkingTo(website._id, described.host)
          : 0,
      ]);
      return {
        source: summary,
        latestRead: latestRead.map((row) => ({ ...row, fetchedAt: row.fetchedAt.toISOString() })),
        leftOut,
        library: files,
        quotedIn: quoted,
        pages: pages?.map((page) => ({
          ...page,
          listed: described.pageUrls.includes(page.url),
          crawledAt: page.crawledAt ? new Date(page.crawledAt).toISOString() : null,
          changedAt: page.changedAt ? new Date(page.changedAt).toISOString() : null,
        })) ?? null,
        sitemaps,
        website: website ? { host: hostOf(website.seedUrl), linksHere: linkedFrom } : null,
        lastRead: summary.latestRun && summary.latestRun.status !== "running" ? lastReadOf(summary.latestRun) : null,
      };
    },

    /**
     * What an address is, before it is added: whose it looks like, what kind of page, whether it
     * answers and lets OrbikBot in, and the name and folder it would get. Saves nothing.
     */
    async check({ userId, workspaceId, url }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "member" });
      const sites = await crawlRepository.listSources(workspace._id);
      const website = sites.find((site) => site.primary !== false) ?? null;
      const target = new URL(url);
      const host = target.hostname.toLowerCase();
      const websiteHost = website ? hostOf(website.seedUrl) : hostOf(workspace.websiteUrl);
      const taken = sites.find((site) => describeSource(site).host === host) ?? null;
      const known = describeKnownPage(target);
      const relation = websiteHost && isUnderDomain(host, websiteHost) ? SOURCE_RELATION.own : SOURCE_RELATION.elsewhere;
      const probe = known && !known.readable
        ? { status: null, finalUrl: null, title: null, robotsAllowed: false, error: null }
        : await pageProbe.probe(url);
      const name = suggestedName(target, { known, title: probe.title, relation });
      return {
        url,
        host,
        website: websiteHost ? { host: websiteHost, domain: ownDomainOf(websiteHost) } : null,
        suggested: {
          relation,
          purpose: known?.purpose ?? (relation === SOURCE_RELATION.own ? (/^docs?\./.test(host) ? "docs" : /^blog\./.test(host) ? "blog" : "product") : "other"),
          name,
          folder: folderFor(target, relation, sites),
          followPagination: relation === SOURCE_RELATION.elsewhere,
        },
        known: known ? { label: known.label, readable: known.readable, reason: known.reason } : null,
        page: {
          status: probe.status,
          title: probe.title,
          finalUrl: probe.finalUrl,
          robotsAllowed: probe.robotsAllowed,
          error: probe.error,
        },
        conflict: taken
          ? { id: taken._id.toHexString(), name: describeSource(taken).name, primary: taken.primary !== false }
          : null,
        websiteSetUp: Boolean(website),
        full: sites.length >= SOURCE_LIMITS.perWorkspace,
      };
    },

    /** Adds a source and asks for its first read. */
    async add({ userId, workspaceId, source }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "member" });
      const sites = await crawlRepository.listSources(workspace._id);
      if (!sites.some((site) => site.primary !== false)) {
        throw new AppError({ status: 409, code: "CRAWL_NOT_CONFIGURED", message: "Set up the website's crawl first: every other source sits beside it." });
      }
      if (sites.length >= SOURCE_LIMITS.perWorkspace) {
        throw new AppError({ status: 409, code: "SOURCE_LIMIT", message: `A workspace can have ${SOURCE_LIMITS.perWorkspace} sources.` });
      }
      const target = new URL(source.url);
      const host = target.hostname.toLowerCase();
      const taken = sites.find((site) => describeSource(site).host === host);
      if (taken) {
        const name = describeSource(taken).name;
        throw new AppError({
          status: 409,
          code: "SOURCE_HOST_TAKEN",
          message: taken.primary !== false
            ? `${host} is the website's own host, and the website reads all of it.`
            : `${name} already reads ${host}. Add the page there instead.`,
        });
      }
      const known = describeKnownPage(target);
      if (known && !known.readable) throw new AppError({ status: 409, code: "SOURCE_UNREADABLE", message: known.reason });
      await requireBudget(workspace);

      const elsewhere = source.relation === SOURCE_RELATION.elsewhere;
      const document = {
        relation: source.relation,
        mode: elsewhere ? SOURCE_MODE.pages : SOURCE_MODE.site,
        name: source.name,
        folder: folderFor(target, source.relation, sites),
        purpose: source.purpose,
        knowledgeUse: source.knowledgeUse,
        pageIntervalHours: source.pageIntervalHours,
        seedUrl: source.url,
        host,
        ...(elsewhere ? { pageUrls: [source.url], followPagination: source.followPagination } : {}),
      };
      let site;
      try {
        site = await crawlRepository.insertSource({ workspaceId: workspace._id, document, now: now(), startedBy: userId });
      } catch (error) {
        conflictFrom(error);
      }
      logger("info", "sources.added", { workspaceId: workspace._id.toHexString(), sourceId: site._id.toHexString(), relation: source.relation });
      const [summary] = await describeAll(workspace, [site]);
      return { source: summary };
    },

    /** Changes a source's settings; they apply from its next read. */
    async update({ userId, workspaceId, sourceId, changes }) {
      const { workspace, site } = await requireSource(userId, workspaceId, sourceId, "member");
      const current = describeSource(site);
      const set = {};
      const unset = [];
      const refuse = (field, message) => {
        throw new AppError({ status: 400, code: "VALIDATION_FAILED", message: "Request validation failed.", fields: [{ field, code: "INVALID", message }] });
      };

      if (changes.name !== undefined) {
        if (current.primary && changes.name !== current.name) refuse("name", "The website keeps its name.");
        set.name = changes.name;
      }
      if (changes.purpose !== undefined) set.purpose = changes.purpose;
      if (changes.knowledgeUse !== undefined) {
        if (current.primary && changes.knowledgeUse !== SOURCE_KNOWLEDGE_USE.use) refuse("knowledgeUse", "The knowledge base is always written from the website.");
        set.knowledgeUse = changes.knowledgeUse;
      }
      if (changes.pageIntervalHours !== undefined) set.pageIntervalHours = changes.pageIntervalHours;
      if (changes.excludePatterns !== undefined) set.excludePatterns = changes.excludePatterns;

      // How much of its host a source reads. A page about the company elsewhere is always a list
      // of pages; the website is always the whole site.
      const mode = changes.mode ?? current.mode;
      if (changes.mode !== undefined && changes.mode !== current.mode) {
        if (current.primary) refuse("mode", "The website is read in full; add a section of it as a source of its own instead.");
        if (current.relation === SOURCE_RELATION.elsewhere) refuse("mode", "Orbik reads only the listed pages of a site that is not yours.");
        set.mode = changes.mode;
      }
      const onHost = (url, field) => {
        if (hostOf(url) !== current.host) refuse(field, `Every address of this source is on ${current.host}. Another host is another source.`);
      };
      if (mode === SOURCE_MODE.section) {
        const section = changes.section ?? current.section ?? normalizeSection(new URL(changes.seedUrl ?? site.seedUrl).pathname);
        if (!section) refuse("section", "Enter the section's path, such as /guides/.");
        set.section = section;
      } else if (current.mode === SOURCE_MODE.section) {
        unset.push("section");
      }
      if (mode === SOURCE_MODE.pages) {
        const pageUrls = changes.pageUrls ?? current.pageUrls;
        if (!pageUrls?.length) refuse("pageUrls", "List at least one page.");
        for (const url of pageUrls) onHost(url, "pageUrls");
        set.pageUrls = pageUrls;
        set.seedUrl = pageUrls[0];
        if (changes.followPagination !== undefined) set.followPagination = changes.followPagination;
      } else {
        if (current.mode === SOURCE_MODE.pages) unset.push("pageUrls", "followPagination");
        if (changes.seedUrl !== undefined) {
          onHost(changes.seedUrl, "seedUrl");
          set.seedUrl = changes.seedUrl;
        }
        if (changes.sitemapUrls !== undefined) {
          for (const url of changes.sitemapUrls) onHost(url, "sitemapUrls");
          set.sitemapUrls = changes.sitemapUrls;
        }
      }
      // A section's start address is in the section.
      if (set.section) {
        const seed = new URL(set.seedUrl ?? site.seedUrl);
        if (!`${seed.pathname}`.startsWith(set.section) && `${seed.pathname}/` !== set.section) {
          set.seedUrl = new URL(set.section, seed.origin).href;
        }
      }

      let saved;
      try {
        saved = await crawlRepository.updateSource({ siteId: site._id, set, unset, now: now() });
      } catch (error) {
        conflictFrom(error);
      }
      const [summary] = await describeAll(workspace, [saved]);
      return { source: summary };
    },

    /**
     * Removes a source: its crawl, its branch of the Library and its pages in the index. The
     * knowledge base's own files stay, citing the pages they were written from. Not the website,
     * and not while it is being read.
     */
    async remove({ userId, workspaceId, sourceId }) {
      const { workspace, site } = await requireSource(userId, workspaceId, sourceId, "admin");
      const described = describeSource(site);
      if (described.primary) {
        throw new AppError({ status: 409, code: "WEBSITE_NOT_REMOVABLE", message: "The website is the workspace's own source. Change it under Settings instead." });
      }
      if (await crawlRepository.findActiveRun(site._id)) {
        throw new AppError({ status: 409, code: "CRAWL_RUNNING", message: "This source is being read. Stop the crawl, then remove it." });
      }
      if (await sourceRepository.mirrorRunning(site._id)) {
        throw new AppError({ status: 409, code: "SOURCE_BUSY", message: "This source is being copied into the Library. Try again in a minute." });
      }
      // Stopped first, so the scheduler cannot start a crawl of it while it is taken apart.
      await crawlRepository.updateSource({ siteId: site._id, set: { enabled: false }, unset: ["crawlRequestedAt", "crawlRequestedBy"], now: now() });
      const keys = await sourceRepository.pageKeysOf(workspace._id, site._id);
      let indexErased = false;
      if (indexEraser && keys.length) {
        try {
          await indexEraser.erasePages(workspace._id.toHexString(), keys);
          indexErased = true;
        } catch (error) {
          // Left for the worker: its next index pass forgets every page no source still has.
          logger("warn", "sources.index_erase_failed", { sourceId: site._id.toHexString(), code: error.code ?? null, message: error.message });
        }
      }
      const { files } = await sourceRepository.removeLibraryBranch({ workspaceId: workspace._id, siteId: site._id, folder: described.folder, keys, indexErased });
      const pages = await crawlRepository.clearSiteData(site._id);
      await crawlRepository.deleteSource(site._id);
      logger("info", "sources.removed", { workspaceId: workspace._id.toHexString(), sourceId: site._id.toHexString(), pages, files });
      return { removed: { id: site._id.toHexString(), name: described.name, pages, files } };
    },

    /**
     * Pages about the company that its website links to — a review profile, a directory listing,
     * its public code — which are not sources yet and nobody dismissed. Read from the website's
     * last crawl, so it costs no request.
     */
    async suggestions({ userId, workspaceId }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      const sites = await crawlRepository.listSources(workspace._id);
      const website = sites.find((site) => site.primary !== false);
      if (!website) return { items: [] };
      const hosts = new Set(sites.map((site) => describeSource(site).host?.replace(/^www\./, "")).filter(Boolean));
      const dismissed = new Set((website.suggestionsDismissed ?? []).map((row) => row.url));
      const targets = await crawlRepository.outboundLinkTargets(website._id);
      const seen = new Set();
      const items = [];
      for (const target of targets) {
        let url;
        try { url = new URL(target._id); } catch { continue; }
        const known = describeKnownPage(url);
        if (!known) continue;
        const key = comparableUrl(url);
        if (seen.has(key) || dismissed.has(target._id) || hosts.has(url.hostname.replace(/^www\./, ""))) continue;
        seen.add(key);
        items.push({ url: target._id, label: known.label, purpose: known.purpose, readable: known.readable, reason: known.reason, pages: target.pages, from: target.from ?? [] });
      }
      items.sort((left, right) => Number(right.readable) - Number(left.readable) || right.pages - left.pages);
      const shown = items.slice(0, MAX_SUGGESTIONS);
      // Where a person would see the link: the page nearest the home page that has it.
      const from = await sourceRepository.urlsOf(website._id, shown.flatMap((item) => item.from));
      return {
        items: shown.map(({ from: hashes, ...item }) => {
          const nearest = hashes.map((hash) => from.get(hash)).filter(Boolean)
            .sort((left, right) => (left.depth ?? 99) - (right.depth ?? 99) || left.url.length - right.url.length)[0];
          return { ...item, linkedFrom: nearest?.url ?? null };
        }),
      };
    },

    /** Stops suggesting one address. */
    async dismissSuggestion({ userId, workspaceId, url }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "member" });
      const website = await crawlRepository.findSiteByWorkspace(workspace._id);
      if (!website) throw new AppError({ status: 404, code: "CRAWL_NOT_CONFIGURED", message: "This workspace's website is not set up yet." });
      await crawlRepository.dismissSuggestion({ siteId: website._id, url, by: userId, now: now() });
      return { dismissed: url };
    },
  };
}

/**
 * One source as the Sources pages show it.
 *
 * Figures and states, never wording: the web app words them.
 */
function toSourceSummary(site, { active, latest, firstRead, outstanding, library, known, addedBy }) {
  const described = describeSource(site);
  const purpose = sourcePurpose(described.purpose);
  const activeRun = active ? toRunSummary(active) : null;
  const latestRun = latest ? { ...toRunSummary(latest), block: latest.block?.abortedAt ? { host: latest.block.host ?? null, service: latest.block.service ?? null, status: latest.block.status ?? null } : null } : null;
  const fetched = active ? (active.counters?.pagesFetched ?? 0) + (active.counters?.pagesNotModified ?? 0) : 0;
  return {
    id: site._id.toHexString(),
    primary: described.primary,
    relation: described.relation,
    mode: described.mode,
    name: described.name,
    folder: described.folder,
    libraryPath: sourceFolderPath(described.folder ?? WEBSITE_SOURCE),
    purpose: described.purpose,
    purposeLabel: purpose.label,
    purposeGuidance: purpose.guidance,
    knowledgeUse: described.knowledgeUse,
    host: described.host,
    seedUrl: site.seedUrl,
    section: described.section,
    pageUrls: described.pageUrls,
    followPagination: described.followPagination,
    excludePatterns: described.excludePatterns,
    sitemapUrls: site.sitemapUrls ?? [],
    pageIntervalHours: described.pageIntervalHours,
    enabled: site.enabled !== false,
    createdAt: site.createdAt ? site.createdAt.toISOString() : null,
    addedBy,
    nextReadAt: site.nextCrawlAt ? site.nextCrawlAt.toISOString() : null,
    queued: Boolean(site.crawlRequestedAt) && !active,
    state: stateOf({ active, latest, firstRead, queued: Boolean(site.crawlRequestedAt) && !active }),
    activeRun,
    latestRun,
    progress: active
      ? { fetched, outstanding, discovered: active.counters?.urlsDiscovered ?? 0, phase: active.phase ?? null }
      : null,
    pages: { known, copied: library.copied, chosen: library.chosen },
    lastReadAt: latest?.finishedAt ? latest.finishedAt.toISOString() : null,
  };
}

/** The one state a source is in, from its runs. */
function stateOf({ active, latest, firstRead, queued }) {
  if (active) return firstRead ? "first-read" : "reading";
  if (queued) return "queued";
  if (!latest) return "never-read";
  if (latest.status === "failed") return FAILURE_STATES[latest.error?.code] ?? "failed";
  if (latest.status === "cancelled") return "stopped";
  if ((latest.counters?.pagesSkippedNoBudget ?? 0) > 0) return "out-of-budget";
  return "up-to-date";
}

/** What the last read found: how many pages it read and how many came back changed. */
function lastReadOf(run) {
  const counters = run.counters ?? {};
  return {
    at: run.finishedAt,
    durationMs: run.durationMs,
    read: (counters.pagesFetched ?? 0) + (counters.pagesNotModified ?? 0),
    changed: counters.pagesChanged ?? 0,
  };
}
