/** Creates HTTP adapters for a workspace's Home page. */
export function createHomeController(homeService) {
  return {
    /** Returns the setup checklist and the workspace at a glance, for the signed-in person. */
    async getHome(req, res, next) {
      try {
        res.json(await homeService.getHome({ userId: req.auth.userId, workspaceId: req.validated.workspaceId }));
      } catch (error) { next(error); }
    },

    /** Saves a skip, an unskip or the checklist's hidden state, and returns the preferences. */
    async updatePreferences(req, res, next) {
      try {
        res.json(await homeService.updatePreferences({
          userId: req.auth.userId,
          workspaceId: req.validated.workspaceId,
          skip: req.validated.skip,
          unskip: req.validated.unskip,
          hidden: req.validated.hidden,
        }));
      } catch (error) { next(error); }
    },
  };
}
