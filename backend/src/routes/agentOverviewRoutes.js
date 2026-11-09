import { Router } from "express";

import { requireAuthentication } from "../middleware/auth.js";
import { validateWorkspaceScope } from "../validators/shared.js";

/**
 * Builds the route behind the Agents overview page: every agent's newest run and schedule in a
 * workspace, in one read.
 *
 * `/agents` with nothing after it, beside the per-agent routes under `/agents/:agentSlug/…`, which
 * all have a further segment and so never match it. Read-only and up; it writes nothing.
 */
export function createAgentOverviewRouter({ agentOverviewService }) {
  const router = Router();

  router.get("/v1/workspaces/:workspaceId/agents", requireAuthentication, validateWorkspaceScope, async (req, res, next) => {
    try {
      res.json(await agentOverviewService.getOverview({ userId: req.auth.userId, workspaceId: req.validated.workspaceId }));
    } catch (error) { next(error); }
  });

  return router;
}
