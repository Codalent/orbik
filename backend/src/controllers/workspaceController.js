/** Creates HTTP adapters for workspace use cases. */
export function createWorkspaceController(workspaceService) {
  return {
    /** Maps a validated idempotent creation to 201 or replay status 200. */
    async create(req, res, next) {
      try {
        const result = await workspaceService.create({ userId: req.auth.userId, ...req.validated });
        const { created, ...body } = result;
        res.set("Idempotency-Replayed", String(!created)).status(created ? 201 : 200).json(body);
      } catch (error) { next(error); }
    },
    /** Returns only the authenticated owner's safe workspace summaries. */
    async list(req, res, next) {
      try { res.json(await workspaceService.list({ userId: req.auth.userId })); } catch (error) { next(error); }
    },
    /** Applies a validated change of name or website; admins and the owner. */
    async update(req, res, next) {
      try { res.json(await workspaceService.update({ userId: req.auth.userId, ...req.validated })); } catch (error) { next(error); }
    },
    /** Deletes the workspace and everything in it; the owner, with its name repeated. */
    async remove(req, res, next) {
      try { res.json(await workspaceService.remove({ userId: req.auth.userId, ...req.validated })); } catch (error) { next(error); }
    },
    /** Maps an owner-authorized workspace selection to its mutation response. */
    async select(req, res, next) {
      try { res.json(await workspaceService.select({ userId: req.auth.userId, workspaceId: req.validated.workspaceId })); } catch (error) { next(error); }
    },
  };
}
