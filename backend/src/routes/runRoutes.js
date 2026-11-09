import { Router } from "express";

import { createRunController } from "../controllers/runController.js";
import { requireAuthentication } from "../middleware/auth.js";
import { validateWorkspaceScope } from "../validators/shared.js";
import {
  validateCreateRun,
  validateEventQuery,
  validateRunIdempotencyKey,
  validateRunListQuery,
  validateRunScope,
} from "../validators/runValidators.js";

/**
 * Builds the authenticated agent-execution routes.
 *
 * Everything that touches a workspace's data is addressed through that workspace and reuses
 * `validateWorkspaceScope`, so ownership is enforced by the same check that protects the workspace
 * rather than by a second one that could drift out of step with it.
 *
 * One route is deliberately not workspace-scoped: the agent catalog is identical for everyone.
 */
export function createRunRouter({ runService, csrfProtection }) {
  const router = Router();
  const controller = createRunController(runService);
  const base = "/v1/workspaces/:workspaceId/runs";

  router.get("/v1/agents", requireAuthentication, controller.listAgents);

  router.post(
    base,
    requireAuthentication,
    csrfProtection,
    validateWorkspaceScope,
    validateRunIdempotencyKey,
    validateCreateRun,
    controller.createRun,
  );
  router.get(base, requireAuthentication, validateWorkspaceScope, validateRunListQuery, controller.listRuns);
  router.get(`${base}/:runId`, requireAuthentication, validateWorkspaceScope, validateRunScope, controller.getRun);
  router.get(
    `${base}/:runId/events`,
    requireAuthentication,
    validateWorkspaceScope,
    validateRunScope,
    validateEventQuery,
    controller.listEvents,
  );
  router.post(
    `${base}/:runId/cancel`,
    requireAuthentication,
    csrfProtection,
    validateWorkspaceScope,
    validateRunScope,
    controller.cancelRun,
  );

  return router;
}
