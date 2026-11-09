import { Router } from "express";

import { createKnowledgeController } from "../controllers/knowledgeController.js";
import { requireAuthentication } from "../middleware/auth.js";
import { validateWorkspaceScope } from "../validators/shared.js";
import { validateAgentScope } from "../validators/agentSetupValidators.js";
import { validateLlmsQuery, validateSourceIncludeBody, validateSourcesQuery } from "../validators/knowledgeValidators.js";

/**
 * Builds the routes that read the llms.txt file and the agents' source verdicts.
 *
 * Every route here reads, but one. llms.txt is a deliverable whose every link is checked against
 * pages the crawler actually fetched; the ledger is an agent's own record of what it has accounted
 * for. Neither is something a person should be able to edit behind the checks that produce it, and
 * the Library — the one thing people genuinely need to correct — has its own router where writes
 * go through the same store the agent tools use.
 *
 * The exception is the POST below. It does not edit a verdict so much as answer one: the ledger's
 * whole purpose is to tell a person why a page was left out, and until now that conversation only
 * went one way. Including a page records a request, not a review — the source layer's next pass
 * marks the page chosen, and its own rules still apply — so nothing here tells an agent it has
 * seen something it has not.
 *
 * The source verdicts hang off the agent rather than off any one output, because both knowledge
 * agents have their own and each judges the same pages differently.
 */
export function createKnowledgeRouter({ knowledgeService, csrfProtection }) {
  const router = Router();
  const controller = createKnowledgeController(knowledgeService);
  const base = "/v1/workspaces/:workspaceId";
  const scoped = [requireAuthentication, validateWorkspaceScope];
  const write = [requireAuthentication, csrfProtection, validateWorkspaceScope];

  router.get(`${base}/llms-txt`, ...scoped, validateLlmsQuery, controller.getLlmsDocument);
  router.get(`${base}/agents/:agentSlug/sources`, ...scoped, validateAgentScope, validateSourcesQuery, controller.listSources);
  router.post(
    `${base}/agents/:agentSlug/sources/include`,
    ...write,
    validateAgentScope,
    validateSourceIncludeBody,
    controller.includeSource,
  );

  return router;
}
