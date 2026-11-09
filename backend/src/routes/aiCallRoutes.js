import { Router } from "express";

import { createAiCallController } from "../controllers/aiCallController.js";
import { requireAuthentication } from "../middleware/auth.js";
import { validateAiCallListQuery, validateAiCallScope, validateAiCallSummaryQuery } from "../validators/aiCallValidators.js";

/**
 * Builds the AI call log routes.
 *
 * Account-scoped rather than workspace-scoped: the log answers "what has the AI
 * done for me", and an account's calls span its workspaces. Read-only, so no CSRF protection is
 * involved — there is nothing here a forged request could change.
 */
export function createAiCallRouter({ aiCallService }) {
  const router = Router();
  const controller = createAiCallController(aiCallService);

  router.get("/v1/ai-calls", requireAuthentication, validateAiCallListQuery, controller.listCalls);
  // Before `:callId`, which would otherwise take "summary" for an identifier and reject it.
  router.get("/v1/ai-calls/summary", requireAuthentication, validateAiCallSummaryQuery, controller.summarizeCalls);
  router.get("/v1/ai-calls/:callId", requireAuthentication, validateAiCallScope, controller.getCall);

  return router;
}
