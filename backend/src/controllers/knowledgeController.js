/** Creates HTTP adapters for reading the llms.txt file and the agents' source verdicts. */
export function createKnowledgeController(knowledgeService) {
  return {
    /** Returns what one agent decided about the workspace's sources. */
    async listSources(req, res, next) {
      try {
        res.json(await knowledgeService.listSources({
          userId: req.auth.userId,
          workspaceId: req.validated.workspaceId,
          agentSlug: req.validated.agentSlug,
          relevant: req.validated.relevant,
          limit: req.validated.limit,
          skip: req.validated.skip,
        }));
      } catch (error) { next(error); }
    },

    /** Records that a person wants a page the agent set aside to be read after all. */
    async includeSource(req, res, next) {
      try {
        res.json(await knowledgeService.includeSource({
          userId: req.auth.userId,
          workspaceId: req.validated.workspaceId,
          agentSlug: req.validated.agentSlug,
          key: req.validated.key,
        }));
      } catch (error) { next(error); }
    },

    /**
     * Returns the llms.txt file.
     *
     * Served as JSON with the parsed sections beside the text, and as the file itself when the
     * request asks for it — the one route works for the page that renders it and for a person
     * saving the file they are going to upload to their site.
     */
    async getLlmsDocument(req, res, next) {
      try {
        const result = await knowledgeService.getLlmsDocument({
          userId: req.auth.userId,
          workspaceId: req.validated.workspaceId,
        });
        if (req.validated.format !== "text") {
          res.json(result);
          return;
        }
        if (!result.document) {
          res.status(404).json({ error: { code: "LLMS_TXT_NOT_WRITTEN", message: "No llms.txt has been written yet." } });
          return;
        }
        res.type("text/markdown; charset=utf-8");
        res.setHeader("Content-Disposition", 'attachment; filename="llms.txt"');
        res.send(result.document.content);
      } catch (error) { next(error); }
    },
  };
}
