import { WORKSPACE_ICON_LIMITS } from "@orbik/assets";
import express, { Router } from "express";

import { createWorkspaceController } from "../controllers/workspaceController.js";
import { requireAuthentication } from "../middleware/auth.js";
import { validateWorkspaceScope } from "../validators/shared.js";
import {
  validateIconChoice,
  validateIconQuery,
  validateIconUpload,
  validateWorkspaceCreate,
  validateWorkspaceDelete,
  validateWorkspaceSelection,
  validateWorkspaceUpdate,
} from "../validators/workspaceValidators.js";

/**
 * Builds the authenticated workspace routes: list, create and select, and — by the caller's role
 * in the workspace — change its name, website or icon (admin and up) and delete it (the owner).
 *
 * The icon is a picture, read by an `<img>` with the session cookie like a brand image, and sent by
 * an upload whose body is the file itself (`WORKSPACE_ICON_UPLOAD_PATH` in middleware/security.js).
 */
export function createWorkspaceRouter({ workspaceService, csrfProtection }) {
  const router = Router();
  const controller = createWorkspaceController(workspaceService);
  router.get("/v1/workspaces", requireAuthentication, controller.list);
  router.post("/v1/workspaces", requireAuthentication, csrfProtection, validateWorkspaceCreate, controller.create);
  router.patch("/v1/workspaces/:workspaceId", requireAuthentication, csrfProtection, validateWorkspaceUpdate, controller.update);
  router.delete("/v1/workspaces/:workspaceId", requireAuthentication, csrfProtection, validateWorkspaceDelete, controller.remove);
  router.post("/v1/workspaces/:workspaceId/selection", requireAuthentication, csrfProtection, validateWorkspaceSelection, controller.select);

  const icon = "/v1/workspaces/:workspaceId/icon";
  router.get(icon, requireAuthentication, validateWorkspaceScope, validateIconQuery, controller.getIcon);
  router.put(icon, requireAuthentication, csrfProtection, validateWorkspaceScope, validateIconChoice, controller.chooseIcon);
  // Read past the limit, up to 2 MB, so a picture a little too large is refused by the service with
  // what fits rather than cut off by the parser.
  const raw = express.raw({ type: () => true, limit: Math.max(WORKSPACE_ICON_LIMITS.bytes * 4, 2 * 1024 * 1024) });
  router.post(`${icon}/upload`, requireAuthentication, csrfProtection, validateWorkspaceScope, raw, validateIconUpload, controller.uploadIcon);
  return router;
}
