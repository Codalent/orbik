import { AGENT_COLLECTIONS, log } from "@orbik/core";
import {
  BRAND_ROOT_PATH,
  BRAND_WRITER_SLUG,
  LIBRARY_NODE_KINDS,
  LIBRARY_SOURCE_KINDS,
  LibraryError,
  createLibraryStore,
} from "@orbik/library";

import { findSite } from "./scope.js";

/** A line that links into the brand folder: `[[/brand/design-system]]`, or one of its parts. */
const BRAND_LINK_LINE = /^.*\[\[\/brand(?:\/[^\]]*)?\]\].*(?:\r?\n|$)/gm;

/**
 * Takes the design-system guide out of every Library, once.
 *
 * Until v3 of the Design system agent the system was also written into the Library at
 * `/brand/design-system`, and the knowledge agent gave it a line in the index. The Brand page and
 * `brand_get` are where the system is read now, so the copy is removed: first the lines that link
 * to it, rewritten by the agent that wrote each file so the file stays that agent's to rewrite;
 * then the guide's files, as the Design system agent, which keeps a revision of each; then the
 * empty folder. The retrieval index forgets the files on its next pass, as it does any deleted file.
 *
 * Only what the agents wrote is touched. A file a person wrote in, a locked one, or a link inside
 * a person's own passage is left as it is and logged, and so is a folder a person made or that
 * still holds something. Run by the worker at start, and idempotent: once nothing the agent wrote
 * is left under `/brand`, every later start does nothing. It can be removed once no deployment
 * has a guide.
 *
 * @param {import("mongodb").Db} database connected database
 */
export async function retireBrandGuides(database) {
  const nodes = database.collection(AGENT_COLLECTIONS.libraryNodes);
  const guides = await nodes
    .find({
      path: new RegExp(`^${BRAND_ROOT_PATH}/`),
      kind: LIBRARY_NODE_KINDS.file,
      "authors.agent": BRAND_WRITER_SLUG,
      "authors.user": { $ne: true },
      hasUserContent: { $ne: true },
    })
    .project({ workspaceId: 1, path: 1 })
    .toArray();
  if (!guides.length) return;

  const library = createLibraryStore({ database });
  for (const workspaceId of uniqueIds(guides.map((guide) => guide.workspaceId))) {
    const scope = { workspaceId, siteId: await findSite(database, workspaceId) };
    await unlinkBrandFolder({ nodes, library, scope });
    for (const guide of guides.filter((row) => row.workspaceId.equals(workspaceId))) {
      await attempt("library.brand_guide_kept", guide.path, workspaceId, () =>
        library.remove({ scope, path: guide.path, actor: { agentSlug: BRAND_WRITER_SLUG } }));
    }
    // A folder is an arrangement and the store keeps no copy of one; it also refuses to move or
    // delete this one, which is why the empty folder the agent made is deleted here directly.
    const child = await nodes.findOne({ workspaceId, parentPath: BRAND_ROOT_PATH }, { projection: { _id: 1 } });
    if (!child) {
      await nodes.deleteOne({ workspaceId, path: BRAND_ROOT_PATH, kind: LIBRARY_NODE_KINDS.folder, "authors.user": { $ne: true } });
    }
    log("info", "library.brand_guide_retired", { workspaceId: workspaceId.toHexString() });
  }
}

/** Rewrites every agent-written file of one workspace that links into the brand folder, without the link. */
async function unlinkBrandFolder({ nodes, library, scope }) {
  const linking = await nodes
    .find({
      workspaceId: scope.workspaceId,
      kind: LIBRARY_NODE_KINDS.file,
      path: { $not: new RegExp(`^${BRAND_ROOT_PATH}(/|$)`) },
      markdown: /\[\[\/brand(\/|\]\])/,
      "authors.agent": { $type: "string" },
    })
    .project({ path: 1, title: 1, summary: 1, markdown: 1, sources: 1, tags: 1, authors: 1 })
    .toArray();
  for (const file of linking) {
    const markdown = file.markdown.replace(BRAND_LINK_LINE, "");
    if (markdown === file.markdown) continue;
    await attempt("library.brand_link_kept", file.path, scope.workspaceId, () =>
      library.writeFile({
        scope,
        path: file.path,
        title: file.title,
        summary: file.summary,
        markdown,
        sources: (file.sources ?? []).map(toSourceInput),
        tags: file.tags ?? [],
        actor: { agentSlug: file.authors.agent },
      }));
  }
}

/** A stored source reference as the store takes one: a page by its URL, anything else by its key. */
function toSourceInput(reference) {
  return { kind: reference.kind, ref: reference.kind === LIBRARY_SOURCE_KINDS.page ? (reference.url ?? reference.key) : reference.key };
}

/** Runs one Library change, and logs rather than throws when the store refuses it. */
async function attempt(event, path, workspaceId, change) {
  try {
    await change();
  } catch (error) {
    if (!(error instanceof LibraryError)) throw error;
    log("warn", event, { workspaceId: workspaceId.toHexString(), path, code: error.code });
  }
}

/** The distinct ObjectIds in a list, in the order first seen. */
function uniqueIds(ids) {
  const seen = new Map();
  for (const id of ids) seen.set(id.toHexString(), id);
  return [...seen.values()];
}
