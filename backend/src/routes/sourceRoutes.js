import { Router } from "express";

import { createSourceController } from "../controllers/sourceController.js";
import { requireAuthentication } from "../middleware/auth.js";
import {
  validateSourceCheck,
  validateSourceCreate,
  validateSourceScope,
  validateSourceUpdate,
  validateSuggestionDismiss,
} from "../validators/sourceValidators.js";
import { validateWorkspaceScope } from "../validators/shared.js";

/**
 * Builds the routes for a workspace's sources: what it reads besides, and including, its website.
 *
 * A source's crawl — its runs, pages and frequencies — is served by the crawl routes under
 * `/sources/:sourceId/crawl` (`crawlRoutes.js`); these are about the sources themselves.
 */
export function createSourceRouter({ sourceService, csrfProtection }) {
  const router = Router();
  const controller = createSourceController(sourceService);
  const base = "/v1/workspaces/:workspaceId/sources";
  const one = `${base}/:sourceId`;

  router.get(base, requireAuthentication, validateWorkspaceScope, controller.list);
  router.post(base, requireAuthentication, csrfProtection, validateWorkspaceScope, validateSourceCreate, controller.add);
  // What an address is, before it is added. Saves nothing; reads the page as the crawler would.
  router.post(`${base}/check`, requireAuthentication, csrfProtection, validateWorkspaceScope, validateSourceCheck, controller.check);
  // Pages about the company its website links to, which are not sources yet.
  router.get(`${base}/suggestions`, requireAuthentication, validateWorkspaceScope, controller.suggestions);
  router.post(`${base}/suggestions/dismiss`, requireAuthentication, csrfProtection, validateWorkspaceScope, validateSuggestionDismiss, controller.dismissSuggestion);
  // Declared after the literal segments above, so `check` and `suggestions` are never read as ids.
  router.get(one, requireAuthentication, validateWorkspaceScope, validateSourceScope, controller.get);
  router.patch(one, requireAuthentication, csrfProtection, validateWorkspaceScope, validateSourceScope, validateSourceUpdate, controller.update);
  router.delete(one, requireAuthentication, csrfProtection, validateWorkspaceScope, validateSourceScope, controller.remove);
  return router;
}
