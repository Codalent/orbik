/** Creates HTTP adapters for the agent catalog, runs, and progress. */
export function createRunController(runService) {
  return {
    /** Lists the agents a user can run. */
    async listAgents(_req, res, next) {
      try {
        res.json(await runService.listAgents());
      } catch (error) { next(error); }
    },

    /**
     * Starts a run, reporting 202 when one was created and 200 for a replayed request.
     *
     * The distinction matters to a caller retrying after a dropped connection: 200 says "this is
     * the run your earlier request already started", not "here is a second one".
     */
    async createRun(req, res, next) {
      try {
        const { run, created } = await runService.createRun({
          userId: req.auth.userId,
          workspaceId: req.validated.workspaceId,
          agentSlug: req.validated.agentSlug,
          input: req.validated.input,
          requestKey: req.validated.requestKey,
        });
        res.status(created ? 202 : 200).json({ run: toResponse(run), created });
      } catch (error) { next(error); }
    },

    /** Lists a workspace's runs. */
    async listRuns(req, res, next) {
      try {
        res.json(await runService.listRuns({ userId: req.auth.userId, ...req.validated }));
      } catch (error) { next(error); }
    },

    /** Returns one run with its input and result. */
    async getRun(req, res, next) {
      try {
        res.json(await runService.getRun({ userId: req.auth.userId, ...req.validated }));
      } catch (error) { next(error); }
    },

    /** Returns a run's progress events after a sequence number the caller already has. */
    async listEvents(req, res, next) {
      try {
        res.json(await runService.listEvents({ userId: req.auth.userId, ...req.validated }));
      } catch (error) { next(error); }
    },

    /**
     * Asks a run to stop, reporting 200 when it is already over and 202 while it winds down.
     *
     * 202 is honest: the request was accepted, and something on a worker
     * still has to abort a provider call before the run is really finished.
     */
    async cancelRun(req, res, next) {
      try {
        const result = await runService.cancelRun({ userId: req.auth.userId, ...req.validated });
        res.status(result.stopped ? 200 : 202).json(result);
      } catch (error) { next(error); }
    },
  };
}

/** Projects a freshly created run onto the same summary shape every other endpoint returns. */
function toResponse(run) {
  return {
    id: run._id.toHexString(),
    agentSlug: run.agentSlug,
    agentVersion: run.agentVersion,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
  };
}
