/**
 * HTTP handlers for the AI call log.
 *
 * @param {object} aiCallService
 */
export function createAiCallController(aiCallService) {
  return {
    async listCalls(req, res, next) {
      try {
        const { limit, before, filters } = req.validated;
        res.json(await aiCallService.listCalls({ userId: req.auth.userId, limit, before, filters }));
      } catch (error) { next(error); }
    },

    async summarizeCalls(req, res, next) {
      try {
        res.json(await aiCallService.summarizeCalls({ userId: req.auth.userId, filters: req.validated.filters }));
      } catch (error) { next(error); }
    },

    async getCall(req, res, next) {
      try {
        res.json(await aiCallService.getCall({ userId: req.auth.userId, callId: req.params.callId }));
      } catch (error) { next(error); }
    },
  };
}
