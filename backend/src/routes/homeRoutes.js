import { Router } from "express";

import { createHomeController } from "../controllers/homeController.js";
import { requireAuthentication } from "../middleware/auth.js";
import { validateHomePreferences } from "../validators/homeValidators.js";
import { validateWorkspaceScope } from "../validators/shared.js";

/**
 * Builds the routes behind a workspace's Home page.
 *
 * One read for the whole page — every step of the setup checklist and the workspace at a glance —
 * because the page is polled every few seconds while a step is in progress, and seven reads each
 * polled on its own would be seven chances for the steps to disagree with one another. It writes
 * nothing. The one write is a person's own view of the page: which recommended steps they
 * skipped, and whether they hid the checklist.
 *
 * Read-only and up, both: everybody who can open a workspace has a Home page in it.
 */
export function createHomeRouter({ homeService, csrfProtection }) {
  const router = Router();
  const controller = createHomeController(homeService);
  const base = "/v1/workspaces/:workspaceId/home";

  router.get(base, requireAuthentication, validateWorkspaceScope, controller.getHome);
  router.patch(`${base}/preferences`, requireAuthentication, csrfProtection, validateWorkspaceScope, validateHomePreferences, controller.updatePreferences);
  return router;
}
