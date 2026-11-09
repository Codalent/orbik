import { Router } from "express";

import { createLibraryController } from "../controllers/libraryController.js";
import { requireAuthentication } from "../middleware/auth.js";
import { validateWorkspaceScope } from "../validators/shared.js";
import {
  validateLibraryMoveBody,
  validateLibraryNodeBody,
  validateLibraryLocateQuery,
  validateLibraryNodePath,
  validateLibraryPassagesQuery,
  validateLibraryReorderBody,
  validateLibraryRestoreBody,
  validateLibrarySearchQuery,
  validateLibraryStructureBody,
  validateLibraryTreeQuery,
} from "../validators/libraryValidators.js";

/**
 * Builds the routes a person reads and edits the Library through.
 *
 * Unlike the read-only knowledge routes these replace, these write. The rule that made writing
 * safe to offer is not in this file: every write goes through the same store the agent tools use,
 * so a person's save is checked by exactly the rules an agent's write is, and their edits are
 * recorded in a way the next run cannot undo.
 *
 * A node is addressed by its path — `/library/nodes/clients/deeplearning-ai` — which is what
 * makes the API read like the thing it serves. Express hands the wildcard back as segments, and
 * the validator rebuilds and canonicalizes the path with the Library's own function.
 */
export function createLibraryRouter({ libraryService, csrfProtection }) {
  const router = Router();
  const controller = createLibraryController(libraryService);
  const base = "/v1/workspaces/:workspaceId/library";
  const read = [requireAuthentication, validateWorkspaceScope];
  const write = [requireAuthentication, csrfProtection, validateWorkspaceScope];

  router.get(base, ...read, validateLibraryTreeQuery, controller.getLibrary);
  // Before the wildcard node route, and a literal rather than a path: `/library/index` is the
  // retrieval index's status, while the Library file called `index` is at `/library/nodes/index`.
  router.get(`${base}/index`, ...read, controller.getIndexStatus);
  router.get(`${base}/tree`, ...read, validateLibraryTreeQuery, controller.getTree);
  // Which files a changed page of the site has left behind; a literal, like `/index` above.
  router.get(`${base}/freshness`, ...read, controller.getFreshness);
  router.get(`${base}/search`, ...read, validateLibrarySearchQuery, controller.search);
  // Search by meaning, over the retrieval index: the quick switcher's second half. A literal, like
  // `/search`, and read-only — it embeds the question and writes nothing to the index.
  router.get(`${base}/passages`, ...read, validateLibraryPassagesQuery, controller.searchPassages);
  // Where the copy of a page of the site is, by the page's address: how a list of pages — the
  // source ledger — opens one inside the Library.
  router.get(`${base}/locate`, ...read, validateLibraryLocateQuery, controller.locatePage);

  // The top-level structure: proposed by a model, chosen by the person, waited on by the write
  // run. Literals, like `/index`, so none of them is read as a node path.
  router.get(`${base}/structure`, ...read, controller.getStructure);
  router.put(`${base}/structure`, ...write, validateLibraryStructureBody, controller.chooseStructure);
  router.post(`${base}/structure/suggest`, ...write, controller.suggestStructureAgain);
  router.post(`${base}/structure/rebuild`, ...write, controller.requestRebuild);

  // The revisions routes are declared before the bare node route so that a path ending in
  // `/revisions` is read as the history of the file above it rather than as a node of that name.
  router.get(`${base}/revisions/*path`, ...read, validateLibraryNodePath, controller.listRevisions);
  router.get(`${base}/backlinks/*path`, ...read, validateLibraryNodePath, controller.getBacklinks);
  router.post(`${base}/restore/*path`, ...write, validateLibraryNodePath, validateLibraryRestoreBody, controller.restoreRevision);
  router.post(`${base}/move/*path`, ...write, validateLibraryNodePath, validateLibraryMoveBody, controller.moveNode);
  router.post(`${base}/lock/*path`, ...write, validateLibraryNodePath, controller.lockNode);
  router.post(`${base}/unlock/*path`, ...write, validateLibraryNodePath, controller.unlockNode);
  router.post(`${base}/reorder/*path`, ...write, validateLibraryNodePath, validateLibraryReorderBody, controller.reorderNode);

  router.get(`${base}/nodes/*path`, ...read, validateLibraryNodePath, controller.getNode);
  router.put(`${base}/nodes/*path`, ...write, validateLibraryNodePath, validateLibraryNodeBody, controller.saveNode);
  router.delete(`${base}/nodes/*path`, ...write, validateLibraryNodePath, controller.deleteNode);

  return router;
}
