import { Router } from "express";

import { requireAuthentication } from "../middleware/auth.js";

/**
 * The models this install offers, for anyone signed in: the active provider's tiers from the model
 * catalog, each with its model, display name and cost beside the most capable, and the display name
 * of every model the catalog knows.
 *
 * Not workspace-scoped: which models an install offers is the install's, the same in every
 * workspace. Read-only, so no CSRF protection is involved. An agent's own choice (the tiers it may
 * use, and which one its runs use) is on its setup (`GET /v1/workspaces/:id/agents/:slug/setup`).
 *
 * @param {object} options
 * @param {ReturnType<import("../services/modelService.js").createModelService>} options.modelService
 */
export function createAiModelRouter({ modelService }) {
  const router = Router();
  router.get("/v1/ai/models", requireAuthentication, async (_req, res, next) => {
    try {
      res.json(await modelService.catalog());
    } catch (error) { next(error); }
  });
  return router;
}
