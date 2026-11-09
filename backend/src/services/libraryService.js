import { AGENT_COLLECTIONS, KNOWLEDGE_AGENT_SLUG, toObjectId } from "@orbik/core";
import {
  DEFAULT_LIBRARY_STRUCTURE,
  LIBRARY_ERROR_CODES,
  LIBRARY_NODE_KINDS,
  LibraryError,
  createLibraryStore,
  isSourceLayerPath,
  libraryStructureState,
  normalizeLibraryStructure,
} from "@orbik/library";
import { createIndexStatusReader } from "@orbik/retrieval";

import { AppError } from "../errors/appError.js";
import { createSourceCoverageReader } from "../repositories/sourceCoverageRepository.js";
import { createWorkspaceAccessCheck } from "./workspaceAccess.js";

/**
 * Reading and writing the Library on behalf of a person.
 *
 * Deliberately not read-only, which is the reversal this replaces. The old knowledge base was
 * written by agent runs and by nothing else, on the grounds that an API able to write it would be
 * a second door with none of the tools' checks behind it. That was the right worry and the wrong
 * conclusion: what people actually did was correct the agent's mistakes somewhere else entirely,
 * and the knowledge base stayed wrong. The fix is not to keep the door shut but to put the same
 * lock on it — both writers go through the one store in `@orbik/library`, which owns the path
 * rules, the limits, the locks and the provenance checks.
 *
 * What a person's write adds is the record of what they changed: every block that differs from
 * the version the agent last wrote is marked as theirs and must survive the next agent run, and
 * every block they deleted is recorded so no run can quietly put it back.
 *
 * @param {object} dependencies collaborators
 * @param {object} dependencies.workspaceRepository workspace access by owner or membership
 * @param {object} dependencies.knowledgeRepository source verdicts
 * @param {object} dependencies.crawlRepository crawl data, for the site a workspace reads from
 * @param {object} dependencies.runRepository agent runs, for the Library agent's latest
 * @param {object} dependencies.userRepository accounts, to name who wrote a person's passage
 * @param {import("mongodb").Db} dependencies.database connected database, for the Library store
 * @param {object|null} [dependencies.retrieval] the search index, for searching by meaning; null
 *   when this API has none
 * @param {{code: string, message: string}|null} [dependencies.retrievalReason] why it has none
 */
export function createLibraryService({
  workspaceRepository,
  knowledgeRepository,
  crawlRepository,
  runRepository,
  userRepository,
  database,
  retrieval = null,
  retrievalReason = null,
}) {
  const library = createLibraryStore({ database });
  // Read from MongoDB alone: the index state is there, and a status line that needed Qdrant to be
  // up would go blank at exactly the moment it has something worth saying.
  const indexStatus = createIndexStatusReader({ database });
  // The same trade, for the same reason: how much of the site is stored, and how much of what was
  // chosen the knowledge base is written from, is arithmetic over MongoDB rows and must be
  // answerable whether or not anything else is running.
  const coverage = createSourceCoverageReader({ database });

  const requireWorkspaceAccess = createWorkspaceAccessCheck(workspaceRepository);
  // The knowledge agent's setup document, where the structure the person chose — and the variants
  // a model proposed — are kept. The same document holds its other per-workspace settings.
  const setups = database.collection(AGENT_COLLECTIONS.agentSetups);
  const setupFilter = (workspaceId) => ({ workspaceId, agentSlug: KNOWLEDGE_AGENT_SLUG });

  /**
   * The structure step as the Library page shows it: whether the Library is waiting on a choice,
   * what was chosen, what was proposed, and the default to start from when nothing was.
   */
  async function structureOf(workspaceId) {
    const setup = await setups.findOne(setupFilter(workspaceId), { projection: { structure: 1 } });
    const state = libraryStructureState(setup);
    const suggestion = state.suggestion;
    return {
      needsChoice: state.needsChoice,
      reason: state.reason,
      chosen: state.chosen
        ? { groups: state.chosen.groups, chosenAt: iso(state.chosenAt) }
        : null,
      suggestion: suggestion
        ? {
          status: suggestion.status,
          variants: suggestion.variants ?? [],
          generatedAt: iso(suggestion.generatedAt ?? suggestion.queuedAt ?? null),
          reason: suggestion.reason ? { code: suggestion.reason.code, message: suggestion.reason.message } : null,
        }
        : null,
      defaults: normalizeLibraryStructure(DEFAULT_LIBRARY_STRUCTURE).groups,
    };
  }

  /**
   * The scope every Library call is made in: the workspace, and the site its sources come from.
   */
  async function scopeFor(userId, workspaceId, role) {
    const workspace = await requireWorkspaceAccess(userId, workspaceId, { role });
    const site = await crawlRepository.findSiteByWorkspace(workspace._id);
    return { workspace, site, scope: { workspaceId: workspace._id, siteId: site?._id ?? null } };
  }

  /**
   * Turns a Library rule into an HTTP failure, keeping the code.
   *
   * The code is the same one the agent tools hand to a model. Translating it rather than
   * inventing a parallel set is what lets the interface say "that folder still holds files" in
   * the same terms the run log does.
   */
  async function guard(work) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof LibraryError)) throw error;
      throw new AppError({ status: STATUS_BY_CODE[error.code] ?? 400, code: error.code, message: error.message });
    }
  }

  /**
   * Marks each copy of a page in a tree with whether the knowledge base is written from it.
   *
   * The tree is the store's, shared with every outside reader, and says nothing about selection;
   * the Library page shows it as a dot on each copy, so it is added here, for this reader, in one
   * read of the copies the tree actually lists. The tree was built for this response, so it is
   * marked in place.
   */
  async function withSelection(scope, tree) {
    const copies = [];
    const walk = (node) => {
      for (const child of node?.children ?? []) {
        if (child.kind === LIBRARY_NODE_KINDS.file && isSourceLayerPath(child.path)) copies.push(child);
        walk(child);
      }
      for (const page of node?.sourcePages?.pages ?? []) copies.push(page);
    };
    walk(tree);
    if (!copies.length) return tree;
    const rows = await library.sourcePages({ scope, paths: [...new Set(copies.map((copy) => copy.path))] });
    const chosen = new Map(rows.map((row) => [row.path, row.chosen]));
    for (const copy of copies) copy.chosen = chosen.get(copy.path) ?? false;
    return tree;
  }

  /** The addresses of a set of accounts, by identifier. */
  async function emailsOf(ids) {
    const wanted = [...new Set(ids.filter(Boolean))];
    if (!wanted.length) return new Map();
    const users = await userRepository.listEmailsByIds(wanted);
    return new Map(users.map((user) => [user._id.toHexString(), user.email]));
  }

  /**
   * Names the people a node's own record points at, for a person reading it.
   *
   * - `userBlockAuthors`, beside `userBlocks`: who wrote each of the file's protected blocks, so
   *   the margin can say whose a passage is rather than assume it is the reader's. A block
   *   recorded without an author was claimed before authors were recorded, when only the
   *   workspace's owner could write, so it is the owner's. An author whose account no longer
   *   exists is null, and the interface shows the passage as somebody's without naming them.
   * - `updatedBy.userId` and `updatedBy.email` on a person's last change, so the header can say
   *   "Edited by Priya" rather than "Edited by you".
   */
  async function withAuthors(workspace, node) {
    const { userBlockAuthorIds: ids, updatedByUserId: editor, ...rest } = node;
    const owner = workspace.ownerId.toHexString();
    const authorIds = Array.isArray(ids) ? ids.map((id) => id ?? owner) : null;
    const emails = await emailsOf([...(authorIds ?? []), editor]);
    return {
      ...rest,
      ...(rest.updatedBy?.kind === "user" && editor
        ? { updatedBy: { ...rest.updatedBy, userId: editor, email: emails.get(editor) ?? null } }
        : {}),
      ...(authorIds
        ? { userBlockAuthors: authorIds.map((id) => (emails.has(id) ? { userId: id, email: emails.get(id) } : null)) }
        : {}),
    };
  }

  /**
   * Adds to an opened node what the page needs about the site's pages it involves.
   *
   * A file's sources say where each page's copy is (`copyPath`), so "written from" opens the copy
   * beside the file rather than leaving for the live site; a copy says whether the knowledge base
   * is written from it (`chosen`). Both are on the pages' state rows, read once.
   */
  async function withPages(scope, node) {
    const keys = (node.sources ?? []).filter((source) => source.kind === "page" && source.key).map((source) => source.key);
    const copy = node.kind === LIBRARY_NODE_KINDS.file && isSourceLayerPath(node.path);
    if (!keys.length && !copy) return node;
    const rows = await library.sourcePages({ scope, keys, paths: copy ? [node.path] : [] });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return {
      ...node,
      sources: (node.sources ?? []).map((source) => (
        source.kind === "page" && byKey.get(source.key)?.path ? { ...source, copyPath: byKey.get(source.key).path } : source
      )),
      ...(copy ? { chosen: rows.some((row) => row.path === node.path && row.chosen) } : {}),
    };
  }

  /** How the last run of the agent that maintains the Library went. */
  function toRunSummary(run) {
    if (!run) return null;
    return {
      id: run._id.toHexString(),
      status: run.status,
      startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : null,
      finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
      error: run.error ? { code: run.error.code, message: run.error.message } : null,
    };
  }

  return {
    /**
     * What the Library page opens with: the tree, how big it is, and how the last run went.
     *
     * One call rather than three, because the page is useless without all of them and a failed
     * newest run matters here more than elsewhere — the files on screen are the previous run's,
     * and showing them without saying the newest attempt failed presents stale content as current.
     */
    async getLibrary({ userId, workspaceId, path, depth }) {
      const { workspace, site, scope } = await scopeFor(userId, workspaceId, "read-only");
      const [tree, stats, sources, latestRun, markdownPages, index, sourceCoverage, roles, structure] = await Promise.all([
        guard(async () => withSelection(scope, await library.tree({ scope, path, depth, maxNodes: 500 }))),
        library.stats({ scope }),
        knowledgeRepository.countSources({ workspaceId: workspace._id, agentSlug: KNOWLEDGE_AGENT_SLUG }),
        runRepository.findLatest({ workspaceId: workspace._id, agentSlug: KNOWLEDGE_AGENT_SLUG }),
        site ? crawlRepository.countMarkdown({ siteId: site._id }) : 0,
        indexStatus.statusOf({ workspaceId: workspace._id, siteId: site?._id ?? null }),
        coverage.coverageOf({ workspaceId: workspace._id, siteId: site?._id ?? null }),
        library.roles({ scope }),
        structureOf(workspace._id),
      ]);
      return {
        // Where the front page and the entry map are: found by role, because they move with the
        // folder they are in when a person renames it.
        overviewPath: roles.overview,
        indexPath: roles.index,
        tree,
        stats,
        sources,
        latestRun: toRunSummary(latestRun),
        readiness: { crawled: Boolean(site), markdownPages },
        // The same line the ask page shows, from the same read. Two pages describing one index
        // differently is how somebody comes to believe there are two.
        index,
        // "Is the whole site in here" as arithmetic rather than as a claim the last run made
        // about itself: pages against copies, and chosen pages against the files that cite them.
        coverage: sourceCoverage,
        // The top-level structure: chosen, or waiting on the person to choose it.
        structure,
      };
    },

    /** The structure step on its own: what was chosen, what is proposed, and the default. */
    async getStructure({ userId, workspaceId }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      return { structure: await structureOf(workspace._id) };
    },

    /**
     * Where the Library stands as a thing being set up, for the Home page: whether its folders are
     * chosen and by whom, whether it has been written and when, what is writing it now, and the
     * overview's opening paragraph.
     *
     * A read of its own rather than `getLibrary`, which builds a tree of up to 500 nodes that Home
     * never draws, and is polled every few seconds while a step is in progress. Nothing here
     * writes: the overview is read as stored, without a person's blocks marked.
     */
    async getSetupState({ userId, workspaceId }) {
      const { workspace, scope } = await scopeFor(userId, workspaceId, "read-only");
      const [setup, stats, roles, latestRun, firstWrite, mirroring] = await Promise.all([
        setups.findOne(setupFilter(workspace._id), { projection: { structure: 1, working: 1 } }),
        library.stats({ scope }),
        library.roles({ scope }),
        runRepository.findLatest({ workspaceId: workspace._id, agentSlug: KNOWLEDGE_AGENT_SLUG }),
        runRepository.findEarliest({ workspaceId: workspace._id, agentSlug: KNOWLEDGE_AGENT_SLUG, status: "succeeded" }),
        runRepository.listMirroringWorkspaces([workspace._id]),
      ]);
      const state = libraryStructureState(setup);
      const active = latestRun && ["queued", "running"].includes(latestRun.status) ? latestRun : null;
      const [overview, filesWritten] = await Promise.all([
        // The overview is what the step's "written" means and what the glance quotes. Asked for by
        // its role's path; a Library that has none yet answers "missing", which is not an error.
        library.read({ scope, path: roles.overview, markUser: false }).catch((error) => {
          if (error instanceof LibraryError) return null;
          throw error;
        }),
        active ? runRepository.countWrittenFiles(active._id) : 0,
      ]);
      return {
        structure: {
          chosen: Boolean(state.chosen),
          chosenAt: iso(state.chosenAt),
          chosenBy: state.chosen?.chosenBy ? String(state.chosen.chosenBy) : null,
          needsChoice: state.needsChoice,
          reason: state.reason,
          suggestion: state.suggestion?.status ?? null,
        },
        // Whether the agent is set to work. Paused, it writes nothing, and the Home page says so
        // rather than leaving "Library written" waiting for a run that is never coming.
        working: Boolean(setup?.working),
        overview: overview
          ? { path: overview.path, excerpt: openingParagraph(overview.markdown), updatedAt: iso(overview.updatedAt) }
          : null,
        stats: { files: stats.files, folders: stats.folders, updatedAt: stats.updatedAt, sources: stats.sources.files },
        firstWrite: firstWrite ? { finishedAt: iso(firstWrite.finishedAt) } : null,
        latestRun: toRunSummary(latestRun),
        activeRun: active ? { ...toRunSummary(active), filesWritten } : null,
        // The pages of the site being copied into Sources: the first stage of every write, a queue
        // job rather than a run.
        copying: mirroring.length > 0,
      };
    },

    /**
     * Saves the structure a person chose, and creates its folders.
     *
     * Only while the Library is waiting on a choice — before its first write run, or after a
     * rebuild was asked for. A chosen structure is changed afterwards the way any folder is, by
     * renaming, adding or moving it; choosing again from scratch is a rebuild. The folders are
     * created first, as this person's, and the choice is stored only once they exist, so the
     * scheduler never starts a run that files into folders that failed to appear.
     */
    async chooseStructure({ userId, workspaceId, groups }) {
      const { workspace, scope } = await scopeFor(userId, workspaceId, "member");
      const state = libraryStructureState(await setups.findOne(setupFilter(workspace._id), { projection: { structure: 1 } }));
      if (!state.needsChoice) {
        throw new AppError({
          status: 409,
          code: "STRUCTURE_ALREADY_CHOSEN",
          message: "This Library's structure is already chosen. Rename or add folders in the Library, or ask for a rebuild to choose again.",
        });
      }
      const normalized = normalizeLibraryStructure({ groups });
      if (normalized.errors.length) {
        throw new AppError({ status: 400, code: "INVALID_STRUCTURE", message: normalized.errors.join(" ") });
      }
      const applied = await guard(() => library.applyStructure({ scope, groups: normalized.groups, actor: { userId } }));
      const at = new Date();
      await setups.updateOne(
        setupFilter(workspace._id),
        {
          $set: {
            "structure.chosen": { groups: normalized.groups, start: applied.start, chosenAt: at, chosenBy: toObjectId(userId) },
            updatedAt: at,
          },
          $setOnInsert: { createdAt: at },
        },
        { upsert: true },
      );
      return { structure: await structureOf(workspace._id), folders: applied.folders };
    },

    /**
     * Asks for the variants again. Nothing is queued here — the API never enqueues — the
     * suggestion is cleared, and the Library scheduler asks for a new one within a minute.
     */
    async suggestStructureAgain({ userId, workspaceId }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "member" });
      const state = libraryStructureState(await setups.findOne(setupFilter(workspace._id), { projection: { structure: 1 } }));
      if (!state.needsChoice) {
        throw new AppError({ status: 409, code: "STRUCTURE_ALREADY_CHOSEN", message: "This Library's structure is already chosen." });
      }
      if (state.suggestion?.status === "pending") return { structure: await structureOf(workspace._id) };
      await setups.updateOne(setupFilter(workspace._id), { $unset: { "structure.suggestion": "" }, $set: { updatedAt: new Date() } });
      return { structure: await structureOf(workspace._id) };
    },

    /**
     * Opens the structure step again: a rebuild. The next write run waits for a new choice and
     * then rewrites the Library into it, keeping locks and everything a person wrote.
     */
    async requestRebuild({ userId, workspaceId }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "member" });
      const at = new Date();
      await setups.updateOne(
        setupFilter(workspace._id),
        {
          // Who asked is kept beside when, as the choice keeps `chosenBy`.
          $set: { "structure.rebuildRequestedAt": at, "structure.rebuildRequestedBy": toObjectId(userId), updatedAt: at },
          $unset: { "structure.suggestion": "" },
          $setOnInsert: { createdAt: at },
        },
        { upsert: true },
      );
      return { structure: await structureOf(workspace._id) };
    },

    /**
     * What the retrieval index holds for this workspace.
     *
     * Its own method as well as part of the Library page's first call, because the ask page needs
     * exactly this and nothing else, and making it fetch a whole tree to render one sentence would
     * be a strange thing to have built.
     */
    async getIndexStatus({ userId, workspaceId }) {
      const { workspace, site } = await scopeFor(userId, workspaceId, "read-only");
      return { index: await indexStatus.statusOf({ workspaceId: workspace._id, siteId: site?._id ?? null }) };
    },

    /** One branch of the tree. */
    async getTree({ userId, workspaceId, path, depth }) {
      const { scope } = await scopeFor(userId, workspaceId, "read-only");
      return guard(async () => withSelection(scope, await library.tree({ scope, path, depth, maxNodes: 500 })));
    },

    /**
     * One node.
     *
     * A file comes back as it is stored, without the `<!-- user -->` markers an agent is shown:
     * the interface highlights a person's own blocks from the hashes on the node instead, so what
     * they see in the editor is exactly what they saved.
     */
    async getNode({ userId, workspaceId, path }) {
      const { workspace, scope } = await scopeFor(userId, workspaceId, "read-only");
      return guard(async () => ({
        node: await withAuthors(workspace, await withPages(scope, await library.read({ scope, path, markUser: false }))),
      }));
    },

    /**
     * Which files of the knowledge base are behind the site: a page they were written from has
     * changed (or is gone) since, and the agent has not read the new version yet.
     *
     * Every citation a file carries records the page's content hash at the moment it was read, and
     * the crawl keeps each page's current hash beside its Markdown, so "changed since" is a
     * comparison of two hashes and nothing has to be fetched or guessed. A page whose new version
     * the agent has already accounted for (its ledger row's `reviewedHash`) is not counted: the agent
     * read it and judged the file still right, and calling that file stale would be a false alarm
     * nobody could clear. A page with no current copy left the site, or the crawl.
     *
     * Read-only and up; it writes nothing. Copies under Sources are not files of the knowledge base
     * and are not listed. Only files that are behind are returned, with
     * how many were looked at.
     */
    async getFreshness({ userId, workspaceId }) {
      const { workspace, site, scope } = await scopeFor(userId, workspaceId, "read-only");
      const files = await database.collection(AGENT_COLLECTIONS.libraryNodes)
        .find(
          {
            workspaceId: workspace._id,
            kind: LIBRARY_NODE_KINDS.file,
            removed: { $ne: true },
            path: { $not: /^\/sources(\/|$)/ },
          },
          { projection: { path: 1, title: 1, sources: 1, updatedAt: 1 } },
        )
        .toArray();
      if (!site) return { checked: files.length, behind: [], checkedAt: new Date().toISOString() };

      const cited = (file) => (file.sources ?? []).filter((source) => source?.kind === "page" && source.key && source.hash);
      const keys = [...new Set(files.flatMap((file) => cited(file).map((source) => source.key)))];
      const [current, reviewed] = keys.length
        ? await Promise.all([
          database.collection(AGENT_COLLECTIONS.markdown)
            .find({ siteId: site._id, urlHash: { $in: keys } }, { projection: { urlHash: 1, hash: 1, url: 1, title: 1 } })
            .toArray(),
          database.collection(AGENT_COLLECTIONS.knowledgeSources)
            .find(
              { workspaceId: workspace._id, agentSlug: KNOWLEDGE_AGENT_SLUG, sourceKind: "page", sourceKey: { $in: keys } },
              { projection: { sourceKey: 1, reviewedHash: 1 } },
            )
            .toArray(),
        ])
        : [[], []];
      const now = new Map(current.map((row) => [row.urlHash, row]));
      const seen = new Map(reviewed.map((row) => [row.sourceKey, row.reviewedHash ?? null]));

      const behind = [];
      for (const file of files) {
        const changed = [];
        const gone = [];
        for (const source of cited(file)) {
          const page = now.get(source.key);
          const entry = { key: source.key, url: page?.url ?? source.url ?? null, title: page?.title ?? source.title ?? null };
          if (!page) gone.push(entry);
          else if (page.hash && page.hash !== source.hash && seen.get(source.key) !== page.hash) changed.push(entry);
        }
        if (changed.length || gone.length) {
          behind.push({
            path: file.path,
            title: file.title ?? null,
            writtenAt: file.updatedAt ? new Date(file.updatedAt).toISOString() : null,
            pages: cited(file).length,
            changed,
            gone,
          });
        }
      }
      // Whether each page is one the knowledge base is written from — a changed one of those starts
      // the next write run on its own; a changed one that was left out does not — and where its
      // copy is, so the page can open it beside the file.
      const flagged = [...new Set(behind.flatMap((file) => [...file.changed, ...file.gone].map((page) => page.key)))];
      if (flagged.length) {
        const pages = new Map((await library.sourcePages({ scope, keys: flagged })).map((page) => [page.key, page]));
        for (const file of behind) {
          for (const page of [...file.changed, ...file.gone]) {
            page.chosen = pages.get(page.key)?.chosen ?? false;
            page.copyPath = pages.get(page.key)?.path ?? null;
          }
        }
      }
      behind.sort((left, right) => (right.changed.length + right.gone.length) - (left.changed.length + left.gone.length) || left.path.localeCompare(right.path));
      return { checked: files.length, behind, checkedAt: new Date().toISOString() };
    },

    /** Where the copy of one page of the site is, given the page's address. */
    async locatePage({ userId, workspaceId, url }) {
      const { scope } = await scopeFor(userId, workspaceId, "read-only");
      return guard(() => library.locatePage({ scope, url }));
    },

    /** The files that link to one node, each with the line the link is in. */
    async getBacklinks({ userId, workspaceId, path }) {
      const { scope } = await scopeFor(userId, workspaceId, "read-only");
      return guard(() => library.backlinks({ scope, path }));
    },

    /** Files matching a search, with a line of context each. */
    async search({ userId, workspaceId, query, path, limit }) {
      const { scope } = await scopeFor(userId, workspaceId, "read-only");
      return guard(() => library.search({ scope, query, path, limit }));
    },

    /**
     * Passages that answer a question, found by meaning: the same search a person's own AI makes
     * with `content_search`, for the Library page's quick switcher.
     *
     * Each passage names the Library file it opens. A Library file's passage carries its path; a
     * page's carries its address, and is given the path of its copy under `/sources/website`, so
     * every result opens inside the Library rather than on the live site. A page with no copy
     * keeps a null path and its address.
     *
     * Without an index this refuses with the reason, rather than answering with nothing: "nothing
     * matches" and "nothing can be searched" call for different things from the person reading.
     */
    async searchPassages({ userId, workspaceId, query, kinds, limit }) {
      const { workspace, site, scope } = await scopeFor(userId, workspaceId, "read-only");
      if (!retrieval) {
        throw new AppError({
          status: 503,
          code: retrievalReason?.code ?? "INDEX_UNAVAILABLE",
          message: retrievalReason?.message ?? "Search by meaning is not available on this server.",
          expose: true,
        });
      }
      let found;
      try {
        found = await retrieval.search({
          workspaceId: workspace._id,
          query,
          kinds,
          limit,
          trace: { runId: null, siteId: site?._id ?? null, agentSlug: null },
        });
      } catch (error) {
        // Qdrant down, or the embedding provider refusing: said with its own code, like the tool.
        if (error?.code) throw new AppError({ status: 503, code: error.code, message: error.message, expose: true });
        throw error;
      }
      const addresses = [...new Set(found.results.filter((result) => !result.path && result.url).map((result) => result.url))];
      const copies = new Map(await Promise.all(addresses.map(async (url) => {
        try {
          return [url, (await library.locatePage({ scope, url })).path];
        } catch {
          return [url, null];
        }
      })));
      return {
        query: found.query,
        total: found.total,
        results: found.results.map((result) => ({
          kind: result.sourceKind,
          path: result.path ?? copies.get(result.url) ?? null,
          url: result.url,
          title: result.title,
          headingPath: result.headingPath,
          snippet: result.snippet,
          score: result.score,
        })),
      };
    },

    /** Creates or replaces one folder or file, as this person. */
    async saveNode({ userId, workspaceId, path, node }) {
      const { scope } = await scopeFor(userId, workspaceId, "member");
      return guard(async () => {
        if (node.kind === LIBRARY_NODE_KINDS.folder) {
          return library.mkdir({ scope, path, title: node.title, summary: node.summary, actor: { userId } });
        }
        return library.writeFile({
          scope,
          path,
          title: node.title,
          summary: node.summary,
          markdown: node.markdown ?? "",
          sources: node.sources ?? [],
          tags: node.tags ?? [],
          actor: { userId },
        });
      });
    },

    /**
     * Moves or renames a node, taking its subtree, its history and every link to it along.
     * `title`, when given, is its new display name: a rename changes both.
     */
    async moveNode({ userId, workspaceId, path, to, title }) {
      const { scope } = await scopeFor(userId, workspaceId, "member");
      return guard(() => library.move({ scope, from: path, to, title, actor: { userId } }));
    },

    /** Opts a file or a branch out of agent writes, or back in. */
    async setLocked({ userId, workspaceId, path, locked }) {
      const { scope } = await scopeFor(userId, workspaceId, "member");
      return guard(() => library.setLocked({ scope, path, locked, actor: { userId } }));
    },

    /** Sets where a node sits among its siblings. */
    async reorderNode({ userId, workspaceId, path, order }) {
      const { scope } = await scopeFor(userId, workspaceId, "member");
      return guard(() => library.reorder({ scope, path, order, actor: { userId } }));
    },

    /** Deletes a file, or an empty folder. */
    async deleteNode({ userId, workspaceId, path }) {
      const { scope } = await scopeFor(userId, workspaceId, "member");
      return guard(() => library.remove({ scope, path, actor: { userId } }));
    },

    /** Every kept version of one file. */
    async listRevisions({ userId, workspaceId, path }) {
      const { scope } = await scopeFor(userId, workspaceId, "read-only");
      const listed = await guard(() => library.listRevisions({ scope, path }));
      // Each person's version says who: the store names the account, and the address is added here.
      const emails = await emailsOf(listed.revisions.map((revision) => revision.updatedBy?.userId));
      return {
        ...listed,
        revisions: listed.revisions.map((revision) => (revision.updatedBy?.userId
          ? { ...revision, updatedBy: { ...revision.updatedBy, email: emails.get(revision.updatedBy.userId) ?? null } }
          : revision)),
      };
    },

    /** Puts a file back to one of its kept versions, as a new version. */
    async restoreRevision({ userId, workspaceId, path, revision }) {
      const { scope } = await scopeFor(userId, workspaceId, "member");
      return guard(() => library.restore({ scope, path, revision, actor: { userId } }));
    },
  };
}

/**
 * Which HTTP status each Library refusal is.
 *
 * Separated from the rules themselves because the store is shared with the agent tools, where an
 * HTTP status would be meaningless. A missing node is a 404; a rule about what may be written is
 * a 400; a conflict with something that already exists or is already full is a 409.
 */
const STATUS_BY_CODE = Object.freeze({
  [LIBRARY_ERROR_CODES.nodeMissing]: 404,
  [LIBRARY_ERROR_CODES.revisionMissing]: 404,
  [LIBRARY_ERROR_CODES.nodeExists]: 409,
  [LIBRARY_ERROR_CODES.folderNotEmpty]: 409,
  [LIBRARY_ERROR_CODES.libraryFull]: 409,
  [LIBRARY_ERROR_CODES.kindMismatch]: 409,
  [LIBRARY_ERROR_CODES.reservedPath]: 403,
  [LIBRARY_ERROR_CODES.topLevelProtected]: 403,
  [LIBRARY_ERROR_CODES.userFolderProtected]: 403,
  [LIBRARY_ERROR_CODES.nodeLocked]: 403,
});

/** A moment as ISO text, or null. */
function iso(value) {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** The longest opening paragraph the Home page quotes, in characters. */
const EXCERPT_LIMIT = 420;

/**
 * The overview's first paragraph of prose, as plain text: what the Home page quotes under
 * "Library".
 *
 * Headings, lists and quotes are passed over, because the overview opens with a paragraph that
 * says what the company is and the rest is a map. Links keep their words — `[homepage](…)` reads
 * "homepage" and `[[/02-offer/services]]` reads "services" — so the excerpt is a sentence rather
 * than a run of addresses. Cut at a word, with an ellipsis, past the limit.
 *
 * @param {string|null|undefined} markdown
 * @returns {string|null}
 */
function openingParagraph(markdown) {
  const paragraph = String(markdown ?? "")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block && !/^(?:#|[-*+] |\d+\. |>|\||```|<)/.test(block));
  if (!paragraph) return null;
  const text = paragraph
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_match, path) => path.split("/").filter(Boolean).at(-1)?.replace(/-/g, " ") ?? path)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= EXCERPT_LIMIT) return text;
  return `${text.slice(0, EXCERPT_LIMIT).replace(/\s+\S*$/, "")}…`;
}
