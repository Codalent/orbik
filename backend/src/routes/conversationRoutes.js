import { Router } from "express";

import { createConversationController } from "../controllers/conversationController.js";
import { requireAuthentication } from "../middleware/auth.js";
import { validateWorkspaceScope } from "../validators/shared.js";
import {
  validateConversationListQuery,
  validateConversationScope,
  validateQuestionBody,
} from "../validators/conversationValidators.js";

/**
 * Builds the routes a person asks their workspace a question through.
 *
 * Asking is a POST that creates a run, not a streaming endpoint, and the reply says so: it returns
 * the conversation with an unanswered turn in it and the identifier of the run that will fill it.
 * The caller then reads `/runs/:runId/events` — the same endpoint every agent's progress comes
 * from, already rendered by the same component. That is the whole reason chat was built as a run:
 * a second progress channel would be a second thing to keep working.
 *
 * Nothing here enqueues. The run is created `queued` and the dispatcher in the agents process
 * turns it into work, which is the rule the rest of this API follows for the same two reasons: an
 * HTTP handler must not race a worker, and accepting a question must not depend on the queue being
 * reachable.
 */
export function createConversationRouter({ conversationService, csrfProtection }) {
  const router = Router();
  const controller = createConversationController(conversationService);
  const base = "/v1/workspaces/:workspaceId/conversations";
  const read = [requireAuthentication, validateWorkspaceScope];
  const write = [requireAuthentication, csrfProtection, validateWorkspaceScope];

  router.get(base, ...read, validateConversationListQuery, controller.listConversations);
  router.post(base, ...write, validateQuestionBody, controller.startConversation);
  router.get(`${base}/:conversationId`, ...read, validateConversationScope, controller.getConversation);
  router.post(
    `${base}/:conversationId/messages`,
    ...write,
    validateConversationScope,
    validateQuestionBody,
    controller.askFollowUp,
  );
  router.delete(`${base}/:conversationId`, ...write, validateConversationScope, controller.deleteConversation);

  return router;
}
