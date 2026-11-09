import { Router } from "express";

import { createActivityController } from "../controllers/activityController.js";
import { requireAuthentication } from "../middleware/auth.js";

/**
 * The live activity route: one account-scoped read of everything running right now.
 *
 * Read-only and account-scoped, like the AI call log: it spans workspaces because the question
 * it answers does.
 */
export function createActivityRouter({ activityService }) {
  const router = Router();
  const controller = createActivityController(activityService);
  router.get("/v1/activity", requireAuthentication, controller.describe);
  return router;
}
