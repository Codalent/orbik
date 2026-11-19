/** Creates HTTP adapters for a workspace's sources. */
export function createSourceController(sourceService) {
  /** One adapter: the service's answer as JSON, with the status given. */
  const handle = (call, status = 200) => async (req, res, next) => {
    try {
      res.status(status).json(await call(req));
    } catch (error) { next(error); }
  };
  const base = (req) => ({ userId: req.auth.userId, workspaceId: req.validated.workspaceId });

  return {
    list: handle((req) => sourceService.list(base(req))),
    get: handle((req) => sourceService.get({ ...base(req), sourceId: req.validated.sourceId })),
    check: handle((req) => sourceService.check({ ...base(req), url: req.validated.url })),
    add: handle((req) => sourceService.add({ ...base(req), source: req.validated.source }), 201),
    update: handle((req) => sourceService.update({ ...base(req), sourceId: req.validated.sourceId, changes: req.validated.changes })),
    remove: handle((req) => sourceService.remove({ ...base(req), sourceId: req.validated.sourceId })),
    suggestions: handle((req) => sourceService.suggestions(base(req))),
    dismissSuggestion: handle((req) => sourceService.dismissSuggestion({ ...base(req), url: req.validated.url })),
  };
}
