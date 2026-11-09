/** Creates HTTP adapters for reading and writing the Library. */
export function createLibraryController(libraryService) {
  /** Every handler here answers for one workspace, on behalf of the signed-in owner. */
  function caller(req) {
    return { userId: req.auth.userId, workspaceId: req.validated.workspaceId };
  }

  return {
    /** Returns the Library's tree, size, sources and last run: everything the page opens with. */
    async getLibrary(req, res, next) {
      try {
        res.json(await libraryService.getLibrary({
          ...caller(req),
          path: req.validated.path,
          depth: req.validated.depth,
        }));
      } catch (error) { next(error); }
    },

    /** Returns what the retrieval index holds for this workspace. */
    async getIndexStatus(req, res, next) {
      try {
        res.json(await libraryService.getIndexStatus(caller(req)));
      } catch (error) { next(error); }
    },

    /** Returns one branch of the tree. */
    async getTree(req, res, next) {
      try {
        res.json(await libraryService.getTree({
          ...caller(req),
          path: req.validated.path,
          depth: req.validated.depth,
        }));
      } catch (error) { next(error); }
    },

    /** Returns one folder or file. */
    async getNode(req, res, next) {
      try {
        res.json(await libraryService.getNode({ ...caller(req), path: req.validated.path }));
      } catch (error) { next(error); }
    },

    /** Returns the files that link to one node. */
    async getBacklinks(req, res, next) {
      try {
        res.json(await libraryService.getBacklinks({ ...caller(req), path: req.validated.path }));
      } catch (error) { next(error); }
    },

    /** Returns the files of the knowledge base a page they were written from has moved past. */
    async getFreshness(req, res, next) {
      try {
        res.json(await libraryService.getFreshness(caller(req)));
      } catch (error) { next(error); }
    },

    /** Returns where the copy of one page of the site is. */
    async locatePage(req, res, next) {
      try {
        res.json(await libraryService.locatePage({ ...caller(req), url: req.validated.url }));
      } catch (error) { next(error); }
    },

    /** Returns passages that answer a question, found by meaning. */
    async searchPassages(req, res, next) {
      try {
        res.json(await libraryService.searchPassages({
          ...caller(req),
          query: req.validated.query,
          kinds: req.validated.kinds,
          limit: req.validated.limit,
        }));
      } catch (error) { next(error); }
    },

    /** Returns files matching a search. */
    async search(req, res, next) {
      try {
        res.json(await libraryService.search({
          ...caller(req),
          query: req.validated.query,
          path: req.validated.path,
          limit: req.validated.limit,
        }));
      } catch (error) { next(error); }
    },

    /**
     * Creates or replaces one node.
     *
     * 200 either way rather than 201 on create: the caller addressed the node by its path, so
     * "it exists now and this is what it says" is the whole answer, and the body reports which of
     * the two it was.
     */
    async saveNode(req, res, next) {
      try {
        res.json(await libraryService.saveNode({
          ...caller(req),
          path: req.validated.path,
          node: req.validated.node,
        }));
      } catch (error) { next(error); }
    },

    /** Moves or renames a node. */
    async moveNode(req, res, next) {
      try {
        res.json(await libraryService.moveNode({
          ...caller(req),
          path: req.validated.path,
          to: req.validated.to,
          title: req.validated.title,
        }));
      } catch (error) { next(error); }
    },

    /** Returns the structure step: what was chosen, what is proposed, the default. */
    async getStructure(req, res, next) {
      try {
        res.json(await libraryService.getStructure(caller(req)));
      } catch (error) { next(error); }
    },

    /** Saves the structure a person chose and creates its folders. */
    async chooseStructure(req, res, next) {
      try {
        res.json(await libraryService.chooseStructure({ ...caller(req), groups: req.validated.groups }));
      } catch (error) { next(error); }
    },

    /** Asks for the proposed structures again. */
    async suggestStructureAgain(req, res, next) {
      try {
        res.json(await libraryService.suggestStructureAgain(caller(req)));
      } catch (error) { next(error); }
    },

    /** Opens the structure step again: a rebuild. */
    async requestRebuild(req, res, next) {
      try {
        res.json(await libraryService.requestRebuild(caller(req)));
      } catch (error) { next(error); }
    },

    /** Locks a node against agent writes. */
    async lockNode(req, res, next) {
      try {
        res.json(await libraryService.setLocked({ ...caller(req), path: req.validated.path, locked: true }));
      } catch (error) { next(error); }
    },

    /** Lets agents write here again. */
    async unlockNode(req, res, next) {
      try {
        res.json(await libraryService.setLocked({ ...caller(req), path: req.validated.path, locked: false }));
      } catch (error) { next(error); }
    },

    /** Sets where a node sits among its siblings. */
    async reorderNode(req, res, next) {
      try {
        res.json(await libraryService.reorderNode({
          ...caller(req),
          path: req.validated.path,
          order: req.validated.order,
        }));
      } catch (error) { next(error); }
    },

    /** Deletes a file, or an empty folder. */
    async deleteNode(req, res, next) {
      try {
        res.json(await libraryService.deleteNode({ ...caller(req), path: req.validated.path }));
      } catch (error) { next(error); }
    },

    /** Returns one file's kept versions. */
    async listRevisions(req, res, next) {
      try {
        res.json(await libraryService.listRevisions({ ...caller(req), path: req.validated.path }));
      } catch (error) { next(error); }
    },

    /** Puts a file back to one of its kept versions. */
    async restoreRevision(req, res, next) {
      try {
        res.json(await libraryService.restoreRevision({
          ...caller(req),
          path: req.validated.path,
          revision: req.validated.revision,
        }));
      } catch (error) { next(error); }
    },
  };
}
