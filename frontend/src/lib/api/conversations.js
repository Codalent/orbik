import { apiFetch } from "./client";
import { requireId } from "./ids";

/**
 * Asking a workspace's index a question, as the browser sees it.
 *
 * Asking returns the conversation with an unanswered turn in it and the run that will fill it. The
 * page then reads that run's events through the ordinary run API — the same endpoint every agent's
 * progress comes from — and re-reads the conversation once the run finishes. There is no second
 * progress channel for chat, deliberately: one that streamed its own way would be one more thing
 * to keep working when runs change.
 */

/**
 * Where a workspace's conversations are listed from, most recently used first; also their cache
 * key.
 */
export function conversationsPath(workspaceId, { limit = 50 } = {}) {
  return `/v1/workspaces/${requireId(workspaceId, "Workspace")}/conversations?limit=${Number(limit)}`;
}

/** Reads one conversation, with any finished answers folded in. */
export function getConversation(workspaceId, conversationId) {
  return apiFetch(
    `/v1/workspaces/${requireId(workspaceId, "Workspace")}/conversations/${requireId(conversationId, "Conversation")}`,
  );
}

/**
 * The body a question is sent with: the question, where in the app it was asked from when that is
 * known (the page's name, its address, and the Library file on screen) so "save this here" or
 * "move this file" means something, and the model tier picked to answer it.
 */
function questionBody(question, context, attachments, modelTier) {
  return JSON.stringify({
    question,
    ...(context ? { context } : {}),
    // Files already uploaded to the brand, sent with the message by their identifiers.
    ...(attachments?.length ? { attachments } : {}),
    // A tier of the model catalog (`large`, `medium`, `small`), never a model; left out, the API
    // answers with the default.
    ...(modelTier ? { modelTier } : {}),
  });
}

/** Starts a conversation with its first question. */
export function startConversation(workspaceId, question, context = null, attachments = [], modelTier = null) {
  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/conversations`, {
    method: "POST",
    body: questionBody(question, context, attachments, modelTier),
  });
}

/** Asks a follow-up, which is answered with the turns before it as context. */
export function askFollowUp(workspaceId, conversationId, question, context = null, attachments = [], modelTier = null) {
  return apiFetch(
    `/v1/workspaces/${requireId(workspaceId, "Workspace")}/conversations/${requireId(conversationId, "Conversation")}/messages`,
    { method: "POST", body: questionBody(question, context, attachments, modelTier) },
  );
}

/** Deletes a conversation. The runs behind it stay in the run history, as every run does. */
export function deleteConversation(workspaceId, conversationId) {
  return apiFetch(
    `/v1/workspaces/${requireId(workspaceId, "Workspace")}/conversations/${requireId(conversationId, "Conversation")}`,
    { method: "DELETE" },
  );
}

/**
 * Where the retrieval index's status — what it currently holds for this workspace — is read from;
 * also its cache key.
 */
export function indexStatusPath(workspaceId) {
  return `/v1/workspaces/${requireId(workspaceId, "Workspace")}/library/index`;
}
