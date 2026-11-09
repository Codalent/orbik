/** Creates HTTP adapters for asking a workspace's index a question and reading the threads. */
export function createConversationController(conversationService) {
  /** Every handler here answers for one workspace, on behalf of the signed-in owner. */
  function caller(req) {
    return { userId: req.auth.userId, workspaceId: req.validated.workspaceId };
  }

  return {
    /** Lists the workspace's conversations, most recently used first. */
    async listConversations(req, res, next) {
      try {
        res.json(await conversationService.listConversations({ ...caller(req), limit: req.validated.limit }));
      } catch (error) { next(error); }
    },

    /** Returns one conversation, with any finished answers folded in. */
    async getConversation(req, res, next) {
      try {
        res.json(await conversationService.getConversation({
          ...caller(req),
          conversationId: req.validated.conversationId,
        }));
      } catch (error) { next(error); }
    },

    /**
     * Starts a conversation with its first question.
     *
     * 202 rather than 201: the conversation exists, and the answer does not yet. The caller reads
     * the run's events for the rest, exactly as it does for any other agent.
     */
    async startConversation(req, res, next) {
      try {
        const result = await conversationService.startConversation({
          ...caller(req),
          question: req.validated.question,
          context: req.validated.context,
          attachments: req.validated.attachments,
        });
        res.status(202).json(result);
      } catch (error) { next(error); }
    },

    /** Asks a follow-up in an existing conversation. */
    async askFollowUp(req, res, next) {
      try {
        const result = await conversationService.askFollowUp({
          ...caller(req),
          conversationId: req.validated.conversationId,
          question: req.validated.question,
          context: req.validated.context,
          attachments: req.validated.attachments,
        });
        res.status(202).json(result);
      } catch (error) { next(error); }
    },

    /** Deletes a conversation. */
    async deleteConversation(req, res, next) {
      try {
        res.json(await conversationService.deleteConversation({
          ...caller(req),
          conversationId: req.validated.conversationId,
        }));
      } catch (error) { next(error); }
    },
  };
}
