/** Creates HTTP adapters for crawl configuration and reporting use cases. */
export function createCrawlController(crawlService) {
  return {
    /** Returns the workspace's crawl configuration and current status. */
    async overview(req, res, next) {
      try {
        res.json(await crawlService.getOverview({ userId: req.auth.userId, workspaceId: req.validated.workspaceId }));
      } catch (error) { next(error); }
    },

    /** Creates or replaces the workspace's crawl configuration. */
    async saveSite(req, res, next) {
      try {
        res.json(await crawlService.saveSite({
          userId: req.auth.userId,
          workspaceId: req.validated.workspaceId,
          seedUrl: req.validated.seedUrl,
          settings: req.validated.settings,
        }));
      } catch (error) { next(error); }
    },

    /** Asks for a crawl, reporting 200 when one was already in progress and 202 when queued. */
    async requestCrawl(req, res, next) {
      try {
        const result = await crawlService.requestCrawl({ userId: req.auth.userId, workspaceId: req.validated.workspaceId, fresh: req.validated.fresh });
        res.status(result.alreadyRunning ? 200 : 202).json(result);
      } catch (error) { next(error); }
    },

    /** Deletes everything crawled for the workspace, keeping its crawl settings. */
    async clearData(req, res, next) {
      try {
        res.json(await crawlService.clearData({ userId: req.auth.userId, workspaceId: req.validated.workspaceId }));
      } catch (error) { next(error); }
    },

    /** Lists the workspace's recent crawl runs. */
    async listRuns(req, res, next) {
      try {
        res.json(await crawlService.listRuns({
          userId: req.auth.userId, workspaceId: req.validated.workspaceId, limit: req.validated.limit,
        }));
      } catch (error) { next(error); }
    },

    /** Returns what the crawl is doing right now, and the pages it has just fetched. */
    async activity(req, res, next) {
      try {
        res.json(await crawlService.getActivity({
          userId: req.auth.userId,
          workspaceId: req.validated.workspaceId,
          before: req.validated.before,
          limit: req.validated.limit,
        }));
      } catch (error) { next(error); }
    },

    /** Returns one level of the site's route tree. */
    async tree(req, res, next) {
      try {
        res.json(await crawlService.getTree({
          userId: req.auth.userId,
          workspaceId: req.validated.workspaceId,
          path: req.validated.path,
          limit: req.validated.limit,
          skip: req.validated.skip,
        }));
      } catch (error) { next(error); }
    },

    /** Returns everything recorded about one page. */
    async page(req, res, next) {
      try {
        res.json(await crawlService.getPage({
          userId: req.auth.userId,
          workspaceId: req.validated.workspaceId,
          urlHash: req.validated.urlHash,
        }));
      } catch (error) { next(error); }
    },

    /** Reports how often each route pattern is crawled, and where each decision came from. */
    async schedule(req, res, next) {
      try {
        res.json(await crawlService.getSchedule({ userId: req.auth.userId, workspaceId: req.validated.workspaceId }));
      } catch (error) { next(error); }
    },

    /** Pins one page to its own crawl frequency, or returns it to its pattern's. */
    async setPageSchedule(req, res, next) {
      try {
        res.json(await crawlService.setPageSchedule({
          userId: req.auth.userId,
          workspaceId: req.validated.workspaceId,
          urlHash: req.validated.urlHash,
          override: req.validated.override,
        }));
      } catch (error) { next(error); }
    },

    /** Lists the pages that have Markdown. */
    async listMarkdown(req, res, next) {
      try {
        res.json(await crawlService.listMarkdown({
          userId: req.auth.userId,
          workspaceId: req.validated.workspaceId,
          limit: req.validated.limit,
          skip: req.validated.skip,
        }));
      } catch (error) { next(error); }
    },

    /** Sends a page's Markdown as text, with a filename so a browser can save it. */
    async pageMarkdown(req, res, next) {
      try {
        const result = await crawlService.getPageMarkdown({
          userId: req.auth.userId,
          workspaceId: req.validated.workspaceId,
          urlHash: req.validated.urlHash,
        });
        res.type("text/markdown; charset=utf-8");
        res.setHeader("Content-Disposition", `inline; filename="${filenameFor(result.url)}"`);
        res.send(result.markdown);
      } catch (error) { next(error); }
    },

    /** Sets one crawl frequency on a selection of pages and folders. */
    async setFrequencies(req, res, next) {
      try {
        res.json(await crawlService.setFrequencies({
          userId: req.auth.userId,
          workspaceId: req.validated.workspaceId,
          targets: req.validated.targets,
          intervalHours: req.validated.intervalHours,
        }));
      } catch (error) { next(error); }
    },

    /** Asks for one page or one route pattern to be crawled on the next pass. */
    async requestRecrawl(req, res, next) {
      try {
        res.status(202).json(await crawlService.requestRecrawl({
          userId: req.auth.userId,
          workspaceId: req.validated.workspaceId,
          target: req.validated.target,
        }));
      } catch (error) { next(error); }
    },

    /** Lists crawled pages from one run. */
    async listPages(req, res, next) {
      try {
        res.json(await crawlService.listPages({ userId: req.auth.userId, ...req.validated }));
      } catch (error) { next(error); }
    },

    /** Lists the crawled site's routes, grouped by pattern. */
    async listRoutes(req, res, next) {
      try {
        res.json(await crawlService.listRoutes({ userId: req.auth.userId, ...req.validated }));
      } catch (error) { next(error); }
    },

    /** Lists the pages of one route pattern. */
    async listRoutePages(req, res, next) {
      try {
        res.json(await crawlService.listRoutePages({ userId: req.auth.userId, ...req.validated }));
      } catch (error) { next(error); }
    },
  };
}

/** A safe filename from a page URL: its path, or "index" for the root, with a .md suffix. */
function filenameFor(url) {
  let path = "index";
  try {
    path = new URL(url).pathname.replace(/^\/+|\/+$/g, "") || "index";
  } catch {
    // A URL the parser refuses still gets a filename; it is only a suggestion to the browser.
  }
  return `${path.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120)}.md`;
}
