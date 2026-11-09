import { Router } from "express";

import { createCrawlController } from "../controllers/crawlController.js";
import { requireAuthentication } from "../middleware/auth.js";
import {
  validateActivityQuery,
  validateCrawlRequest,
  validateCrawlSite,
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

/**
 * Builds authenticated crawl routes, every one scoped to a workspace the caller owns.
 *
 * Crawl data is addressed through its workspace rather than by its own identifier, so ownership is
 * enforced by the same check that protects the workspace instead of by a second one that could
 * drift out of step with it.
 */
export function createCrawlRouter({ crawlService, csrfProtection }) {
  const router = Router();
  const controller = createCrawlController(crawlService);
  const base = "/v1/workspaces/:workspaceId/crawl";

  router.get(base, requireAuthentication, validateWorkspaceScope, controller.overview);
  router.put(base, requireAuthentication, csrfProtection, validateWorkspaceScope, validateCrawlSite, controller.saveSite);
  router.post(`${base}/runs`, requireAuthentication, csrfProtection, validateWorkspaceScope, validateCrawlRequest, controller.requestCrawl);
  router.post(`${base}/clear`, requireAuthentication, csrfProtection, validateWorkspaceScope, controller.clearData);
  router.get(`${base}/runs`, requireAuthentication, validateWorkspaceScope, validateRunQuery, controller.listRuns);
  router.get(`${base}/pages`, requireAuthentication, validateWorkspaceScope, validatePageQuery, controller.listPages);
  router.get(`${base}/tree`, requireAuthentication, validateWorkspaceScope, validateTreeQuery, controller.tree);
  router.get(`${base}/activity`, requireAuthentication, validateWorkspaceScope, validateActivityQuery, controller.activity);
  // Declared after `/pages` so the literal segment always wins over the parameter, whatever order
  // Express happens to match in.
  router.get(`${base}/pages/:urlHash`, requireAuthentication, validateWorkspaceScope, validateUrlHash, controller.page);
  router.get(`${base}/markdown`, requireAuthentication, validateWorkspaceScope, validateMarkdownQuery, controller.listMarkdown);
  router.get(`${base}/pages/:urlHash/markdown`, requireAuthentication, validateWorkspaceScope, validateUrlHash, controller.pageMarkdown);
  router.put(`${base}/pages/:urlHash/schedule`, requireAuthentication, csrfProtection, validateWorkspaceScope, validateUrlHash, validatePageSchedule, controller.setPageSchedule);
  // How often each route pattern is crawled, and a way to crawl a page or a pattern right now.
  router.get(`${base}/schedule`, requireAuthentication, validateWorkspaceScope, controller.schedule);
  router.put(`${base}/frequencies`, requireAuthentication, csrfProtection, validateWorkspaceScope, validateFrequencies, controller.setFrequencies);
  router.post(`${base}/recrawl`, requireAuthentication, csrfProtection, validateWorkspaceScope, validateRecrawl, controller.requestRecrawl);
  // The site's routes grouped by pattern, in the shape an agent's page picker reads.
  router.get(`${base}/routes`, requireAuthentication, validateWorkspaceScope, validateRouteQuery, controller.listRoutes);
  router.get(`${base}/routes/pages`, requireAuthentication, validateWorkspaceScope, validateRoutePagesQuery, controller.listRoutePages);
  return router;
}
