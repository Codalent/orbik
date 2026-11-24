import { Router } from "express";

import { createCrawlController } from "../controllers/crawlController.js";
import { requireAuthentication } from "../middleware/auth.js";
import {
  validateActivityQuery,
  validateCrawlRequest,
  validateCrawlSite,
  validateFindingsQuery,
  validateFrequencies,
  validateMarkdownQuery,
  validatePageQuery,
  validatePageSchedule,
  validateRecrawl,
  validateRoutePagesQuery,
  validateRouteQuery,
  validateRunQuery,
  validateTreeQuery,
  validateUrlHash,
} from "../validators/crawlValidators.js";
import { validateWorkspaceScope } from "../validators/shared.js";
import { validateSourceScope } from "../validators/sourceValidators.js";

/**
 * Builds authenticated crawl routes, every one scoped to a workspace the caller can open.
 *
 * Crawl data is addressed through its workspace rather than by its own identifier, so ownership is
 * enforced by the same check that protects the workspace instead of by a second one that could
 * drift out of step with it.
 */
export function createCrawlRouter({ crawlService, csrfProtection }) {
  const router = Router();
  const controller = createCrawlController(crawlService);
  // The website's crawl, as it has always been addressed, and every source's under its own id
  // (`website` names the website there too). One set of routes for both, so a source's pages,
  // runs and frequencies read exactly as the website's do.
  const bases = [
    { path: "/v1/workspaces/:workspaceId/crawl", scope: [validateWorkspaceScope] },
    { path: "/v1/workspaces/:workspaceId/sources/:sourceId/crawl", scope: [validateWorkspaceScope, validateSourceScope] },
  ];

  // Setting up the website's crawl — its start address and sitemaps — is the website's alone;
  // another source's settings are saved on the source.
  router.put(bases[0].path, requireAuthentication, csrfProtection, validateWorkspaceScope, validateCrawlSite, controller.saveSite);

  for (const { path: base, scope } of bases) {
    router.get(base, requireAuthentication, ...scope, controller.overview);
    router.post(`${base}/runs`, requireAuthentication, csrfProtection, ...scope, validateCrawlRequest, controller.requestCrawl);
    router.post(`${base}/stop`, requireAuthentication, csrfProtection, ...scope, controller.stopCrawl);
    router.post(`${base}/clear`, requireAuthentication, csrfProtection, ...scope, controller.clearData);
    router.get(`${base}/runs`, requireAuthentication, ...scope, validateRunQuery, controller.listRuns);
    router.get(`${base}/pages`, requireAuthentication, ...scope, validatePageQuery, controller.listPages);
    router.get(`${base}/tree`, requireAuthentication, ...scope, validateTreeQuery, controller.tree);
    // The pages behind one of the page's figures — broken, nothing links here, duplicate URLs.
    router.get(`${base}/findings`, requireAuthentication, ...scope, validateFindingsQuery, controller.findings);
    router.get(`${base}/activity`, requireAuthentication, ...scope, validateActivityQuery, controller.activity);
    // Declared after `/pages` so the literal segment always wins over the parameter, whatever order
    // Express happens to match in.
    router.get(`${base}/pages/:urlHash`, requireAuthentication, ...scope, validateUrlHash, controller.page);
    router.get(`${base}/markdown`, requireAuthentication, ...scope, validateMarkdownQuery, controller.listMarkdown);
    router.get(`${base}/pages/:urlHash/markdown`, requireAuthentication, ...scope, validateUrlHash, controller.pageMarkdown);
    router.put(`${base}/pages/:urlHash/schedule`, requireAuthentication, csrfProtection, ...scope, validateUrlHash, validatePageSchedule, controller.setPageSchedule);
    // How often each route pattern is crawled, and a way to crawl a page or a pattern right now.
    router.get(`${base}/schedule`, requireAuthentication, ...scope, controller.schedule);
    router.put(`${base}/frequencies`, requireAuthentication, csrfProtection, ...scope, validateFrequencies, controller.setFrequencies);
    router.post(`${base}/recrawl`, requireAuthentication, csrfProtection, ...scope, validateRecrawl, controller.requestRecrawl);
  }
  // The website's routes grouped by pattern, in the shape an agent's page picker reads.
  router.get(`${bases[0].path}/routes`, requireAuthentication, validateWorkspaceScope, validateRouteQuery, controller.listRoutes);
  router.get(`${bases[0].path}/routes/pages`, requireAuthentication, validateWorkspaceScope, validateRoutePagesQuery, controller.listRoutePages);
  return router;
}
