import { AGENT_COLLECTIONS, escapeRegExp, toObjectId, tryNormalizeUrl } from "@orbik/core";

import {
  checkAgentWrite,
  extractWikiLinks,
  markUserBlocks,
  markdownBlockHashes,
  recordUserEdit,
  relinkMarkdown,
  stripUserBlockMarkers,
} from "./blocks.js";
import {
  LIBRARY_ERROR_CODES,
  LIBRARY_LIMITS,
  LIBRARY_NODE_KINDS,
  LIBRARY_FILE_ROLES,
  LIBRARY_RESERVED_PATHS,
  LIBRARY_ROLES,
  LIBRARY_ROOT_PATH,
  LIBRARY_SOURCE_KINDS,
  LIBRARY_WRITE_CHANNELS,
  LibraryError,
  compareLibrarySiblings,
  isWithinLibraryPath,
  libraryAncestorPaths,
  libraryDepth,
  libraryParentPath,
  librarySegmentOf,
  normalizeLibraryPath,
  slugifySegment,
} from "./library.js";
import { BRAND_ROOT_PATH, BRAND_WRITER_SLUG, isBrandLayerPath } from "./brand.js";
import {
  SOURCE_LAYER_WRITER_SLUG,
  SOURCE_ROOT_PATH,
  isReservedSourceFolder,
  isSourceLayerPath,
} from "./sourceLayer.js";
import { createSourceProviders, resolveSourceReferences } from "./sources.js";

/** The channels a person's write may name in `via`. */
const WRITE_CHANNELS = Object.freeze(Object.values(LIBRARY_WRITE_CHANNELS));

/**
 * The Library: one filesystem of folders and files per workspace, written by agents and by people.
 *
 * This is the only implementation of the Library's rules, and that is the point. An agent calling
 * `library.write` and a person saving a file through the API are two doors into the same
 * documents; if each carried its own idea of what a path is, when a folder may be deleted, or what
 * a lock means, the two would drift on the first change and the symptom would be a file a person
 * could create and an agent could not read. The tools and the API are thin adapters over this
 * store: they translate a failure into a `ToolError` or an HTTP error and nothing more.
 *
 * Two rules here are worth stating because they shape everything else.
 *
 * **What must survive a write, not who may write.** Files have no owner. Every block a person
 * wrote is recorded on the node, and an agent's version is refused unless it still contains all of
 * them; every block a person deleted is recorded too, and an agent that reintroduces one is
 * refused. That is what makes it safe to let an agent edit a document somebody has corrected —
 * and it is checked here rather than asked for in instructions, because an instruction is a
 * suggestion to a model and a check is not.
 *
 * **Provenance is not optional for an agent.** Every source an agent cites is resolved against
 * something the workspace actually holds before the file is stored, so a Library statement can
 * always be traced to the page it came from. A person's own writing cites nothing, and is marked
 * as theirs instead: the distinction between "the site says this" and "we know this" is the
 * difference between a briefing that can be trusted and one that cannot.
 *
 * @param {object} dependencies collaborators
 * @param {import("mongodb").Db} dependencies.database connected database
 * @param {() => Date} [dependencies.now] clock; defaults to the system clock
 */
export function createLibraryStore({ database, now = () => new Date() }) {
  const nodes = database.collection(AGENT_COLLECTIONS.libraryNodes);
  const revisions = database.collection(AGENT_COLLECTIONS.libraryRevisions);
  // `library_structures` held the sections the top level used to be shown under. The top level is
  // folders now, and nothing reads or writes that collection; its rows are left where they are.
  const sourceState = database.collection(AGENT_COLLECTIONS.sourceNotes);
  const providers = createSourceProviders(database);

  /**
   * Normalizes who is writing.
   *
   * Every rule that differs between the two writers asks this, and it answers with a value rather
   * than with a boolean scattered through the code: an agent write carries the agent's slug and
   * the run that made it, a person's carries their identifier, and a caller that supplied neither
   * is a programming mistake rather than an anonymous writer.
   *
   * A person may also write *through* something: their own AI, connected over MCP with a
   * credential they allowed to write. That write is still theirs — what it adds is claimed as
   * their writing, exactly as a save from the Library page is — and `via` says which credential
   * and which client made it, so the history can say "you, via Claude". It is kept apart from a
   * save at the keyboard in one respect: a lock is the person's own opt-out, and a client acting
   * for them is held to it (`assertNotLocked`).
   */
  function actorOf(actor) {
    if (actor?.agentSlug) {
      return { isAgent: true, agentSlug: actor.agentSlug, runId: actor.runId ?? null, userId: null, via: null };
    }
    if (actor?.userId) {
      return { isAgent: false, agentSlug: null, runId: null, userId: toObjectId(actor.userId), via: viaOf(actor.via) };
    }
    throw new LibraryError({
      code: LIBRARY_ERROR_CODES.invalidPath,
      message: "A Library write must say who is writing.",
    });
  }

  /**
   * What a person wrote through, as it is stored: the channel, the credential, and the client's
   * name as the credential records it. Null for a save made in Orbik itself.
   */
  function viaOf(via) {
    if (!via) return null;
    if (!WRITE_CHANNELS.includes(via.kind)) {
      throw new LibraryError({
        code: LIBRARY_ERROR_CODES.invalidPath,
        message: `A write through a client must name how it arrived: ${WRITE_CHANNELS.join(", ")}.`,
      });
    }
    const client = typeof via.client === "string" ? via.client.trim().slice(0, LIBRARY_LIMITS.title) : "";
    return {
      kind: via.kind,
      tokenId: via.tokenId ? toObjectId(via.tokenId) : null,
      client: client || null,
    };
  }

  /**
   * Who a node or a revision says changed it last.
   *
   * A person's save in Orbik keeps the shape it always had, `{userId}`; one made through a client
   * adds `via`. Every write records it through here, so the two cannot drift apart.
   */
  function updatedByOf(writer) {
    if (writer.isAgent) return { agentSlug: writer.agentSlug, runId: writer.runId };
    return writer.via ? { userId: writer.userId, via: writer.via } : { userId: writer.userId };
  }

  /** The workspace filter every query starts from; nothing here is reachable across workspaces. */
  function scopeOf(scope) {
    if (!scope?.workspaceId) {
      throw new LibraryError({
        code: LIBRARY_ERROR_CODES.invalidPath,
        message: "The Library can only be read inside a workspace.",
      });
    }
    return {
      workspaceId: toObjectId(scope.workspaceId),
      siteId: scope.siteId ?? null,
    };
  }

  /** One node, or null. */
  function findNode(workspaceId, path, projection = {}) {
    return nodes.findOne({ workspaceId, path }, Object.keys(projection).length ? { projection } : undefined);
  }

  /**
   * Refuses a write inside a locked node, from a writer a lock is meant to stop.
   *
   * A lock is an opt-out rather than an ownership claim: it stops agents — and a person's own AI
   * writing for them over MCP, which is not the person at the keyboard — and nothing else. It
   * applies to everything underneath, because a person who locks `/clients` means the client files
   * and not only the folder's own summary.
   */
  async function assertNotLocked(workspaceId, path, writer) {
    if (!writer.isAgent && !writer.via) return;
    const paths = [...libraryAncestorPaths(path).filter((ancestor) => ancestor !== LIBRARY_ROOT_PATH), path];
    if (!paths.length) return;
    const locked = await nodes.findOne(
      { workspaceId, path: { $in: paths }, locked: true },
      { projection: { path: 1, title: 1 } },
    );
    if (locked) {
      throw new LibraryError({
        code: LIBRARY_ERROR_CODES.nodeLocked,
        message: writer.isAgent
          ? `${locked.path} is locked, so agents do not write inside it. Leave it alone and say so ` +
            "in your reply; a person unlocks it if they want you to maintain it."
          : `${locked.path} is locked: the person keeps it out of reach of Orbik's agents and of any ` +
            "AI connected to Orbik. Leave it alone and say so in your reply; they can unlock it on " +
            "the Library page if they want it changed.",
        detail: { path: locked.path },
      });
    }
  }

  /** Refuses a path whose parent folder has not been created. */
  async function assertParent(workspaceId, path) {
    const parentPath = libraryParentPath(path);
    if (parentPath === LIBRARY_ROOT_PATH) return;
    const parent = await findNode(workspaceId, parentPath, { kind: 1 });
    if (!parent) {
      throw new LibraryError({
        code: LIBRARY_ERROR_CODES.parentMissing,
        message: `${parentPath} does not exist yet. Create it with library.mkdir before writing inside it.`,
        detail: { path: parentPath },
      });
    }
    if (parent.kind !== LIBRARY_NODE_KINDS.folder) {
      throw new LibraryError({
        code: LIBRARY_ERROR_CODES.notAFolder,
        message: `${parentPath} is a file, so nothing can be filed inside it.`,
        detail: { path: parentPath },
      });
    }
  }

  /**
   * Refuses a write into the source layer by anyone but the job that owns it.
   *
   * `/sources` is a mirror, not a document: every path in it is derived from a URL and every file
   * in it is one page as the crawler rendered it. An agent writing there would be inventing a
   * source, which is exactly the thing a provenance trail is supposed to make impossible — so the
   * rule is enforced here rather than asked for in instructions. A *person* may write inside a
   * source file, because annotating what the site says is the most useful thing anybody can do to
   * one; their blocks are protected like any other.
   */
  function assertSourceLayerWriter(path, writer) {
    if (!writer.isAgent || writer.agentSlug === SOURCE_LAYER_WRITER_SLUG) return;
    if (!isSourceLayerPath(path)) return;
    throw new LibraryError({
      code: LIBRARY_ERROR_CODES.reservedPath,
      message:
        `${SOURCE_ROOT_PATH} holds a copy of every source page, kept in step with the site by ` +
        "code. Read it and link to it, but do not write inside it: what a page says is its " +
        "source file, and what it means belongs in your own subject files.",
      detail: { path },
    });
  }

  /**
   * Refuses a write into the brand folder by any agent but the one that measures the site.
   *
   * `/brand` holds the design system as derived from the rendered site: colours that were
   * painted, type that was set. An agent that reads the words of pages has never seen any of that, so a write
   * from it would be a guess filed under a path that promises a measurement. Enforced here rather
   * than asked for in instructions, as the source layer's rule is. A *person* may write inside it,
   * and what they write is protected like any other writing of theirs.
   */
  function assertBrandLayerWriter(path, writer) {
    if (!writer.isAgent || writer.agentSlug === BRAND_WRITER_SLUG) return;
    if (!isBrandLayerPath(path)) return;
    throw new LibraryError({
      code: LIBRARY_ERROR_CODES.reservedPath,
      message:
        `${BRAND_ROOT_PATH} holds the design system, written by the Design system agent from the ` +
        "site as rendered in a browser. Read it and link to it, but do not write inside it.",
      detail: { path },
    });
  }

  /** Refuses moving or deleting the folders the source layer and the brand are addressed by. */
  function assertNotReservedSourceFolder(path) {
    if (path === BRAND_ROOT_PATH) {
      throw new LibraryError({
        code: LIBRARY_ERROR_CODES.reservedPath,
        message: `${path} is where the design system is found by everything that reads it. It stays where it is.`,
        detail: { path },
      });
    }
    if (!isReservedSourceFolder(path)) return;
    throw new LibraryError({
      code: LIBRARY_ERROR_CODES.reservedPath,
      message: `${path} is how every source file is addressed. It stays where it is.`,
      detail: { path },
    });
  }

  /**
   * Refuses an agent anything at the top level of the Library.
   *
   * The top-level folders are the structure a person chose when the Library was first built (see
   * `./structure.js`), created by code as theirs. An agent files into them and makes what it
   * needs beneath them; it never adds a folder or a file beside them, because a top-level folder
   * nobody chose is exactly what the structure step replaced. What has no home is said in the
   * run's reply instead. The two code writers that own a fixed top-level folder — the mirror and
   * the Design system agent — may create theirs.
   */
  function assertNotTopLevelForAgent(path, writer) {
    if (!writer.isAgent || libraryDepth(path) !== 1) return;
    if (path === SOURCE_ROOT_PATH && writer.agentSlug === SOURCE_LAYER_WRITER_SLUG) return;
    if (path === BRAND_ROOT_PATH && writer.agentSlug === BRAND_WRITER_SLUG) return;
    throw new LibraryError({
      code: LIBRARY_ERROR_CODES.topLevelProtected,
      message:
        `${path} would sit at the top level of the Library, and the top-level folders are the ones ` +
        "the person chose. File it inside one of them — library.tree lists them — and if none " +
        "fits, leave it out and say so in your reply.",
      detail: { path },
    });
  }

  /**
   * Where the overview and the index are, and the folder they belong in.
   *
   * By role first: the file that carries it, wherever a rename has taken it. A Library whose
   * start folder exists but whose overview has not been written yet is told where it will be,
   * `<start>/overview`, which is where the write run puts it. A Library from before roles has
   * neither, and keeps its entry points at `/overview` and `/index` until it is rebuilt.
   */
  async function rolePaths(workspaceId) {
    const rows = await nodes
      .find({ workspaceId, role: { $in: Object.values(LIBRARY_ROLES) } })
      .project({ path: 1, role: 1 })
      .toArray();
    const holder = (role) => rows.find((row) => row.role === role)?.path ?? null;
    const start = holder(LIBRARY_ROLES.start);
    const pathOf = (role) => holder(role) ?? (start ? `${start}/${role}` : LIBRARY_RESERVED_PATHS[role]);
    return {
      start,
      [LIBRARY_ROLES.overview]: pathOf(LIBRARY_ROLES.overview),
      [LIBRARY_ROLES.index]: pathOf(LIBRARY_ROLES.index),
    };
  }

  /** The role a path holds or is kept for, or null: `overview` and `index` only. */
  async function fileRoleAt(workspaceId, path) {
    const roles = await rolePaths(workspaceId);
    return LIBRARY_FILE_ROLES.find((role) => roles[role] === path) ?? null;
  }

  /**
   * The role a file written at this path should take on, or null.
   *
   * Only inside a start folder. A Library from before roles keeps its overview at `/overview`
   * with no role on it; stamping one there would pin the entry point to the top level, where the
   * write run can no longer write, and the rebuild that moves it into the chosen structure would
   * find a role file it may not touch.
   */
  async function roleToAssign(workspaceId, path) {
    const roles = await rolePaths(workspaceId);
    if (!roles.start) return null;
    return LIBRARY_FILE_ROLES.find((role) => roles[role] === path) ?? null;
  }

  /**
   * Rewrites every `[[link]]` in this Library that pointed at a moved node or anything under it.
   *
   * The outbound links are already stored on each file as resolved paths (`links`), so which
   * files to touch is one indexed query rather than a scan of every document's text. Each file
   * is rewritten whole in one write — its text, its `links`, and the hashes that record which of
   * its blocks are a person's and which the agent's — and gets a revision of its own, attributed
   * to whoever renamed and saying what was renamed, so the change shows in its history and can be
   * restored like any other. Links inside a person's blocks are rewritten too: a person who wrote
   * `[[/02-offer/pricing]]` meant the file, not the old address of it.
   *
   * Every rewritten file has a new revision, and every moved one a new path, which is what the
   * index pass compares: both are embedded again on its next pass, so a search's `cite` names the
   * new path.
   *
   * @returns {Promise<string[]>} the paths of the files that were rewritten
   */
  async function rewriteInboundLinks(workspaceId, from, to, writer, at) {
    const inside = new RegExp(`^${escapeRegExp(from)}/`);
    const linking = await nodes
      .find({ workspaceId, kind: LIBRARY_NODE_KINDS.file, $or: [{ links: from }, { links: inside }] })
      .toArray();
    const moveTarget = (path) => (path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : null);
    const retarget = (target) => {
      try {
        return moveTarget(normalizeLibraryPath(target));
      } catch {
        return null;
      }
    };

    const rewritten = [];
    for (const node of linking) {
      const relinked = relinkMarkdown({
        markdown: node.markdown ?? "",
        protectedBlocks: node.protectedBlocks ?? [],
        agentBlocks: node.agentBlocks ?? [],
        retarget,
      });
      const links = [...new Set((node.links ?? []).map((path) => moveTarget(path) ?? path))];
      const revision = relinked.changed ? await nextRevision(workspaceId, node.path, node) : node.revision ?? 1;
      const update = {
        links,
        ...(relinked.changed
          ? {
            markdown: relinked.markdown,
            protectedBlocks: relinked.protectedBlocks,
            agentBlocks: relinked.agentBlocks,
            revision,
            updatedAt: at,
            updatedBy: updatedByOf(writer),
          }
          : {}),
      };
      await nodes.updateOne({ workspaceId, path: node.path }, { $set: update });
      if (!relinked.changed) continue;
      await recordRevision(workspaceId, { ...node, ...update }, writer, false, { renamed: { from, to } });
      rewritten.push(node.path);
    }
    return rewritten;
  }

  /**
   * Refuses a new node once the Library has as many of its kind as it should ever hold.
   *
   * Two ceilings, counted separately, because the two halves of a Library fail differently. The
   * subject tree is an agent's judgement and five hundred nodes of it means the agent stopped
   * deciding and started filing. The source layer is a mirror of the site: its size is the site's,
   * not a symptom, and counting a two-thousand-page crawl against a five-hundred-node briefing
   * would make a complete mirror impossible on exactly the sites that most need one.
   */
  async function assertRoom(workspaceId, path) {
    const inSourceLayer = isSourceLayerPath(path);
    const limit = inSourceLayer ? LIBRARY_LIMITS.sourceNodes : LIBRARY_LIMITS.nodes;
    // A real RegExp rather than a `$regex` string, because the negated form needs one: MongoDB
    // refuses `{$not: "<pattern>"}` with "$not argument must be a regex or an object", and the
    // failure would land on every write *outside* the source layer — which is every file the
    // knowledge agent creates.
    const within = new RegExp(`^${escapeRegExp(SOURCE_ROOT_PATH)}(/|$)`);
    const count = await nodes.countDocuments({
      workspaceId,
      path: inSourceLayer ? within : { $not: within },
    });
    if (count >= limit) {
      throw new LibraryError({
        code: LIBRARY_ERROR_CODES.libraryFull,
        message: inSourceLayer
          ? `The source layer already holds ${limit.toLocaleString("en-US")} files and folders, ` +
            "which is more than this system is built to mirror. Narrow the crawl's scope."
          : `This Library already holds ${limit} folders and files outside ${SOURCE_ROOT_PATH}, ` +
            "which is as many as it should. Rewrite something that exists, or delete what no " +
            "longer earns its place.",
      });
    }
  }

  /**
   * Resolves the `[[links]]` a document makes against the tree it lives in.
   *
   * `copy` is the source layer copying a page: the text is the site's, word for word, and a
   * `[[…]]` in it is the site's too — a TOML array of tables in a code sample, an address a
   * page's email protection rewrote — never a link into the Library. Refusing those left ten
   * pages of one development site out of its source layer, each retried every minute for good.
   */
  async function resolveLinks(workspaceId, markdown, writer, { copy = false } = {}) {
    const targets = extractWikiLinks(markdown).slice(0, LIBRARY_LIMITS.links);
    if (!targets.length) return { links: [], unresolved: [] };

    const wanted = [];
    const unresolved = [];
    for (const target of targets) {
      try {
        wanted.push(normalizeLibraryPath(target));
      } catch {
        unresolved.push(target);
      }
    }
    const found = wanted.length
      ? await nodes.find({ workspaceId, path: { $in: wanted } }).project({ path: 1 }).toArray()
      : [];
    const existing = new Set(found.map((node) => node.path));
    for (const path of wanted) {
      if (!existing.has(path)) unresolved.push(path);
    }

    // An agent's dangling link is refused; a person's is reported and saved anyway. A person
    // writing `[[/clients/acme]]` before creating the file is drafting, and refusing the save
    // would lose their work to a rule about tidiness. A model doing it is hallucinating a page.
    if (unresolved.length && writer.isAgent && !copy) {
      throw new LibraryError({
        code: LIBRARY_ERROR_CODES.unresolvedLink,
        message:
          `These links point at nothing: ${unresolved.slice(0, 10).join(", ")}. Link only to paths ` +
          "library.tree shows, or create the file first.",
        detail: { unresolved: unresolved.slice(0, 50) },
      });
    }
    return { links: [...existing], unresolved };
  }

  /**
   * The version number a write at this path should carry.
   *
   * Taken from the history as well as from the node, because a file's history outlives the file:
   * deleting one keeps its versions so it can be restored, and a file created again at the same
   * path is the same file continuing rather than a new one starting at version 1. Numbering from
   * the node alone produced a duplicate-key failure the first time a path was reused — and, worse,
   * would have interleaved two files' histories under one path if it had not.
   */
  async function nextRevision(workspaceId, path, existing) {
    const [latest] = await revisions
      .find({ workspaceId, path })
      .project({ revision: 1 })
      .sort({ revision: -1 })
      .limit(1)
      .toArray();
    return Math.max(existing?.revision ?? 0, latest?.revision ?? 0) + 1;
  }

  /**
   * Records one version of a file and forgets the oldest once there are too many.
   *
   * Kept for every write by either writer, because two writers share these documents: "the agent
   * replaced my paragraph" has to be answerable with the text, not with an apology.
   *
   * Upserted rather than inserted so that a retried write lands on the version it already wrote
   * instead of failing a write whose document is already stored.
   */
  async function recordRevision(workspaceId, node, writer, deleted = false, note = null) {
    await revisions.updateOne(
      { workspaceId, path: node.path, revision: node.revision },
      {
        $set: {
          // Why this version exists when it is not somebody's edit: a rename elsewhere in the
          // Library rewrote a link in it. Shown in the file's history beside who renamed.
          note,
          kind: node.kind,
          title: node.title,
          summary: node.summary,
          markdown: node.markdown ?? null,
          sources: node.sources ?? [],
          tags: node.tags ?? [],
          authors: node.authors,
          deleted,
          createdAt: node.updatedAt,
          updatedBy: updatedByOf(writer),
        },
        $setOnInsert: { workspaceId, path: node.path, revision: node.revision },
      },
      { upsert: true },
    );
    // A source file is a copy, and the crawler keeps the page's own history, so far fewer of its
    // versions are worth keeping than of a file somebody wrote.
    const kept = isSourceLayerPath(node.path) ? LIBRARY_LIMITS.sourceRevisions : LIBRARY_LIMITS.revisions;
    const stale = await revisions
      .find({ workspaceId, path: node.path })
      .project({ _id: 1 })
      .sort({ revision: -1 })
      .skip(kept)
      .toArray();
    if (stale.length) await revisions.deleteMany({ _id: { $in: stale.map((row) => row._id) } });
  }

  /** The listing pages this Library's folders name, by the crawler's key. */
  async function claimedListings(workspaceId) {
    const rows = await nodes
      .find({ workspaceId, kind: LIBRARY_NODE_KINDS.folder, "listing.key": { $type: "string" } })
      .project({ "listing.key": 1 })
      .toArray();
    return new Set(rows.map((row) => row.listing.key));
  }

  /**
   * The source pages a folder shows beneath it: the ones its listing page links to.
   *
   * A folder may name a page of the site that lists others — "Case studies", the blog's index —
   * and the pages that listing links to are then shown with the folder, by reference. Each of
   * them still lives once, under `/sources`; nothing is copied, so there is still one home per
   * page and nothing to keep in step.
   *
   * Which pages a listing links to is worked out by the source layer on every pass, from the
   * crawl's own links, and kept on each page's state row. Nothing about it reads a URL's shape,
   * which is what lets a site whose posts sit at `/a-post` be grouped the same way as one whose
   * posts sit at `/blog/a-post`.
   *
   * A page that two folders' listings both link to is shown under one of them: the listing that
   * links to the fewest pages, which is the more specific. That is the order the state row keeps
   * them in, so a case study the blog's index also links to is a case study, and the blog shows
   * the rest.
   *
   * @param {import("mongodb").ObjectId} workspaceId
   * @param {{key: string, url: string|null}|null} listing what the folder names
   * @param {number} limit how many pages to return
   * @param {Set<string>} claimed every listing some folder of this Library names
   * @returns {Promise<{url: string|null, total: number, pages: object[]}|null>}
   */
  async function listedPages(workspaceId, listing, limit, claimed) {
    if (!listing?.key) return null;
    const rows = await sourceState
      .find({ workspaceId, listedBy: listing.key, removed: { $ne: true }, path: { $type: "string" } })
      .project({ path: 1, listedBy: 1 })
      .toArray();
    const mine = rows.filter((row) => (row.listedBy ?? []).find((key) => claimed.has(key) || key === listing.key) === listing.key);
    const pages = mine.length && limit > 0
      ? await nodes
        .find({ workspaceId, kind: LIBRARY_NODE_KINDS.file, path: { $in: mine.map((row) => row.path) } })
        .project(LISTING_PROJECTION)
        .sort({ name: 1 })
        .limit(limit)
        .toArray()
      : [];
    return { url: listing.url ?? null, total: mine.length, pages: pages.map(toListing) };
  }

  /** How authorship reads after a write: both kinds of writer are recorded, neither replaces the other. */
  function mergeAuthors(existing, writer) {
    return {
      agent: writer.isAgent ? writer.agentSlug : existing?.authors?.agent ?? null,
      user: writer.isAgent ? existing?.authors?.user === true : true,
    };
  }

  return {
    /**
     * Where this Library's entry points are: the overview, the index, and the folder they are in.
     *
     * What the tree root reports as `overviewPath` and `indexPath`, and what every reader that
     * needs the overview asks rather than assuming `/overview`. See {@link rolePaths}.
     *
     * @param {object} options
     * @param {{workspaceId: unknown}} options.scope owning workspace
     * @returns {Promise<{start: string|null, overview: string, index: string}>}
     */
    async roles({ scope }) {
      const { workspaceId } = scopeOf(scope);
      return rolePaths(workspaceId);
    },

    /**
     * Where one standard subject lives in this Library, or null when it has no file or folder.
     *
     * A subject is filed inside whichever top-level folder the person's structure gives it, so
     * `competitors` is `/04-market/competitors` in one Library and `/market/competitors` in the
     * next. The shallowest match outside the source layer and the brand folder wins, a file
     * before a folder of the same depth.
     *
     * @param {object} options
     * @param {{workspaceId: unknown}} options.scope owning workspace
     * @param {string} options.name the subject's standard name, e.g. `competitors`
     * @returns {Promise<string|null>}
     */
    async locateSubject({ scope, name }) {
      const { workspaceId } = scopeOf(scope);
      const segment = slugifySegment(name);
      if (!segment) return null;
      const rows = await nodes
        .find({ workspaceId, path: new RegExp(`(^|/)${escapeRegExp(segment)}$`), depth: { $lte: 3 } })
        .project({ path: 1, depth: 1, kind: 1 })
        .toArray();
      const found = rows
        .filter((row) => !isSourceLayerPath(row.path) && !isBrandLayerPath(row.path))
        .sort((left, right) => left.depth - right.depth || (left.kind === right.kind ? 0 : left.kind === LIBRARY_NODE_KINDS.file ? -1 : 1));
      return found[0]?.path ?? null;
    },

    /**
     * Creates the top-level folders a person chose, as theirs, and marks where the overview goes.
     *
     * Code rather than the write run makes them, which is what makes "exactly the folders the
     * person chose" a fact rather than an instruction: each is created by the person who chose it,
     * so the rule that agents never rename, move or delete a folder a person made covers all of
     * them from the start. A folder already at a chosen path keeps what is in it and takes the
     * chosen title and summary. Nothing else at the top level is touched — on a rebuild, what the
     * old shape left there is the write run's to fold into the new folders.
     *
     * @param {object} options
     * @param {{workspaceId: unknown}} options.scope owning workspace
     * @param {ReadonlyArray<{path: string, title: string, summary: string, start?: boolean}>} options.groups
     *   the structure, as `normalizeLibraryStructure` returns it
     * @param {{userId: unknown}} options.actor the person who chose it
     * @returns {Promise<{folders: Array<{path: string, action: string}>, start: string}>}
     */
    async applyStructure({ scope, groups, actor }) {
      const { workspaceId } = scopeOf(scope);
      const writer = actorOf(actor);
      if (writer.isAgent) {
        throw new LibraryError({
          code: LIBRARY_ERROR_CODES.topLevelProtected,
          message: "The Library's top-level folders are chosen by a person, not by an agent.",
        });
      }
      const folders = [];
      for (const group of groups) {
        const made = await this.mkdir({ scope, path: group.path, title: group.title, summary: group.summary, actor });
        folders.push({ path: made.path, action: made.action });
      }
      const start = (groups.find((group) => group.start) ?? groups[0]).path;
      await nodes.updateMany(
        { workspaceId, role: LIBRARY_ROLES.start, path: { $ne: start } },
        { $set: { role: null } },
      );
      await nodes.updateOne({ workspaceId, path: start }, { $set: { role: LIBRARY_ROLES.start } });
      // On a rebuild whose start folder is a different one, the overview and the index go with
      // it: they are the start folder's, and the run writes them where the roles say. Moved as
      // the person who chose, so every link to them follows.
      const carried = [];
      for (const role of LIBRARY_FILE_ROLES) {
        const holder = await nodes.findOne({ workspaceId, role }, { projection: { path: 1 } });
        if (!holder || libraryParentPath(holder.path) === start) continue;
        const target = `${start}/${librarySegmentOf(holder.path)}`;
        if (await findNode(workspaceId, target, { _id: 1 })) continue;
        await this.move({ scope, from: holder.path, to: target, actor });
        carried.push({ from: holder.path, to: target });
      }
      return { folders, start, carried };
    },

    /**
     * The tree from a path down to a depth, with deeper levels elided rather than truncated.
     *
     * Bounded on purpose. This is the call every consuming agent makes first, and an unbounded
     * tree of a five-hundred-node Library would spend a model's context on a directory listing
     * before it had read a word. A folder whose children did not fit says how many it has, which
     * is enough for the reader to ask for that branch specifically.
     *
     * @param {object} options
     * @param {{workspaceId: unknown}} options.scope owning workspace
     * @param {string} [options.path] where to start; the root by default
     * @param {number} [options.depth] levels below that path
     * @param {number} [options.maxNodes] ceiling on how many nodes come back
     * @param {number} [options.offset] how many of the starting folder's own children to pass over
     * @param {number|null} [options.limit] the most of them to list; all that fit by default
     * @param {"name"|"newest"} [options.sort] siblings in the usual order, or copied pages newest
     *   first by the date their page gives
     *
     * The starting folder's own children are a page of a list: `childCount` says how many it has
     * and `nextOffset` where the next page starts, or null when this one reached the end. A folder
     * of a thousand copied posts is read in pages that way; before it, everything past the budget
     * was a count nobody could get behind.
     */
    async tree({ scope, path = LIBRARY_ROOT_PATH, depth = 3, maxNodes = 200, offset = 0, limit = null, sort = "name" }) {
      const { workspaceId } = scopeOf(scope);
      const root = normalizeLibraryPath(path, { allowRoot: true });
      const baseDepth = libraryDepth(root);

      const rows = await nodes
        .find(
          {
            workspaceId,
            ...(root === LIBRARY_ROOT_PATH ? {} : { path: { $regex: `^${escapeRegExp(root)}/` } }),
            depth: { $gt: baseDepth, $lte: baseDepth + depth },
          },
          { projection: { ...LISTING_PROJECTION, parentPath: 1, depth: 1 } },
        )
        .toArray();

      const byParent = new Map();
      for (const row of rows) {
        if (!byParent.has(row.parentPath)) byParent.set(row.parentPath, []);
        byParent.get(row.parentPath).push(row);
      }
      for (const siblings of byParent.values()) siblings.sort(sort === "newest" ? compareNewest : compareLibrarySiblings);

      // Breadth-first, so the budget is spent on the top of the tree — which is the part a reader
      // needs to decide where to go next — rather than on whichever branch happens to sort first.
      // Read from above it, the mirror is given a preview of each of its folders rather than the
      // run of the budget. A site whose posts all sit at the top level puts thousands of files in
      // one folder, and without this the first call every agent makes would be a list of two
      // hundred posts. Asked for by its own path, a source folder is listed like any other.
      const preview = isSourceLayerPath(root) ? Number.POSITIVE_INFINITY : SOURCE_BRANCH_PREVIEW;
      let budget = maxNodes;
      const build = (parentPath, children = byParent.get(parentPath) ?? [], cap = Number.POSITIVE_INFINITY) => {
        const room = isSourceLayerPath(parentPath) && parentPath !== SOURCE_ROOT_PATH ? Math.min(budget, preview) : budget;
        const taken = children.slice(0, Math.max(0, Math.min(room, cap)));
        budget -= taken.length;
        const listed = taken.map((row) => ({ ...toListing(row), children: [] }));
        const elided = children.length - taken.length;
        return { listed, elided };
      };

      const queue = [];
      const siblings = byParent.get(root) ?? [];
      const start = Math.min(Math.max(0, offset), siblings.length);
      const rootLevel = build(root, siblings.slice(start), limit ?? Number.POSITIVE_INFINITY);
      const reached = start + rootLevel.listed.length;
      // The paging comes before the children, so a reader whose client cuts a long answer short
      // still sees where to carry on from.
      const result = {
        path: root,
        childCount: siblings.length,
        offset: start,
        nextOffset: reached < siblings.length ? reached : null,
        elided: rootLevel.elided,
        children: rootLevel.listed,
      };
      queue.push(...rootLevel.listed);
      while (queue.length) {
        const node = queue.shift();
        if (node.kind !== LIBRARY_NODE_KINDS.folder) continue;
        const level = build(node.path);
        node.children = level.listed;
        node.elided = level.elided;
        queue.push(...level.listed);
      }

      // Folders that name a listing carry the first few pages it links to, so the shape of a
      // Library whose case studies and posts are source pages is visible in one read of the tree.
      const listed = [];
      const collect = (children) => {
        for (const child of children) {
          if (child.kind !== LIBRARY_NODE_KINDS.folder) continue;
          if (child.listing) listed.push(child);
          collect(child.children ?? []);
        }
      };
      collect(result.children);
      if (listed.length) {
        const claimed = await claimedListings(workspaceId);
        const listings = new Map(rows.filter((row) => row.listing?.key).map((row) => [row.path, row.listing]));
        for (const folder of listed) {
          folder.sourcePages = await listedPages(workspaceId, listings.get(folder.path), TREE_SOURCE_PAGES, claimed);
        }
      }

      return { ...result, total: rows.length };
    },

    /**
     * One node: a file with its Markdown, or a folder with its summary and children.
     *
     * A file's Markdown comes back with the person's own blocks wrapped in markers, so an agent
     * about to rewrite it can see exactly what it has to keep. The markers are accepted back and
     * stripped on write, so echoing them costs nothing.
     */
    async read({ scope, path, markUser = true }) {
      const { workspaceId } = scopeOf(scope);
      const target = normalizeLibraryPath(path);
      let node = await findNode(workspaceId, target);
      // `/overview` and `/index` were fixed paths for long enough that readers ask for them by
      // name — other agents' instructions, an outside AI's habits, a bookmark. Asked for where
      // nothing is stored, they open the file that carries the role, wherever it is now; the
      // answer names its real path. This is the role, not an alias of an old path: a renamed
      // folder's old path resolves to nothing.
      const legacyRole = LIBRARY_FILE_ROLES.find((role) => LIBRARY_RESERVED_PATHS[role] === target);
      if (!node && legacyRole) {
        const roles = await rolePaths(workspaceId);
        if (roles[legacyRole] !== target) node = await findNode(workspaceId, roles[legacyRole]);
      }
      if (!node) {
        throw new LibraryError({
          code: LIBRARY_ERROR_CODES.nodeMissing,
          message: `${target} does not exist in this Library.`,
          detail: { path: target },
        });
      }
      if (node.kind === LIBRARY_NODE_KINDS.folder) {
        const children = await nodes
          .find({ workspaceId, parentPath: target })
          .project(LISTING_PROJECTION)
          .limit(LIBRARY_LIMITS.children)
          .toArray();
        children.sort(compareLibrarySiblings);
        const sourcePages = node.listing
          ? await listedPages(workspaceId, node.listing, LIBRARY_LIMITS.children, await claimedListings(workspaceId))
          : null;
        return { ...toNodeView(node), ...editorOf(node, markUser), children: children.map(toListing), ...(sourcePages ? { sourcePages } : {}) };
      }
      return {
        ...toNodeView(node),
        ...editorOf(node, markUser),
        markdown: markUser ? markUserBlocks(node.markdown ?? "", node.protectedBlocks ?? []) : node.markdown ?? "",
        // Two ways of showing the same boundary, for two readers. An agent gets markers inside the
        // Markdown, because that is what it has to preserve while rewriting around them. A person
        // gets the blocks listed beside an unmarked document, because the editor must show exactly
        // what they saved — markers in the textarea would be an editing hazard, not a hint.
        ...(markUser ? {} : { userBlocks: (node.protectedBlocks ?? []).map((block) => block.text) }),
        // Who wrote each of those blocks, in the same order: the account's identifier, or null for
        // a block claimed before authors were recorded. The API turns these into people.
        ...(markUser ? {} : { userBlockAuthorIds: (node.protectedBlocks ?? []).map((block) => (block.userId ? String(block.userId) : null)) }),
      };
    },

    /**
     * Where the copy of one page of the site is, given the page's address.
     *
     * A copy's path is the URL's, slugified, but not always predictably: a segment is cut at the
     * Library's length limit, a collision takes a suffix, and a URL that is also a directory is
     * stored at `…/home`. An outside reader holding a URL — from a search result, from the site
     * itself — should not have to search for the file. Any address the crawler fetched works,
     * including a duplicate of a page (its `http://` or `?ref=` twin, a trailing slash): it
     * resolves to the page it duplicates, which is the one that is stored.
     *
     * @param {object} options
     * @param {{workspaceId: unknown, siteId?: unknown}} options.scope owning workspace and its crawl
     * @param {string} options.url the page's address
     * @returns {Promise<{path: string, url: string}>}
     * @throws {LibraryError} `NODE_MISSING`, saying why, when no copy stands for that address
     */
    async locatePage({ scope, url }) {
      const { workspaceId, siteId } = scopeOf(scope);
      const missing = (message) => new LibraryError({ code: LIBRARY_ERROR_CODES.nodeMissing, message, detail: { url } });
      if (!siteId) throw missing("This workspace has no crawled site, so no page of it is in the Library.");
      const site = toObjectId(siteId);
      const normalized = tryNormalizeUrl(url);
      const registered = await database.collection(AGENT_COLLECTIONS.urls).findOne(
        { siteId: site, urlHash: { $in: [normalized?.hash, url].filter(Boolean) } },
        { projection: { urlHash: 1, url: 1, variantOf: 1 } },
      ) ?? await database.collection(AGENT_COLLECTIONS.urls).findOne(
        { siteId: site, url },
        { projection: { urlHash: 1, url: 1, variantOf: 1 } },
      );
      if (!registered) {
        throw missing(`${url} is not an address the crawler fetched for this site. Search for the page instead.`);
      }
      const key = registered.variantOf ?? registered.urlHash;
      const state = await sourceState.findOne(
        { workspaceId, sourceKey: key },
        { projection: { path: 1, url: 1, skipped: 1, reason: 1 } },
      );
      if (!state?.path || state.skipped) {
        throw missing(state?.reason ?? `${url} has not been copied into the Library yet.`);
      }
      return { path: state.path, url: state.url ?? registered.url };
    },

    /**
     * Finds files by what they say rather than by where they sit.
     *
     * The question a consuming agent asks is "what does this company say about pricing", and the
     * answer is not reliably in a folder name somebody chose months ago — so titles, summaries,
     * tags and the Markdown itself are all searched, and a hit in a title counts for more than a
     * passing mention in a paragraph.
     *
     * Scored here rather than by a MongoDB text index, because the deployment speaks the Stable
     * API with `strict: true`, under which text indexes cannot be created at all. The two layers
     * are read differently, because they are different sizes.
     *
     * The **subject tree** is bounded at five hundred nodes by design, so every one of its nodes is
     * read with its text and scored: a scan of a few hundred small documents, cheaper than an
     * index would be to maintain, and an honest ranking over four fields of very different weight.
     *
     * The **source layer** is as large as the site, and holds whole pages. Reading every page of a
     * five-thousand-page site into this process to find a word would be the most expensive query
     * in the system, so the database does the matching: it returns the files that contain every
     * term somewhere, without their text, and the text is read only for the few that are shown.
     */
    async search({ scope, query, path = LIBRARY_ROOT_PATH, limit = 20 }) {
      const { workspaceId } = scopeOf(scope);
      const within = normalizeLibraryPath(path, { allowRoot: true });
      const inside = within === LIBRARY_ROOT_PATH ? null : new RegExp(`^${escapeRegExp(within)}(/|$)`);
      const sourceLayer = new RegExp(`^${escapeRegExp(SOURCE_ROOT_PATH)}(/|$)`);
      const listing = LISTING_PROJECTION;

      const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
      if (!terms.length) return { query, total: 0, matches: [] };

      const [subjects, sources] = await Promise.all([
        nodes
          .find(
            { workspaceId, $and: [{ path: { $not: sourceLayer } }, ...(inside ? [{ path: inside }] : [])] },
            { projection: { ...listing, markdown: 1 } },
          )
          .toArray(),
        nodes
          .find(
            {
              workspaceId,
              $and: [
                { path: sourceLayer },
                ...(inside ? [{ path: inside }] : []),
                // Every term, somewhere in the file. Which field it was in is worked out below
                // from the fields that came back; a term in none of them was in the text.
                ...terms.map((term) => {
                  const pattern = new RegExp(escapeRegExp(term), "i");
                  return { $or: [{ title: pattern }, { path: pattern }, { summary: pattern }, { tags: pattern }, { markdown: pattern }] };
                }),
              ],
            },
            { projection: listing },
          )
          .limit(SOURCE_SEARCH_CANDIDATES)
          .toArray(),
      ]);

      const scored = [];
      for (const row of subjects) {
        const score = scoreNode(row, terms);
        if (score > 0) scored.push({ row, score });
      }
      for (const row of sources) {
        const score = scoreNode(row, terms, { matchedInText: true });
        if (score > 0) scored.push({ row, score });
      }
      scored.sort((left, right) => right.score - left.score || left.row.path.localeCompare(right.row.path));

      // The text of the source files that made the page of results, and of no others.
      const shown = scored.slice(0, limit);
      const wanted = shown.filter(({ row }) => row.markdown === undefined && row.kind === LIBRARY_NODE_KINDS.file).map(({ row }) => row.path);
      const texts = wanted.length
        ? await nodes.find({ workspaceId, path: { $in: wanted } }).project({ path: 1, markdown: 1 }).toArray()
        : [];
      const textOf = new Map(texts.map((row) => [row.path, row.markdown ?? ""]));

      return {
        query,
        total: scored.length,
        matches: shown.map(({ row, score }) => ({
          ...toListing(row),
          score,
          snippet: snippetOf(row.markdown === undefined ? { ...row, markdown: textOf.get(row.path) } : row, query),
        })),
      };
    },

    /**
     * Creates a folder, or updates the title and summary of one that exists.
     *
     * A folder is created on purpose and explained in its summary rather than appearing as a
     * side effect of a path: a tree of folders nobody described is a tree a consumer has to open
     * every branch of to understand. Idempotent because a weekly run should be able to declare
     * the folders it expects without first checking whether it made them last week.
     *
     * A folder may also name a **listing**: a page of the site that links to a set of others —
     * the case-studies page, the blog's index. The pages it links to are then shown with the
     * folder, by reference, from where they live under `/sources`. `listing` is that page's URL;
     * left out, whatever the folder already named stands, and `null` clears it.
     */
    async mkdir({ scope, path, title, summary, listing, actor }) {
      const { workspaceId, siteId } = scopeOf(scope);
      const writer = actorOf(actor);
      const target = normalizeLibraryPath(path);
      if (await fileRoleAt(workspaceId, target)) {
        throw new LibraryError({
          code: LIBRARY_ERROR_CODES.reservedPath,
          message: `${target} is where the Library's ${await fileRoleAt(workspaceId, target)} is kept: a file, not a folder.`,
          detail: { path: target },
        });
      }
      assertSourceLayerWriter(target, writer);
      assertBrandLayerWriter(target, writer);
      assertNotTopLevelForAgent(target, writer);
      await assertNotLocked(workspaceId, target, writer);
      await assertParent(workspaceId, target);

      const existing = await findNode(workspaceId, target);
      if (existing && existing.kind !== LIBRARY_NODE_KINDS.folder) {
        throw new LibraryError({
          code: LIBRARY_ERROR_CODES.kindMismatch,
          message: `${target} is already a file. Choose another name for the folder.`,
          detail: { path: target },
        });
      }
      if (!existing) await assertRoom(workspaceId, target);

      let listed = existing?.listing ?? null;
      if (listing === null || listing === "") listed = null;
      else if (listing !== undefined) {
        const { resolved } = await providers[LIBRARY_SOURCE_KINDS.page].resolve({ workspaceId, siteId }, [listing]);
        if (!resolved.length) {
          throw new LibraryError({
            code: LIBRARY_ERROR_CODES.unknownSource,
            message:
              `${listing} is not a page of this site the crawler fetched, so it cannot be a ` +
              "folder's listing. Give the exact URL of a listing page, as content.siteMap wrote it.",
            detail: { unknown: [listing] },
          });
        }
        listed = { key: resolved[0].key, url: resolved[0].url };
      }

      const at = now();
      const document = {
        workspaceId,
        path: target,
        parentPath: libraryParentPath(target),
        depth: libraryDepth(target),
        kind: LIBRARY_NODE_KINDS.folder,
        listing: listed,
        role: existing?.role ?? null,
        name: title || librarySegmentOf(target),
        title,
        summary,
        tags: existing?.tags ?? [],
        order: existing?.order ?? null,
        authors: mergeAuthors(existing, writer),
        hasUserContent: existing?.hasUserContent === true || !writer.isAgent,
        locked: existing?.locked === true,
        sources: [],
        sourceKinds: [],
        links: [],
        markdown: null,
        agentBlocks: [],
        protectedBlocks: [],
        removedBlocks: [],
        words: 0,
        bytes: 0,
        revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
        updatedBy: updatedByOf(writer),
      };
      await nodes.updateOne({ workspaceId, path: target }, { $set: document }, { upsert: true });
      const result = { path: target, action: existing ? "updated" : "created", kind: LIBRARY_NODE_KINDS.folder, revision: document.revision };
      if (!listed) return result;
      // How many pages the listing brings with it, so whoever named it can see at once that a
      // page which links to nothing of the kind was the wrong page to name.
      const shown = await listedPages(workspaceId, listed, 0, await claimedListings(workspaceId));
      return { ...result, listing: listed.url, sourcePages: shown?.total ?? 0 };
    },

    /**
     * Creates or replaces one file, whole.
     *
     * A replace rather than a patch, for the same reason the knowledge pages were: the unit a
     * person reads is the file, and a writer that could append would produce a document that grows
     * every week and contradicts itself by month three. Rewriting it whole forces the writer to
     * decide what the file says *now* — and the protected-block check is what makes that safe to
     * ask of an agent editing something a person has corrected.
     *
     * `page` is what the source layer knows about the page a copy is of — its URL, the kind of
     * page it says it is, and the dates it gives — and only the source layer's writer may set it,
     * inside `/sources`. It is what lets a listing of a thousand copied posts say which address
     * and which day each one is without opening any of them. Any other write keeps what is there.
     */
    async writeFile({ scope, path, title, summary, markdown, sources = [], tags = [], removed, page, actor }) {
      const { workspaceId, siteId } = scopeOf(scope);
      const writer = actorOf(actor);
      const target = normalizeLibraryPath(path);
      const copying = writer.isAgent && writer.agentSlug === SOURCE_LAYER_WRITER_SLUG && isSourceLayerPath(target);
      assertSourceLayerWriter(target, writer);
      assertBrandLayerWriter(target, writer);
      assertNotTopLevelForAgent(target, writer);
      await assertNotLocked(workspaceId, target, writer);
      await assertParent(workspaceId, target);

      const existing = await findNode(workspaceId, target);
      // A file written where the overview or the index is kept takes that role, so the next
      // rename of the folder it is in carries the role with it. A file that has one keeps it.
      const role = existing?.role ?? await roleToAssign(workspaceId, target);
      // A folder and a file cannot share a path: one holds children and the other holds text.
      if (existing && existing.kind === LIBRARY_NODE_KINDS.folder) {
        throw new LibraryError({
          code: LIBRARY_ERROR_CODES.kindMismatch,
          message: `${target} is a folder. Write the file inside it, or choose another path.`,
          detail: { path: target },
        });
      }
      if (!existing) await assertRoom(workspaceId, target);

      const text = stripUserBlockMarkers(markdown);
      // A copy of a page is as long as the site made the page; a subject file is as long as
      // somebody decided, which is the one the lower ceiling is there to keep honest.
      const longest = isSourceLayerPath(target) ? LIBRARY_LIMITS.sourceMarkdown : LIBRARY_LIMITS.markdown;
      if (text.length > longest) {
        throw new LibraryError({
          code: LIBRARY_ERROR_CODES.invalidPath,
          message: `A file may be at most ${longest.toLocaleString("en-US")} characters; this is ${text.length.toLocaleString("en-US")}. Split the subject across files.`,
        });
      }

      const protectedBlocks = existing?.protectedBlocks ?? [];
      const removedBlocks = existing?.removedBlocks ?? [];

      let nextProtected = protectedBlocks;
      let nextRemoved = removedBlocks;
      let nextAgentBlocks = existing?.agentBlocks ?? [];

      if (writer.isAgent) {
        const problems = checkAgentWrite({ markdown: text, protectedBlocks, removedBlocks });
        if (problems.missing.length) {
          throw new LibraryError({
            code: LIBRARY_ERROR_CODES.protectedContentMissing,
            message:
              "This file contains writing by a person, and your version drops it. Put these back, " +
              "word for word, and write around them:\n\n" +
              problems.missing.map((block) => `- ${block.text}`).join("\n\n"),
            detail: { missing: problems.missing.map((block) => block.text) },
          });
        }
        if (problems.reintroduced.length) {
          throw new LibraryError({
            code: LIBRARY_ERROR_CODES.removedContentReintroduced,
            message:
              `Your version puts back ${problems.reintroduced.length} passage(s) a person deleted ` +
              "from this file. They removed them on purpose; leave them out.",
            detail: { reintroduced: problems.reintroduced },
          });
        }
        // The agent's own blocks are everything it wrote that is not the person's. Keeping the
        // person's out is what makes a paragraph the agent faithfully preserved still read as
        // theirs the next time they save, rather than silently becoming the agent's to rewrite.
        const owned = new Set(protectedBlocks.map((block) => block.hash));
        nextAgentBlocks = markdownBlockHashes(text).filter((hash) => !owned.has(hash));
      } else {
        const recorded = recordUserEdit({
          markdown: text,
          agentBlocks: existing?.agentBlocks ?? [],
          protectedBlocks,
          removedBlocks,
          userId: writer.userId,
        });
        nextProtected = recorded.protectedBlocks;
        nextRemoved = recorded.removedBlocks;
      }

      // A person saving a file sends its sources back as they were: they correct the text, they do
      // not re-read the pages. So every source the file already cites is kept exactly as recorded —
      // the content hash it was read at included — and only one they added is resolved. Resolving
      // them all again would refuse the save of any file citing a page that has since left the site,
      // and would stamp today's hash on pages nobody re-read, quietly hiding that the agent's text is
      // behind them. An agent's write is resolved in full: it cites what it just read.
      const carried = [];
      let fresh = sources;
      if (!writer.isAgent && existing?.sources?.length) {
        const recorded = new Map();
        for (const reference of existing.sources) {
          for (const ref of [reference.url, reference.key, reference.path]) {
            if (ref) recorded.set(`${reference.kind}:${ref}`, reference);
          }
        }
        fresh = [];
        for (const source of sources) {
          const hit = recorded.get(`${source.kind ?? LIBRARY_SOURCE_KINDS.page}:${source.ref}`);
          if (hit) {
            if (!carried.includes(hit)) carried.push(hit);
          } else {
            fresh.push(source);
          }
        }
      }
      const resolvedNow = await resolveSourceReferences({ providers, scope: { workspaceId, siteId }, sources: fresh });
      const references = [...carried, ...resolvedNow.filter((reference) => !carried.some((kept) => kept.kind === reference.kind && kept.key === reference.key))];
      const { links, unresolved } = await resolveLinks(workspaceId, text, writer, { copy: copying });

      const at = now();
      const revision = await nextRevision(workspaceId, target, existing);
      const document = {
        workspaceId,
        path: target,
        parentPath: libraryParentPath(target),
        depth: libraryDepth(target),
        kind: LIBRARY_NODE_KINDS.file,
        role: role ?? null,
        name: title || librarySegmentOf(target),
        title,
        summary,
        markdown: text,
        tags,
        order: existing?.order ?? null,
        authors: mergeAuthors(existing, writer),
        hasUserContent: nextProtected.length > 0,
        agentBlocks: nextAgentBlocks,
        protectedBlocks: nextProtected,
        removedBlocks: nextRemoved,
        locked: existing?.locked === true,
        sources: references,
        sourceKinds: [...new Set(references.map((reference) => reference.kind))],
        links,
        // Whether the page this file is a copy *of* still exists. Only the source layer's writer
        // passes it; every other write keeps whatever was there, so a person annotating the copy
        // of a page that has gone does not quietly bring the page back.
        removed: removed === undefined ? existing?.removed === true : removed === true,
        page: copying && page !== undefined ? pageFactsOf(page) : existing?.page ?? null,
        words: text.split(/\s+/).filter(Boolean).length,
        bytes: Buffer.byteLength(text, "utf8"),
        revision,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
        updatedBy: updatedByOf(writer),
      };

      await nodes.updateOne({ workspaceId, path: target }, { $set: document }, { upsert: true });
      await recordRevision(workspaceId, document, writer);

      return {
        path: target,
        action: existing ? "updated" : "created",
        kind: LIBRARY_NODE_KINDS.file,
        revision: document.revision,
        words: document.words,
        sources: references.length,
        sourceReferences: references,
        protectedBlocks: nextProtected.length,
        unresolvedLinks: unresolved,
      };
    },

    /**
     * Moves or renames a file or a whole subtree, and every link to it follows.
     *
     * Paths are materialised rather than walked, which is what makes a tree cheap to read and a
     * move the one expensive operation. It is worth that trade: a Library is read constantly by
     * agents and reorganised rarely by people.
     *
     * A rename is a move: a path follows its title, so renaming `02 Offer` to `Offer` moves
     * `/02-offer` to `/offer`. `title`, when given, is the moved node's new display name. Every
     * file in the Library that linked to the old path or anything under it is rewritten to the
     * new one, in the same call, so no link resolves to nothing afterwards — see
     * `rewriteInboundLinks`. A role travels with its node: the overview is still the overview
     * after the folder it sits in is renamed.
     *
     * Not everything moves. `/sources`, `/sources/website` and `/brand` are where code writes and
     * every reader looks. An agent may not move a folder a person made — which includes every
     * top-level folder of the chosen structure — may not put anything at the top level, and may
     * not move the overview or the index.
     *
     * @returns {Promise<{from: string, to: string, moved: number, relinked: string[]}>}
     */
    async move({ scope, from, to, title, actor }) {
      const { workspaceId } = scopeOf(scope);
      const writer = actorOf(actor);
      const source = normalizeLibraryPath(from);
      const destination = normalizeLibraryPath(to);
      const renamedTitle = typeof title === "string" && title.trim() ? title.trim().slice(0, LIBRARY_LIMITS.title) : null;
      if (source === destination && !renamedTitle) return { from: source, to: destination, moved: 0, relinked: [] };

      if (isWithinLibraryPath(destination, source) && source !== destination) {
        throw new LibraryError({
          code: LIBRARY_ERROR_CODES.invalidPath,
          message: "A folder cannot be moved inside itself.",
        });
      }
      assertNotReservedSourceFolder(source);
      assertSourceLayerWriter(source, writer);
      assertSourceLayerWriter(destination, writer);
      assertBrandLayerWriter(source, writer);
      assertBrandLayerWriter(destination, writer);
      if (source !== destination) assertNotTopLevelForAgent(destination, writer);

      const node = await findNode(workspaceId, source);
      if (!node) {
        throw new LibraryError({
          code: LIBRARY_ERROR_CODES.nodeMissing,
          message: `${source} does not exist in this Library.`,
          detail: { path: source },
        });
      }
      if (writer.isAgent && node.kind === LIBRARY_NODE_KINDS.folder && node.authors?.user === true) {
        throw new LibraryError({
          code: LIBRARY_ERROR_CODES.userFolderProtected,
          message: `${source} was made by a person. Agents do not move or rename it; file into it instead.`,
          detail: { path: source },
        });
      }
      const role = node.role ?? await fileRoleAt(workspaceId, source);
      if (writer.isAgent && role && LIBRARY_FILE_ROLES.includes(role)) {
        throw new LibraryError({
          code: LIBRARY_ERROR_CODES.reservedPath,
          message: `${source} is the Library's ${role}. It stays where it is; rewrite it in place.`,
          detail: { path: source },
        });
      }
      await assertNotLocked(workspaceId, source, writer);
      await assertNotLocked(workspaceId, destination, writer);

      const at = now();
      const updatedBy = updatedByOf(writer);
      // A new name for a node that stays where it is: nothing moves and no link changes.
      if (source === destination) {
        await nodes.updateOne(
          { workspaceId, path: source },
          { $set: { title: renamedTitle, name: renamedTitle, updatedAt: at, updatedBy, authors: mergeAuthors(node, writer) } },
        );
        return { from: source, to: destination, moved: 0, relinked: [] };
      }

      await assertParent(workspaceId, destination);
      if (await findNode(workspaceId, destination, { _id: 1 })) {
        throw new LibraryError({
          code: LIBRARY_ERROR_CODES.nodeExists,
          message: `${destination} already exists.`,
          detail: { path: destination },
        });
      }

      const descendants = await nodes
        .find({ workspaceId, path: { $regex: `^${escapeRegExp(source)}/` } })
        .project({ path: 1 })
        .toArray();
      const depthChange = libraryDepth(destination) - libraryDepth(source);
      const deepest = descendants.reduce((max, row) => Math.max(max, libraryDepth(row.path)), libraryDepth(source));
      if (deepest + depthChange > LIBRARY_LIMITS.depth) {
        throw new LibraryError({
          code: LIBRARY_ERROR_CODES.invalidPath,
          message: `That move would put files more than ${LIBRARY_LIMITS.depth} levels deep.`,
        });
      }

      const writes = [
        {
          updateOne: {
            filter: { workspaceId, path: source },
            update: {
              $set: {
                path: destination,
                parentPath: libraryParentPath(destination),
                depth: libraryDepth(destination),
                // A file kept at a legacy entry point takes its role with it rather than leaving
                // the Library without an overview.
                ...(role && !node.role ? { role } : {}),
                ...(renamedTitle ? { title: renamedTitle, name: renamedTitle, authors: mergeAuthors(node, writer) } : {}),
                updatedAt: at,
                updatedBy,
              },
            },
          },
        },
        ...descendants.map((row) => {
          const path = destination + row.path.slice(source.length);
          return {
            updateOne: {
              filter: { workspaceId, path: row.path },
              update: {
                $set: { path, parentPath: libraryParentPath(path), depth: libraryDepth(path), updatedAt: at },
              },
            },
          };
        }),
      ];
      await nodes.bulkWrite(writes, { ordered: true });
      // Revisions follow the file, so history is not lost to a tidy-up.
      await revisions.updateMany({ workspaceId, path: source }, { $set: { path: destination } });
      for (const row of descendants) {
        await revisions.updateMany(
          { workspaceId, path: row.path },
          { $set: { path: destination + row.path.slice(source.length) } },
        );
      }
      const relinked = await rewriteInboundLinks(workspaceId, source, destination, writer, at);

      return { from: source, to: destination, moved: 1 + descendants.length, relinked };
    },

    /**
     * Deletes a file softly and a folder only once it is empty.
     *
     * The asymmetry is deliberate. A file is writing, and writing two people share is restorable
     * or it is not trusted; a folder is an arrangement, and an arrangement with nothing in it is
     * not worth keeping a copy of. Refusing to delete a folder that still holds files is what
     * stops one call from taking a subtree with it.
     */
    async remove({ scope, path, actor }) {
      const { workspaceId } = scopeOf(scope);
      const writer = actorOf(actor);
      const target = normalizeLibraryPath(path);
      assertNotReservedSourceFolder(target);
      assertSourceLayerWriter(target, writer);
      assertBrandLayerWriter(target, writer);
      const node = await findNode(workspaceId, target);
      // The overview and the index are found by role, so it is the file that carries the role —
      // or the path kept for it — that cannot be deleted, wherever it is now.
      const role = node?.role ?? await fileRoleAt(workspaceId, target);
      if (role && LIBRARY_FILE_ROLES.includes(role)) {
        throw new LibraryError({
          code: LIBRARY_ERROR_CODES.reservedPath,
          message: `${target} is the Library's ${role}, part of how every Library is read. Rewrite it instead of deleting it.`,
          detail: { path: target },
        });
      }
      if (!node) {
        throw new LibraryError({
          code: LIBRARY_ERROR_CODES.nodeMissing,
          message: `${target} does not exist in this Library.`,
          detail: { path: target },
        });
      }
      await assertNotLocked(workspaceId, target, writer);

      if (node.kind === LIBRARY_NODE_KINDS.folder) {
        if (writer.isAgent && node.authors?.user === true) {
          throw new LibraryError({
            code: LIBRARY_ERROR_CODES.userFolderProtected,
            message: `${target} was made by a person. Agents do not delete it.`,
            detail: { path: target },
          });
        }
        const child = await nodes.findOne({ workspaceId, parentPath: target }, { projection: { path: 1 } });
        if (child) {
          throw new LibraryError({
            code: LIBRARY_ERROR_CODES.folderNotEmpty,
            message: `${target} still holds files. Move or delete what is inside it first.`,
            detail: { path: target },
          });
        }
        await nodes.deleteOne({ workspaceId, path: target });
        return { path: target, deleted: true, kind: node.kind, restorable: false };
      }

      if (writer.isAgent && node.hasUserContent) {
        throw new LibraryError({
          code: LIBRARY_ERROR_CODES.protectedContentMissing,
          message: `${target} contains writing by a person. Agents do not delete it; rewrite the parts that are yours.`,
          detail: { path: target },
        });
      }

      const at = now();
      const revision = await nextRevision(workspaceId, target, node);
      await recordRevision(workspaceId, { ...node, revision, updatedAt: at }, writer, true);
      await nodes.deleteOne({ workspaceId, path: target });
      // An old entry point, from before the overview and the index were roles, deleted once the
      // role is carried elsewhere: links to it are links to the overview or the index, so they
      // follow the role rather than resolving to nothing.
      const legacy = LIBRARY_FILE_ROLES.find((entry) => LIBRARY_RESERVED_PATHS[entry] === target);
      if (legacy) {
        const roles = await rolePaths(workspaceId);
        if (roles[legacy] !== target && await findNode(workspaceId, roles[legacy], { _id: 1 })) {
          const relinked = await rewriteInboundLinks(workspaceId, target, roles[legacy], writer, at);
          return { path: target, deleted: true, kind: node.kind, restorable: true, relinked };
        }
      }
      return { path: target, deleted: true, kind: node.kind, restorable: true };
    },

    /** Locks or unlocks a node, which is how a person opts a file or a branch out of agent writes. */
    async setLocked({ scope, path, locked, actor }) {
      const { workspaceId } = scopeOf(scope);
      const writer = actorOf(actor);
      // Made at the keyboard or not at all: a lock is what keeps a person's own AI out, so the AI
      // cannot be the one to lift it.
      if (writer.isAgent || writer.via) {
        throw new LibraryError({
          code: LIBRARY_ERROR_CODES.nodeLocked,
          message: "Locking is a person's decision, made on the Library page; agents do not change it.",
        });
      }
      const target = normalizeLibraryPath(path);
      const result = await nodes.updateOne(
        { workspaceId, path: target },
        { $set: { locked: Boolean(locked), updatedAt: now(), updatedBy: updatedByOf(writer) } },
      );
      if (!result.matchedCount) {
        throw new LibraryError({
          code: LIBRARY_ERROR_CODES.nodeMissing,
          message: `${target} does not exist in this Library.`,
          detail: { path: target },
        });
      }
      return { path: target, locked: Boolean(locked) };
    },

    /**
     * Sets a node's place among its siblings.
     *
     * An explicit field, so reordering does not rename anything and every link keeps working. A
     * number at the front of a top-level folder's name is a convention that makes the default
     * order read well, never a position: nothing reads it. Agents never set `order`: the default —
     * folders first, then by name, numbers counted as numbers — is what an agent gets, and an
     * arrangement a person made is one a run cannot undo.
     */
    async reorder({ scope, path, order, actor }) {
      const { workspaceId } = scopeOf(scope);
      const writer = actorOf(actor);
      if (writer.isAgent) {
        throw new LibraryError({
          code: LIBRARY_ERROR_CODES.nodeLocked,
          message: "The order of a folder's children is a person's arrangement; agents do not set it.",
        });
      }
      const target = normalizeLibraryPath(path);
      const result = await nodes.updateOne(
        { workspaceId, path: target },
        { $set: { order: order === null ? null : Number(order), updatedAt: now(), updatedBy: updatedByOf(writer) } },
      );
      if (!result.matchedCount) {
        throw new LibraryError({
          code: LIBRARY_ERROR_CODES.nodeMissing,
          message: `${target} does not exist in this Library.`,
          detail: { path: target },
        });
      }
      return { path: target, order: order === null ? null : Number(order) };
    },

    /** Every kept version of one file, newest first. */
    async listRevisions({ scope, path }) {
      const { workspaceId } = scopeOf(scope);
      const target = normalizeLibraryPath(path);
      const rows = await revisions
        .find({ workspaceId, path: target })
        .sort({ revision: -1 })
        .limit(LIBRARY_LIMITS.revisions)
        .toArray();
      return {
        path: target,
        revisions: rows.map((row) => ({
          revision: row.revision,
          title: row.title,
          summary: row.summary,
          deleted: row.deleted === true,
          words: row.markdown ? row.markdown.split(/\s+/).filter(Boolean).length : 0,
          markdown: row.markdown ?? null,
          createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
          // A person's version names their account, for the API to turn into a name.
          updatedBy: row.updatedBy?.agentSlug
            ? { kind: "agent", agentSlug: row.updatedBy.agentSlug }
            : { kind: "user", ...(row.updatedBy?.userId ? { userId: String(row.updatedBy.userId) } : {}), ...viaView(row.updatedBy?.via) },
          ...(row.note?.renamed ? { renamed: { from: row.note.renamed.from, to: row.note.renamed.to } } : {}),
        })),
      };
    },

    /**
     * Puts a file back to one of its kept versions, as a new version.
     *
     * Forward rather than backward: restoring writes revision N+1 with the old content instead of
     * winding the history back, so the restore itself is visible and reversible. A file that was
     * deleted is recreated, which is what makes file deletion safe to offer at all.
     */
    async restore({ scope, path, revision, actor }) {
      const { workspaceId } = scopeOf(scope);
      // Validated here so a restore with no writer fails before it reads anything, rather than
      // inside the write below where the message would be about the wrong call.
      actorOf(actor);
      const target = normalizeLibraryPath(path);
      const version = await revisions.findOne({ workspaceId, path: target, revision });
      if (!version) {
        throw new LibraryError({
          code: LIBRARY_ERROR_CODES.revisionMissing,
          message: `Version ${revision} of ${target} is no longer kept.`,
          detail: { path: target, revision },
        });
      }
      return this.writeFile({
        scope,
        path: target,
        title: version.title,
        summary: version.summary,
        markdown: version.markdown ?? "",
        sources: (version.sources ?? []).map((source) => ({ kind: source.kind, ref: source.key })),
        tags: version.tags ?? [],
        actor,
      });
    },

    /**
     * The files that link to one node: the other direction of the `links` every file keeps.
     *
     * Outgoing links are stored resolved on each file, and indexed, so "what links here" is one
     * query rather than a scan of every document's text — the same query a rename uses to find
     * the links it has to rewrite. Each comes back with the line the link sits in, so a reader can
     * tell "listed in the index" from "relied on in a sentence" without opening the file.
     *
     * @param {object} options
     * @param {{workspaceId: unknown}} options.scope owning workspace
     * @param {string} options.path the node linked to
     * @param {number} [options.limit] how many linking files to return
     * @returns {Promise<{path: string, total: number, links: Array<{path: string, title: string|null,
     *   name: string, role?: string, context: string|null}>}>}
     */
    async backlinks({ scope, path, limit = 50 }) {
      const { workspaceId } = scopeOf(scope);
      const target = normalizeLibraryPath(path);
      const filter = { workspaceId, kind: LIBRARY_NODE_KINDS.file, links: target, path: { $ne: target } };
      const [total, linking] = await Promise.all([
        nodes.countDocuments(filter),
        nodes
          .find(filter, { projection: { path: 1, title: 1, name: 1, role: 1, markdown: 1 } })
          .sort({ path: 1 })
          .limit(limit)
          .toArray(),
      ]);
      return {
        path: target,
        total,
        links: linking.map((node) => ({
          path: node.path,
          title: node.title ?? null,
          name: node.name ?? librarySegmentOf(node.path),
          ...(node.role ? { role: node.role } : {}),
          context: linkContext(node.markdown ?? "", target),
        })),
      };
    },

    /**
     * What the source layer knows about some pages of the site: where each one's copy is, and
     * whether the knowledge base is written from it.
     *
     * A file's `sources` name pages by key, because that is what an agent cites, and say nothing
     * about where the copy of each lives; the tree lists copies by path and says nothing about
     * whether each was chosen. Both answers are on the page's state row, which is where the mirror
     * and the selection keep them, so a reader asks here by either.
     *
     * @param {object} options
     * @param {{workspaceId: unknown}} options.scope owning workspace
     * @param {string[]} [options.keys] pages by source key
     * @param {string[]} [options.paths] pages by the path of their copy
     * @returns {Promise<Array<{key: string, path: string|null, chosen: boolean, removed: boolean}>>}
     */
    async sourcePages({ scope, keys = [], paths = [] }) {
      const { workspaceId } = scopeOf(scope);
      const clauses = [
        ...(keys.length ? [{ sourceKey: { $in: keys } }] : []),
        ...(paths.length ? [{ path: { $in: paths } }] : []),
      ];
      if (!clauses.length) return [];
      const rows = await sourceState
        .find(
          { workspaceId, $or: clauses },
          { projection: { sourceKey: 1, path: 1, chosen: 1, skipped: 1, removed: 1 } },
        )
        .toArray();
      return rows.map((row) => ({
        key: row.sourceKey,
        // A page the mirror skipped has no copy, whatever path it was once given.
        path: row.skipped ? null : row.path ?? null,
        chosen: row.chosen === true,
        removed: row.removed === true,
      }));
    },

    /**
     * How many folders and files this workspace's Library holds, and how many carry a person's
     * writing.
     *
     * Counted in two halves, because the Library now has two. The headline numbers are the subject
     * tree — what an agent decided to write and what a person corrected — and the source layer is
     * reported beside them rather than folded in: a hundred copies arriving because the crawler
     * found a hundred pages is not the Library growing towards its ceiling, and showing it as
     * "106 of 500" would say exactly that.
     */
    async stats({ scope }) {
      const { workspaceId } = scopeOf(scope);
      const rows = await nodes
        .aggregate([
          { $match: { workspaceId } },
          {
            $group: {
              _id: {
                $cond: [
                  { $regexMatch: { input: "$path", regex: `^${escapeRegExp(SOURCE_ROOT_PATH)}(/|$)` } },
                  "sources",
                  "subjects",
                ],
              },
              nodes: { $sum: 1 },
              folders: { $sum: { $cond: [{ $eq: ["$kind", LIBRARY_NODE_KINDS.folder] }, 1, 0] } },
              files: { $sum: { $cond: [{ $eq: ["$kind", LIBRARY_NODE_KINDS.file] }, 1, 0] } },
              // Files only: a folder somebody created carries their authorship, but "how much of
              // this Library is a person's own writing" is a question about text.
              withUserContent: {
                $sum: {
                  $cond: [{ $and: ["$hasUserContent", { $eq: ["$kind", LIBRARY_NODE_KINDS.file] }] }, 1, 0],
                },
              },
              words: { $sum: { $ifNull: ["$words", 0] } },
              updatedAt: { $max: "$updatedAt" },
            },
          },
        ])
        .toArray();
      const subjects = rows.find((row) => row._id === "subjects") ?? null;
      const sources = rows.find((row) => row._id === "sources") ?? null;
      const latest = rows.reduce((newest, row) => (
        row.updatedAt && (!newest || row.updatedAt > newest) ? row.updatedAt : newest
      ), null);
      return {
        nodes: subjects?.nodes ?? 0,
        folders: subjects?.folders ?? 0,
        files: subjects?.files ?? 0,
        withUserContent: subjects?.withUserContent ?? 0,
        words: subjects?.words ?? 0,
        // The whole Library's last write, not the subject tree's: this is what the interface uses
        // to know a run has changed something and it should read the tree again.
        updatedAt: latest ? new Date(latest).toISOString() : null,
        limit: LIBRARY_LIMITS.nodes,
        sources: {
          nodes: sources?.nodes ?? 0,
          folders: sources?.folders ?? 0,
          files: sources?.files ?? 0,
          withUserContent: sources?.withUserContent ?? 0,
          words: sources?.words ?? 0,
          limit: LIBRARY_LIMITS.sourceNodes,
        },
      };
    },
  };
}

/**
 * The fields a listing is made from, which is everything about a node except its text.
 *
 * `sources.url` is there for a copied page written before copies carried `page`: its one source is
 * the page, so its address is the copy's.
 */
const LISTING_PROJECTION = Object.freeze({
  path: 1, kind: 1, role: 1, name: 1, title: 1, summary: 1, tags: 1, order: 1, authors: 1, hasUserContent: 1,
  locked: 1, words: 1, sourceKinds: 1, removed: 1, listing: 1, updatedAt: 1, page: 1, "sources.url": 1,
});

/** How many children of one source-layer folder a tree read from above the layer lists. */
const SOURCE_BRANCH_PREVIEW = 25;

/** How many of a listing's pages a folder carries in the tree. The folder itself shows them all. */
const TREE_SOURCE_PAGES = 12;

/** A node as it appears in a listing: everything except the text. */
function toListing(node) {
  return {
    path: node.path,
    kind: node.kind,
    // `overview`, `index` or `start`: what the node is to every reader, wherever a rename has
    // put it. Absent on everything else.
    ...(node.role ? { role: node.role } : {}),
    name: node.name ?? librarySegmentOf(node.path),
    title: node.title ?? null,
    summary: node.summary ?? null,
    tags: node.tags ?? [],
    order: Number.isInteger(node.order) ? node.order : null,
    authors: node.authors ?? { agent: null, user: false },
    hasUserContent: node.hasUserContent === true,
    locked: node.locked === true,
    words: node.words ?? 0,
    sourceKinds: node.sourceKinds ?? [],
    // A source file whose page has left the crawl. The file is kept rather than deleted — it is
    // still the record of what the site used to say, and every file that linked it still works —
    // so a reader has to be able to see that it describes something that is gone.
    removed: node.removed === true,
    // The page of the site whose links decide which source pages a folder shows beneath it.
    listing: node.listing?.url ?? null,
    updatedAt: node.updatedAt ? new Date(node.updatedAt).toISOString() : null,
    // A copy of a page says which page, and the day the page says it was published, so a listing
    // of a folder of posts answers "which address" and "how recent" without opening each one.
    ...(isPageCopy(node) ? { url: node.page?.url ?? node.sources?.[0]?.url ?? null, published: dayOf(node.page?.publishedAt) } : {}),
  };
}

/** Whether a node is the source layer's copy of a page of the site. */
function isPageCopy(node) {
  return node.kind === LIBRARY_NODE_KINDS.file
    && isSourceLayerPath(node.path ?? "")
    && (Boolean(node.page) || node.authors?.agent === SOURCE_LAYER_WRITER_SLUG);
}

/** How much of the line around a link `backlinks` returns, on each side of it. */
const LINK_CONTEXT_REACH = 90;

/**
 * The line a file links to a path in, as plain text with the link where it was.
 *
 * Wiki links read as their label, or their path when they have none; list markers, heading marks
 * and emphasis are dropped. A long line is cut to the stretch around the link, with an ellipsis
 * where it was cut. Null when the link is not written in the text as that path — a file whose
 * stored links were resolved from an older address — so a reader is never shown the wrong line.
 *
 * @param {string} markdown the linking file's text
 * @param {string} target the path linked to
 */
function linkContext(markdown, target) {
  const line = String(markdown ?? "")
    .split(/\r?\n/)
    .find((text) => text.includes(`[[${target}]]`) || text.includes(`[[${target}|`));
  if (!line) return null;
  // The link to this target is marked while the line is cleaned, so the cut can be centred on it
  // after the markup around it has gone.
  const marked = line
    .replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g, (_match, path, label) => {
      const text = label?.trim() || path.trim();
      return path.trim() === target ? `\u0000${text}\u0000` : text;
    })
    .replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6}|>)\s+/, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const at = marked.indexOf("\u0000");
  const start = Math.max(0, at - LINK_CONTEXT_REACH);
  const end = Math.min(marked.length, marked.indexOf("\u0000", at + 1) + LINK_CONTEXT_REACH);
  const cut = marked.slice(start, end).replaceAll("\u0000", "").trim();
  return `${start > 0 ? "…" : ""}${cut}${end < marked.length ? "…" : ""}`;
}

/** A date as `YYYY-MM-DD`, or null. */
function dayOf(value) {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString().slice(0, 10);
}

/**
 * The facts about a page that a copy of it carries, cleaned to their stored shape.
 *
 * @param {{url?: string, kind?: string|null, publishedAt?: unknown, modifiedAt?: unknown}|null} page
 */
function pageFactsOf(page) {
  if (!page) return null;
  const at = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  return {
    url: typeof page.url === "string" ? page.url : null,
    kind: typeof page.kind === "string" && page.kind ? page.kind : null,
    publishedAt: at(page.publishedAt),
    modifiedAt: at(page.modifiedAt),
  };
}

/**
 * Orders siblings newest first by the date their page says it was published.
 *
 * Folders keep their usual order ahead of the files, and a file whose page gives no date comes
 * after every file whose page does, in the usual order.
 */
function compareNewest(left, right) {
  if (left.kind !== right.kind) return left.kind === LIBRARY_NODE_KINDS.folder ? -1 : 1;
  const leftAt = left.page?.publishedAt ? new Date(left.page.publishedAt).getTime() : null;
  const rightAt = right.page?.publishedAt ? new Date(right.page.publishedAt).getTime() : null;
  if (leftAt !== rightAt) {
    if (leftAt === null) return 1;
    if (rightAt === null) return -1;
    return rightAt - leftAt;
  }
  return compareLibrarySiblings(left, right);
}

/** A node as it appears when opened, without its Markdown. */
function toNodeView(node) {
  return {
    ...toListing(node),
    parentPath: node.parentPath,
    depth: node.depth,
    revision: node.revision ?? 1,
    sources: node.sources ?? [],
    links: node.links ?? [],
    protectedBlocks: (node.protectedBlocks ?? []).length,
    removedBlocks: (node.removedBlocks ?? []).length,
    ...(node.page ? {
      page: {
        url: node.page.url ?? null,
        kind: node.page.kind ?? null,
        published: dayOf(node.page.publishedAt),
        modified: dayOf(node.page.modifiedAt),
      },
    } : {}),
    createdAt: node.createdAt ? new Date(node.createdAt).toISOString() : null,
    updatedBy: node.updatedBy?.agentSlug
      ? { kind: "agent", agentSlug: node.updatedBy.agentSlug }
      : node.updatedBy?.userId
        ? { kind: "user", ...viaView(node.updatedBy.via) }
        : null,
  };
}

/**
 * What a reader is told about a person's write that came through a client: the channel and the
 * client's name, so the Library page can say "you, via Claude". The credential's id stays on the
 * stored row, where it can be matched to the token or the connection; nobody reading needs it.
 */
/**
 * The account that last changed a node, for a person's read only (`markUser: false`): the API
 * turns it into a name, so a file a colleague edited does not say "Edited by you". An agent's
 * read is not given it.
 */
function editorOf(node, markUser) {
  if (markUser) return {};
  const userId = node.updatedBy?.agentSlug ? null : node.updatedBy?.userId ?? null;
  return { updatedByUserId: userId ? String(userId) : null };
}

function viaView(via) {
  return via?.kind ? { via: { kind: via.kind, client: via.client ?? null } } : {};
}

/**
 * How well one node answers a search, counted field by field.
 *
 * A node has to match every term to score at all, which is what makes a two-word search narrow
 * rather than broader; where a term matched decides how much it is worth. The weights say what a
 * reader means: a file *called* "Pricing" is about pricing, and one that mentions the word twice
 * in a paragraph probably is not.
 *
 * @param {object} node the node, with or without its text
 * @param {string[]} terms lowercase search terms
 * @param {object} [options]
 * @param {boolean} [options.matchedInText] the database has already established that every term
 *   is somewhere in this node and its text was not read: a term found in no other field was in
 *   the text, and is worth what one mention in the text is worth
 */
function scoreNode(node, terms, { matchedInText = false } = {}) {
  if (!terms.length) return 0;
  const fields = [
    { text: String(node.title ?? "").toLowerCase(), weight: 10 },
    { text: String(node.path ?? "").toLowerCase(), weight: 8 },
    { text: String(node.summary ?? "").toLowerCase(), weight: 6 },
    { text: (node.tags ?? []).join(" ").toLowerCase(), weight: 4 },
    { text: String(node.markdown ?? "").toLowerCase(), weight: 1 },
  ];

  let score = 0;
  for (const term of terms) {
    let best = matchedInText ? 1 : 0;
    for (const field of fields) {
      if (!field.text.includes(term)) continue;
      // Diminishing returns on repetition: the second mention in a body of text says much less
      // than the first, and without this a long file wins every search by sheer length.
      const occurrences = field.text.split(term).length - 1;
      best = Math.max(best, field.weight * (1 + Math.min(3, occurrences - 1) * 0.25));
    }
    if (!best) return 0;
    score += best;
  }
  // A source file says what one page says; a subject file says what the company means. Both match
  // "pricing", and the second is almost always the one a reader wanted — so the source files sort
  // below without being hidden, which is what lets somebody searching for a phrase they
  // half-remember still find the page it was on.
  if (isSourceLayerPath(node.path ?? "")) score *= SOURCE_FILE_SEARCH_WEIGHT;
  return Math.round(score * 100) / 100;
}

/** How much a source file's score is worth against a subject file's. */
const SOURCE_FILE_SEARCH_WEIGHT = 0.4;

/**
 * The most source files one search considers.
 *
 * A word that is on every page of a large site matches every page of it, and ranking five
 * thousand rows to show twenty is work nobody asked for. Past this the search says how many it
 * looked at, and a narrower query is the answer.
 */
const SOURCE_SEARCH_CANDIDATES = 500;

/**
 * A few words of context around the first search term a file contains.
 *
 * Built here rather than by Mongo because `$meta: "textScore"` says how well a document matched
 * and never says where, and a list of titles without a line of context is a list a reader has to
 * open one by one.
 */
function snippetOf(node, query) {
  const text = node.markdown ?? node.summary ?? "";
  if (!text) return null;
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 2);
  const haystack = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    at = haystack.indexOf(term);
    if (at >= 0) break;
  }
  const start = Math.max(0, (at < 0 ? 0 : at) - 80);
  const snippet = text.slice(start, start + 240).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${snippet}${start + 240 < text.length ? "…" : ""}`;
}
