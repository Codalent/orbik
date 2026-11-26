import { Router } from "express";

import { createAgentSetupController } from "../controllers/agentSetupController.js";
import { requireAuthentication } from "../middleware/auth.js";
import { validateAgentScope, validateModelBody, validateSetupBody, validateWorkingBody } from "../validators/agentSetupValidators.js";
import { validateWorkspaceScope } from "../validators/shared.js";

/**
 * Builds the routes behind an agent's page: its setup, its schedule and its model.
 *
 * Addressed through the workspace like every other workspace-owned thing, so ownership is enforced
 * by the same check that protects the workspace.
 */
export function createAgentSetupRouter({ agentSetupService, csrfProtection }) {
  const router = Router();
  const controller = createAgentSetupController(agentSetupService);
  const base = "/v1/workspaces/:workspaceId/agents/:agentSlug";
  const scoped = [requireAuthentication, validateWorkspaceScope, validateAgentScope];

  router.get(`${base}/setup`, ...scoped, controller.getSetup);
  router.put(`${base}/setup`, requireAuthentication, csrfProtection, validateWorkspaceScope, validateAgentScope, validateSetupBody, controller.saveSetup);
  router.put(`${base}/working`, requireAuthentication, csrfProtection, validateWorkspaceScope, validateAgentScope, validateWorkingBody, controller.setWorking);
  router.put(`${base}/model`, requireAuthentication, csrfProtection, validateWorkspaceScope, validateAgentScope, validateModelBody, controller.setModel);

  return router;
}
