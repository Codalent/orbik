import { Router } from "express";

import { createWorkspaceController } from "../controllers/workspaceController.js";
import { requireAuthentication } from "../middleware/auth.js";
import {
  validateWorkspaceCreate,
  validateWorkspaceDelete,
  validateWorkspaceSelection,
  validateWorkspaceUpdate,
} from "../validators/workspaceValidators.js";

/**
 * Builds the authenticated workspace routes: list, create and select, and — by the caller's role
 * in the workspace — change its name or website (admin and up) and delete it (the owner).
 */
export function createWorkspaceRouter({ workspaceService, csrfProtection }) {
  const router = Router();
  const controller = createWorkspaceController(workspaceService);
  router.get("/v1/workspaces", requireAuthentication, controller.list);
  router.post("/v1/workspaces", requireAuthentication, csrfProtection, validateWorkspaceCreate, controller.create);
  router.patch("/v1/workspaces/:workspaceId", requireAuthentication, csrfProtection, validateWorkspaceUpdate, controller.update);
  router.delete("/v1/workspaces/:workspaceId", requireAuthentication, csrfProtection, validateWorkspaceDelete, controller.remove);
  router.post("/v1/workspaces/:workspaceId/selection", requireAuthentication, csrfProtection, validateWorkspaceSelection, controller.select);
  return router;
}
