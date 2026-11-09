/** HTTP handler for the live activity monitor. */
export function createActivityController(activityService) {
  return {
    async describe(req, res, next) {
      try {
        res.json(await activityService.describe({ userId: req.auth.userId }));
      } catch (error) { next(error); }
    },
  };
}
