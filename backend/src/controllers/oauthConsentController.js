/** Creates HTTP adapters for the consent screen's decisions. */
export function createOauthConsentController(oauthService) {
  return {
    /** Describes a pending request for the consent screen. */
    async describeRequest(req, res, next) {
      try {
        res.json(await oauthService.describeRequest({ userId: req.auth.userId, requestId: req.validated.requestId }));
      } catch (error) { next(error); }
    },

    /** Records consent for the workspaces the person chose, and whether the app may write. */
    async approveRequest(req, res, next) {
      try {
        res.json(await oauthService.approveRequest({
          userId: req.auth.userId,
          requestId: req.validated.requestId,
          workspaces: req.validated.workspaces,
          write: req.validated.write,
        }));
      } catch (error) { next(error); }
    },

    /** Records a refusal. */
    async denyRequest(req, res, next) {
      try {
        res.json(await oauthService.denyRequest({ requestId: req.validated.requestId }));
      } catch (error) { next(error); }
    },
  };
}
