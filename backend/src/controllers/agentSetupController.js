/** Creates HTTP adapters for an agent's setup and schedule. */
export function createAgentSetupController(agentSetupService) {
  return {
    /** Returns the setup with the agent and whether there is a crawl to choose pages from. */
    async getSetup(req, res, next) {
      try {
        res.json(await agentSetupService.getSetup({ userId: req.auth.userId, ...req.validated }));
      } catch (error) { next(error); }
    },

    /** Saves the pages to track. */
    async saveSetup(req, res, next) {
      try {
        res.json(await agentSetupService.saveSetup({ userId: req.auth.userId, ...req.validated }));
      } catch (error) { next(error); }
    },

    /** Starts or pauses the agent's schedule. */
    async setWorking(req, res, next) {
      try {
        res.json(await agentSetupService.setWorking({ userId: req.auth.userId, ...req.validated }));
      } catch (error) { next(error); }
    },
  };
}
