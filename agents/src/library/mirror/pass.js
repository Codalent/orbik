import { AGENT_COLLECTIONS, KNOWLEDGE_AGENT_SLUG, describePageKind, log } from "@orbik/core";
import {
  BRAND_ROOT_PATH,
  LIBRARY_ERROR_CODES,
  LIBRARY_LIMITS,
  LIBRARY_NODE_KINDS,
  LIBRARY_SOURCE_KINDS,
  SOURCE_LAYER_WRITER_SLUG,
  SOURCE_ROOT_PATH,
  SOURCE_SELECTION_SLUG,
  SOURCE_WEBSITE_PATH,
  SYNTHESIS_PAGE_CEILING,
  chooseSynthesisPages,
  createLibraryStore,
  keepUserWriting,
  librarySegmentOf,
  noindexPageKeys,
  siteWidePages,
  sourceMirrorVerdict,
  sourcePageFolders,
  sourcePagePath,
} from "@orbik/library";
import { splitFrontMatter } from "@orbik/retrieval";
import { recordSelection, reviewSources } from "@orbik/tools";

/**
 * One pass of the source layer: bring a workspace's copy of its site up to date with the crawl,
 * and decide which of those pages the knowledge base is written from.
 *
 * This is the piece that used to cost a model call per page. It read a page and wrote a note, and
 * a site of 4,700 posts was 4,700 calls before anything else could start. Now it copies: the
 * page's own Markdown is the file, its own title and description are the file's title and
 * summary, and **no model is asked anything**. The unit of "already done" is still a content
 * hash, a pass is still bounded and re-queues itself, and a failure is still recorded against the
 * row it could not finish rather than thrown away.
 *
 * Nothing in here is a judgement a model makes. Which pages are stored is
 * {@link sourceMirrorVerdict}'s rule; where a file goes is {@link sourcePagePath}'s mirror of the
 * URL; which pages the knowledge base is written from is {@link chooseSynthesisPages}' rule. The
 * model's work starts after this, in the write run, and only on the pages chosen here.
 */

/**
 * Pages one pass may copy before the caller is asked to queue another.
 *
 * Ten times what a pass of notes was, because a copy is a handful of database writes rather than
 * a model call. Still bounded: a first pass over a five-thousand-page site is twenty-five of
 * these, each inside its own lease, rather than one job holding a lease for the whole of it.
 */
export const MAX_PAGES_PER_PASS = 200;

/** Characters of a page's own text a summary is cut from when the page has no description. */
const SUMMARY_CHARACTERS = 240;

/** What separates a page's title from the site's name, in the forms sites actually use. */
const TITLE_SEPARATORS = Object.freeze([" | ", " • ", " · ", " — ", " – ", " - ", " :: ", " » "]);

/**
 * Mirrors a bounded number of this workspace's pages and records the choice for all of them.
 *
 * @param {object} options
 * @param {import("mongodb").Db} options.database connected database
 * @param {import("mongodb").ObjectId} options.workspaceId owning workspace
 * @param {import("mongodb").ObjectId|null} options.siteId the crawl whose pages these are
 * @param {number} [options.limit] pages this pass may copy
 * @param {number} [options.ceiling] the most pages the knowledge base is written from
 * @param {() => Promise<unknown>} [options.heartbeat] extends the caller's lease between pages
 * @param {AbortSignal} [options.signal] cancellation
 * @param {(level: string, message: string, context?: object) => void} [options.logger]
 * @param {() => Date} [options.now] clock
 */
export async function mirrorWorkspace({
  database,
  workspaceId,
  siteId,
  limit = MAX_PAGES_PER_PASS,
  ceiling = SYNTHESIS_PAGE_CEILING,
  heartbeat,
  signal,
  logger = log,
  now = () => new Date(),
}) {
  const markdown = database.collection(AGENT_COLLECTIONS.markdown);
  const urls = database.collection(AGENT_COLLECTIONS.urls);
  const links = database.collection(AGENT_COLLECTIONS.links);
  const verdicts = database.collection(AGENT_COLLECTIONS.knowledgeSources);
  const state = database.collection(AGENT_COLLECTIONS.sourceNotes);
  const nodes = database.collection(AGENT_COLLECTIONS.libraryNodes);
  const library = createLibraryStore({ database });
  const scope = { workspaceId, siteId };
  const actor = { agentSlug: SOURCE_LAYER_WRITER_SLUG, runId: null };

  const counters = {
    // `skipped` is how many pages are currently not stored, not how many were newly left out:
    // "seven of seventy-two pages are not stored" is the number worth reading in a log.
    pages: 0, pending: 0, mirrored: 0, unchanged: 0, skipped: 0, removed: 0, failed: 0, remaining: 0,
    chosen: 0, held: 0, orphans: 0, relocated: 0,
  };
  if (!siteId) return counters;

  // Everything the rules need, without a word of any page: on a five-thousand-page site, loading
  // the Markdown to find the three pages that moved would be the expensive part of a pass that
  // then writes nothing.
  const [pages, registry, ledger, rows, noindex, cited] = await Promise.all([
    markdown
      .find({ siteId })
      .project({
        urlHash: 1, url: 1, title: 1, heading: 1, hash: 1, words: 1, contentType: 1,
        structuredDataTypes: 1, publishedAt: 1, modifiedAt: 1, renderedAt: 1, updatedAt: 1,
      })
      .toArray(),
    urls
      .find({ siteId })
      .project({ urlHash: 1, depth: 1, inboundCount: 1, variantOf: 1 })
      .toArray(),
    verdicts
      .find({ workspaceId, agentSlug: KNOWLEDGE_AGENT_SLUG, sourceKind: LIBRARY_SOURCE_KINDS.page })
      .project({ sourceKey: 1, relevant: 1, reason: 1, reviewedBy: 1 })
      .toArray(),
    state.find({ workspaceId }).toArray(),
    noindexPageKeys(database, siteId),
    citedPages(nodes, workspaceId),
  ]);

  counters.pages = pages.length;
  const signals = new Map(registry.map((row) => [row.urlHash, row]));
  const byKey = new Map(rows.map((row) => [row.sourceKey, row]));
  const ledgerByKey = new Map(ledger.map((row) => [row.sourceKey, row]));

  // Paths that are folders in the mirror because some other page sits under them. A URL can be a
  // document and a directory at once — `/blog` is a real page and `/blog/a-post` puts a folder at
  // the same path — and a Library path is one or the other, never both. Computed over every page
  // first, because a path's kind depends on the whole site rather than on the page being placed.
  const folders = new Set();
  for (const page of pages) {
    const raw = sourcePagePath(page.url);
    if (raw) for (const folder of sourcePageFolders(raw)) folders.add(folder.path);
  }

  // --------------------------------------------------------------------------------------------
  // Pages that have gone.
  //
  // The file stays where it is, marked. Deleting it would break every subject file that links it
  // and would throw away the only remaining record of what the page said; moving it to an archive
  // folder would break the same links and re-create the file if the page ever came back.
  const present = new Set(pages.map((page) => page.urlHash));
  for (const row of rows) {
    if (present.has(row.sourceKey) || row.removed === true || !row.path) continue;
    signal?.throwIfAborted();
    const at = now();
    const marked = await markRemoved({ library, nodes, scope, actor, row, at });
    await state.updateOne(
      { workspaceId, sourceKey: row.sourceKey },
      // A page the knowledge base was written from going away is something the next write run
      // has to hear about; one it was never written from is not.
      { $set: { removed: true, removedAt: at, ...(row.chosen === true ? { movedAt: at } : {}) } },
    );
    if (marked) counters.removed += 1;
  }

  // --------------------------------------------------------------------------------------------
  // Files no page stands behind.
  counters.orphans = await sweepOrphans({ library, nodes, scope, actor, workspaceId, rows });

  // --------------------------------------------------------------------------------------------
  // Which pages are stored.
  const stored = [];
  const leaving = new Set();
  for (const page of pages) {
    const row = byKey.get(page.urlHash) ?? null;
    const registryRow = signals.get(page.urlHash) ?? {};
    // A person asked for this page by name. It overrides the site's own noindex and nothing else:
    // two copies of the same words under two paths, or a file with nothing in it, are outcomes no
    // override should be able to buy.
    const included = row?.include === true;
    const verdict = sourceMirrorVerdict({
      variant: Boolean(registryRow.variantOf),
      noindex: noindex.has(page.urlHash),
      words: page.words ?? 0,
      included,
    });
    if (!verdict.store) {
      await recordSkip({
        database, state, scope, workspaceId, page, row, verdict, library, nodes, actor, now,
        stamped: ledgerByKey.get(page.urlHash)?.reviewedBy === SOURCE_LAYER_WRITER_SLUG,
      });
      // Its file has just been removed, so its path is free for whichever page belongs there.
      leaving.add(page.urlHash);
      counters.skipped += 1;
      continue;
    }
    stored.push({ page, registry: registryRow, row, included });
  }

  // Paths already spoken for, so a URL that would slugify onto a path another page's file already
  // holds gets a distinct one — and gets the *same* distinct one on every later pass. Only paths
  // a file was actually written to count: a path recorded beside a failure is a guess this pass is
  // free to reconsider, and reusing one would repeat the mistake that caused the failure forever.
  // A path written while the layer still held notes counts too, which is what puts each page's
  // copy exactly where its note was.
  //
  // Worked out after the skips, not before: a page that became a duplicate in this pass has just
  // lost its file, and counting its path as taken gave the page it duplicates a collision suffix
  // against a file that no longer existed — the `https://` twin of 650 pages of one site.
  const taken = new Set(rows
    .filter((row) => isWritten(row) && row.path && !leaving.has(row.sourceKey))
    .map((row) => row.path));

  // --------------------------------------------------------------------------------------------
  // Which of them the knowledge base is written from.
  //
  // Decided over the whole site on every pass rather than page by page as each is copied, because
  // it is a ranking: whether the fortieth page is in depends on the thirty-nine ahead of it.
  const candidates = stored.map(({ page, registry: registryRow, included }) => ({
    key: page.urlHash,
    url: page.url,
    words: page.words ?? 0,
    inboundCount: registryRow.inboundCount ?? 0,
    depth: registryRow.depth ?? null,
    publishedAt: page.publishedAt ?? null,
    included,
    cited: cited.has(page.urlHash),
  }));
  const outbound = await outboundLinks(links, siteId, siteWidePages(candidates, pages.length), signals);
  const selection = chooseSynthesisPages(candidates, { siteSize: pages.length, outbound, ceiling });
  const lists = new Map(selection.listings.map((listing) => [listing.key, listing.children.length]));
  await recordChoices({ database, state, scope, workspaceId, stored, selection, lists, ledgerByKey, cited, now });
  counters.chosen = [...selection.decisions.values()].filter((decision) => decision.chosen).length;

  // --------------------------------------------------------------------------------------------
  // What has to be copied, and where.
  const moves = await plannedMoves({ nodes, workspaceId, stored, taken, folders });
  // A path a copy is moving to is spoken for from now, so no page placed ahead of the move in
  // this loop is put there too.
  for (const to of moves.values()) taken.add(to);
  const keepers = await sharedPathKeepers({ nodes, workspaceId, stored });
  const wanted = [];
  for (const entry of stored) {
    const { page, row } = entry;
    const recorded = row && isWritten(row) && row.path ? row.path : null;
    // A path another page's row names too, and that page keeps: this one is copied afresh to a
    // path of its own, and the file there is left to the page it is a copy of.
    const displaced = Boolean(recorded && keepers.has(recorded) && keepers.get(recorded) !== page.urlHash);
    const written = displaced ? null : recorded;
    const relocateFrom = moves.has(page.urlHash) ? written : null;
    const filePath = relocateFrom ? moves.get(page.urlHash) : written ?? sourcePagePath(page.url, { taken, folders });
    if (!filePath) continue;
    taken.add(filePath);

    // The reasons to copy a page, and nothing else is one. A page whose hash matches what its
    // file was copied from is finished, however long ago that was. `mirroredAt` is what tells a
    // copy from the note that used to sit at the same path: a row written while the layer held
    // notes has the page's hash and a digest for a body, and is replaced once.
    //
    // Two more reasons copy a page without its words having moved: the facts printed above them
    // — what kind of page it is, the dates it gives — have changed, or it is being moved to the
    // path it belongs at. Neither is news to the knowledge base, so neither starts a write run.
    const facts = factsOf(page);
    const moved = !row || !row.mirroredAt || row.hash !== page.hash || row.removed === true;
    const stale = moved || displaced || Boolean(row.error) || row.facts !== factsKey(facts) || Boolean(relocateFrom);
    if (!stale) {
      counters.unchanged += 1;
      continue;
    }
    wanted.push({
      ...entry,
      filePath,
      relocateFrom,
      facts,
      moved,
      chosen: selection.decisions.get(page.urlHash)?.chosen === true,
    });
  }

  counters.pending = wanted.length;
  // The pages the knowledge base is written from go first, most linked first: on a first pass
  // over a large site those are the ones a write run is waiting for.
  wanted.sort((left, right) => Number(right.chosen) - Number(left.chosen)
    || (right.registry.inboundCount ?? 0) - (left.registry.inboundCount ?? 0));

  const batch = wanted.slice(0, limit);
  counters.remaining = Math.max(0, wanted.length - batch.length);
  if (!batch.length) {
    await refreshFolderSummaries({ library, nodes, scope, actor, workspaceId });
    return counters;
  }

  // Folders before files: `library.writeFile` refuses a path whose parent does not exist, and
  // creating them one file at a time would rewrite `/sources/website/services` seventy times.
  await ensureFolders({ library, nodes, scope, actor, workspaceId, paths: batch.map((entry) => entry.filePath) });

  const site = await describeSite({ markdown, siteId, pages, signals });

  for (const entry of batch) {
    signal?.throwIfAborted();
    try {
      const outcome = await mirrorOnePage({ markdown, nodes, state, library, scope, actor, workspaceId, siteId, site, entry, now });
      if (outcome === "held") counters.held += 1;
      else if (outcome === "mirrored") {
        counters.mirrored += 1;
        if (entry.relocateFrom) counters.relocated += 1;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      // Recorded against this page and nothing else. The hash is left alone, so the next pass sees
      // the same work outstanding — and the rest of the batch is still copied, which is the whole
      // reason the unit of work is one page.
      await state.updateOne(
        { workspaceId, sourceKey: entry.page.urlHash },
        {
          $set: {
            error: {
              code: error?.code ?? "MIRROR_FAILED",
              message: String(error?.message ?? "").slice(0, 400),
              at: now(),
            },
            attemptedAt: now(),
            url: entry.page.url,
            // A copy that was being moved is still where it was: that is the file the row stands for.
            path: entry.relocateFrom ?? entry.filePath,
          },
          $unset: { skipped: "", reason: "", skippedAt: "" },
          $setOnInsert: { workspaceId, siteId, sourceKind: LIBRARY_SOURCE_KINDS.page, sourceKey: entry.page.urlHash, createdAt: now() },
        },
        { upsert: true },
      );
      counters.failed += 1;
      logger("warn", "sources.page_failed", {
        workspaceId: workspaceId.toHexString(),
        url: entry.page.url,
        code: error?.code ?? "MIRROR_FAILED",
        message: error?.message,
      });
    }
    await heartbeat?.();
  }

  if (!counters.remaining) {
    await refreshFolderSummaries({ library, nodes, scope, actor, workspaceId });
  }
  return counters;
}

/** Whether a state row records a file that was actually written, as a copy or as the note before it. */
function isWritten(row) {
  return Boolean(row.mirroredAt || row.notedAt);
}

/**
 * Removes the copies in the source layer that no page stands behind.
 *
 * Every copy the layer keeps is the `path` of one page's state row; a file of the layer's own that
 * no row names is left over. Until 2026-10-14 two passes over one workspace could run at once —
 * the scheduler's, started while the crawl was still deciding which URLs were duplicates, and the
 * one the crawl handed off — and each copied pages from its own view of which paths were taken.
 * One development site was left with 54 such files: a page stored twice, the second time under a
 * collision suffix, and copies of duplicates that were never cleared away. They are found by
 * arithmetic rather than by remembering what went wrong, so whatever leaves one behind next is
 * cleared by the same sweep.
 *
 * Only the layer's own files are touched. A file a person wrote in, or locked, is theirs, and one
 * a person made under `/sources` is a document like any other. A removal keeps the file's history,
 * like every other.
 *
 * @returns {Promise<number>} how many were removed
 */
async function sweepOrphans({ library, nodes, scope, actor, workspaceId, rows }) {
  const claimed = new Set(rows.filter((row) => row.path).map((row) => row.path));
  const files = await nodes
    .find({
      workspaceId,
      kind: LIBRARY_NODE_KINDS.file,
      path: { $regex: `^${SOURCE_WEBSITE_PATH}/` },
      "authors.agent": SOURCE_LAYER_WRITER_SLUG,
      hasUserContent: { $ne: true },
      locked: { $ne: true },
    })
    .project({ path: 1 })
    .toArray();
  let swept = 0;
  for (const file of files) {
    if (claimed.has(file.path)) continue;
    try {
      await library.remove({ scope, path: file.path, actor });
      swept += 1;
    } catch {
      // A locked folder above it. It stays until the lock is lifted, like everything under one.
    }
  }
  return swept;
}

/**
 * Which copies move this pass to the path their URL gives them, and where to.
 *
 * A path is kept once written, so a link to it keeps working, and a collision is resolved with a
 * suffix against the paths already taken. The suffix outlives the collision: when the file that
 * held the plain path goes, the page that took the suffix keeps it for good, and its path can no
 * longer be told from its URL. So a copy moves back to its plain path once that path is free —
 * no page's copy is there, and nothing else is either — unless a Library file links to the path
 * it has, which a move would break, or a person has written in it or locked it.
 *
 * A move is a fresh copy at the new path and the removal of the old one, rather than a rename:
 * the plain path may have a history of its own from the file that was there, and a copy written
 * there continues it.
 *
 * @returns {Promise<Map<string, string>>} the page's URL hash, to the path it moves to
 */
async function plannedMoves({ nodes, workspaceId, stored, taken, folders }) {
  const wanted = new Map();
  const claimed = new Set();
  for (const { page, row } of stored) {
    const from = row && isWritten(row) && row.path ? row.path : null;
    if (!from || row.error) continue;
    const to = sourcePagePath(page.url, { folders });
    // Into its own folder is the URL becoming a directory, which is a different problem: the file
    // is in the way of the folder it would move into.
    if (!to || to === from || taken.has(to) || claimed.has(to) || to.startsWith(`${from}/`)) continue;
    claimed.add(to);
    wanted.set(page.urlHash, { from, to });
  }
  if (!wanted.size) return new Map();

  const moves = [...wanted.values()];
  const [linking, occupied, kept] = await Promise.all([
    nodes.find({ workspaceId, links: { $in: moves.map((move) => move.from) } }).project({ links: 1 }).toArray(),
    nodes.find({ workspaceId, path: { $in: moves.map((move) => move.to) } }).project({ path: 1 }).toArray(),
    nodes
      .find({ workspaceId, path: { $in: moves.map((move) => move.from) }, $or: [{ hasUserContent: true }, { locked: true }] })
      .project({ path: 1 })
      .toArray(),
  ]);
  const linked = new Set(linking.flatMap((row) => row.links ?? []));
  const filled = new Set(occupied.map((row) => row.path));
  const theirs = new Set(kept.map((row) => row.path));

  const planned = new Map();
  for (const [key, { from, to }] of wanted) {
    if (linked.has(from) || filled.has(to) || theirs.has(from)) continue;
    planned.set(key, to);
  }
  return planned;
}

/**
 * The paths two or more stored pages' rows both name, and which page keeps each.
 *
 * One path, one page, is what a pass assumes, and every pass since passes ran one at a time keeps
 * it. Two passes that ran at once could each place a different page at the same free path — two
 * URLs whose slugs are cut to the same sixty-four characters — and both rows then name it, so
 * every copy of one overwrote the other's. The page whose copy is there keeps the path; the first
 * of them in the pass's order does when the file is neither's.
 *
 * @returns {Promise<Map<string, string>>} the shared path, to the URL hash of the page that keeps it
 */
async function sharedPathKeepers({ nodes, workspaceId, stored }) {
  const claimants = new Map();
  for (const { page, row } of stored) {
    if (!row || !isWritten(row) || !row.path) continue;
    claimants.set(row.path, [...(claimants.get(row.path) ?? []), page.urlHash]);
  }
  const shared = [...claimants].filter(([, keys]) => keys.length > 1);
  if (!shared.length) return new Map();
  const files = await nodes
    .find({ workspaceId, path: { $in: shared.map(([path]) => path) }, kind: LIBRARY_NODE_KINDS.file })
    .project({ path: 1, "sources.key": 1 })
    .toArray();
  const holder = new Map(files.map((file) => [file.path, file.sources?.[0]?.key ?? null]));
  return new Map(shared.map(([path, keys]) => [path, keys.includes(holder.get(path)) ? holder.get(path) : keys[0]]));
}

/**
 * What the source layer knows about a page beside its words, as the copy carries it.
 *
 * The kind is the page's own claim, by the rule the crawler stores `contentType` with. The Open
 * Graph type that rule falls back to is not stored on its own, so it is recovered as whatever
 * `contentType` holds that is not one of the declared types — which also corrects a page fetched
 * before the rule took the page's own type rather than its logo's, without fetching it again.
 */
function factsOf(page) {
  const types = page.structuredDataTypes ?? [];
  const openGraphType = page.contentType && !types.includes(page.contentType) ? page.contentType : null;
  return {
    url: page.url,
    kind: describePageKind({ structuredDataTypes: types, openGraphType }),
    publishedAt: page.publishedAt ?? null,
    modifiedAt: page.modifiedAt ?? null,
  };
}

/** The facts as one string, stored on the state row so the next pass can tell whether they changed. */
function factsKey(facts) {
  const day = (value) => (value ? isoDay(value) : "");
  return [facts.kind ?? "", day(facts.publishedAt), day(facts.modifiedAt)].join("|");
}

/**
 * The pages some file of the knowledge base cites, by URL hash.
 *
 * Read from the `sources` every file stores rather than from the ledger, because the ledger
 * remembers a citation after the file that made it has been rewritten without it. The brand
 * folder is left out: its guide is measured from pages as rendered in a browser, and a change to
 * one of those pages' words is not something the knowledge base has to be rewritten for.
 */
async function citedPages(nodes, workspaceId) {
  const rows = await nodes
    .aggregate([
      {
        $match: {
          workspaceId,
          kind: LIBRARY_NODE_KINDS.file,
          path: { $not: new RegExp(`^(${SOURCE_ROOT_PATH}|${BRAND_ROOT_PATH})(/|$)`) },
        },
      },
      { $project: { sources: 1 } },
      { $unwind: "$sources" },
      { $match: { "sources.kind": LIBRARY_SOURCE_KINDS.page } },
      { $group: { _id: "$sources.key" } },
    ])
    .toArray();
  return new Set(rows.map((row) => row._id));
}

/**
 * What each site-wide page links to, as the pages themselves rather than as URLs.
 *
 * A link may name a duplicate — the trailing-slash twin of a page — and what it points at is the
 * page, so each target is resolved to the page its duplicate group is stored as.
 *
 * @returns {Promise<Map<string, Set<string>>>} URL hash of the linking page to the hashes it links to
 */
async function outboundLinks(links, siteId, from, signals) {
  const outbound = new Map();
  if (!from.size) return outbound;
  const cursor = links.aggregate([
    { $match: { siteId, internal: true, fromUrlHash: { $in: [...from] } } },
    { $group: { _id: { from: "$fromUrlHash", to: "$toUrlHash" } } },
  ]);
  for await (const row of cursor) {
    const target = signals.get(row._id.to)?.variantOf ?? row._id.to;
    if (!outbound.has(row._id.from)) outbound.set(row._id.from, new Set());
    outbound.get(row._id.from).add(target);
  }
  return outbound;
}

/**
 * Records the choice for every stored page: on the knowledge agent's ledger, where a person reads
 * it, and on the page's own state row, where the scheduler and the Library read it.
 *
 * Only what changed is written. The choice is made again on every pass and is nearly always the
 * same, and rewriting seventy ledger rows a pass would move `reviewedAt` on every page of the
 * site for the rest of its life.
 *
 * A ledger row the agent wrote itself is left exactly as it is while the page is still chosen.
 * Writing a file records the pages it cites, at the content they had, and that hash is what tells
 * the next run which of them changed — so restating "this page is chosen" over it would erase the
 * one fact the row is there to keep.
 */
async function recordChoices({ database, state, scope, workspaceId, stored, selection, lists, ledgerByKey, cited, now }) {
  const at = now();
  const ledgerWrites = [];
  const stateWrites = [];

  for (const { page, row } of stored) {
    const decision = selection.decisions.get(page.urlHash);
    if (!decision) continue;

    const recorded = ledgerByKey.get(page.urlHash) ?? null;
    const ours = recorded?.reviewedBy === SOURCE_SELECTION_SLUG || recorded?.reviewedBy === SOURCE_LAYER_WRITER_SLUG;
    const standing = recorded && !ours && recorded.relevant === true && decision.chosen;
    const unchanged = recorded?.reviewedBy === SOURCE_SELECTION_SLUG
      && recorded.relevant === decision.chosen && recorded.reason === decision.message;
    if (!standing && !unchanged) {
      ledgerWrites.push({
        key: page.urlHash,
        url: page.url,
        title: page.title ?? page.heading ?? null,
        relevant: decision.chosen,
        reason: decision.message,
        // A page some file cites was written from at the hash on its row. Any other row of ours
        // was stamped by the note that used to stand in for the page, which is not a reading by
        // the knowledge base, and starts again with none.
        keepHash: cited.has(page.urlHash) || Boolean(recorded && !ours),
      });
    }

    const listedBy = decision.listedBy;
    const count = lists.get(page.urlHash) ?? 0;
    const same = row
      && row.chosen === decision.chosen
      && row.chosenReason === decision.reason
      && (row.lists ?? 0) === count
      && sameList(row.listedBy ?? [], listedBy);
    if (same) continue;
    stateWrites.push({
      updateOne: {
        filter: { workspaceId, sourceKey: page.urlHash },
        update: {
          $set: {
            chosen: decision.chosen,
            chosenReason: decision.reason,
            listedBy,
            lists: count,
            // Newly chosen is the source layer moving, as far as the write run is concerned:
            // there is a page it should be written from and has not been. A page chosen because
            // a file already cites it is the exception. The knowledge base was written from it
            // a moment ago, which is how it came to be cited, and starting a run to tell it so
            // would be a run with nothing to do.
            ...(decision.chosen && row?.chosen !== true
              ? { chosenAt: at, ...(cited.has(page.urlHash) ? {} : { movedAt: at }) }
              : {}),
          },
          $setOnInsert: {
            workspaceId,
            sourceKey: page.urlHash,
            siteId: scope.siteId,
            sourceKind: LIBRARY_SOURCE_KINDS.page,
            url: page.url,
            createdAt: at,
          },
        },
        upsert: true,
      },
    });
  }

  if (ledgerWrites.length) {
    await recordSelection({
      database,
      scope: { workspaceId, siteId: scope.siteId, agentSlug: KNOWLEDGE_AGENT_SLUG },
      entries: ledgerWrites,
      by: SOURCE_SELECTION_SLUG,
      now: at,
    });
  }
  if (stateWrites.length) await state.bulkWrite(stateWrites, { ordered: false });
}

/** Whether two lists hold the same keys in the same order. */
function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * What the pass knows about the site as a whole, for naming and summarising one page of it.
 *
 * Two things, and both are there to stop every file in the mirror reading the same. Most sites
 * end every `<title>` with their own name, and many give every page the same description — the
 * home page's. The first is found by counting and the second by reading one page.
 */
async function describeSite({ markdown, siteId, pages, signals }) {
  const tails = new Map();
  let titled = 0;
  for (const page of pages) {
    const tail = trailingSegment(page.title);
    if (!page.title) continue;
    titled += 1;
    if (tail) tails.set(tail.tail, (tails.get(tail.tail) ?? 0) + 1);
  }
  let brand = null;
  for (const [tail, count] of tails) {
    // More than half the site's titles end with it: that is the site's name, not part of a title.
    if (count >= 3 && count * 2 > titled && (!brand || count > tails.get(brand))) brand = tail;
  }

  const home = pages.find((page) => signals.get(page.urlHash)?.depth === 0) ?? null;
  let description = null;
  if (home) {
    const document = await markdown.findOne({ siteId, urlHash: home.urlHash }, { projection: { markdown: 1 } });
    description = splitFrontMatter(document?.markdown ?? "").fields.description ?? null;
  }
  return { brand, homeKey: home?.urlHash ?? null, description };
}

/** The part of a title after its last separator, or null when it has none. */
function trailingSegment(title) {
  const text = String(title ?? "").trim();
  let best = null;
  for (const separator of TITLE_SEPARATORS) {
    const at = text.lastIndexOf(separator);
    if (at > 0 && (!best || at > best.at)) best = { at, separator };
  }
  if (!best) return null;
  return { head: text.slice(0, best.at).trim(), tail: text.slice(best.at + best.separator.length).trim() };
}

/**
 * What a source file is called: the page's own title, without the site's name on the end.
 *
 * The `<title>` rather than the first heading, because on a marketing site the heading is a
 * headline — "AI agents built around your real workflows" — and the title is what the page is:
 * "Custom AI Agent Development Services". The heading stands in when the title is only the site's
 * name, and the URL when there is neither.
 */
function titleOf(page, site) {
  let title = String(page.title ?? "").trim();
  for (let guard = 0; guard < 4 && site.brand; guard += 1) {
    const tail = trailingSegment(title);
    if (!tail || tail.tail !== site.brand) break;
    title = tail.head;
  }
  if (!title || title === site.brand) title = String(page.heading ?? "").trim();
  if (!title) title = page.urlHash === site.homeKey ? "Home" : wordsOf(lastSegment(page.url));
  if (!title) title = site.brand ?? "Untitled";
  return title.length > LIBRARY_LIMITS.title ? `${title.slice(0, LIBRARY_LIMITS.title - 1).trimEnd()}…` : title;
}

/**
 * One line saying what a page is: its own description, or its opening words.
 *
 * A description the page shares with the home page is the site's default rather than a
 * description of this page, and showing it against forty files would make forty summaries that
 * say nothing. The page's own first paragraph is used instead.
 */
function summaryOf(page, fields, body, site) {
  const description = String(fields.description ?? "").replace(/\s+/g, " ").trim();
  const shared = description && site.description === description && page.urlHash !== site.homeKey;
  const text = description && !shared ? description : openingOf(body);
  const summary = text || titleOf(page, site);
  return summary.length > LIBRARY_LIMITS.summary ? `${summary.slice(0, LIBRARY_LIMITS.summary - 1).trimEnd()}…` : summary;
}

/** The first paragraph of prose in a page's Markdown, as plain words, cut at a word. */
function openingOf(body) {
  for (const block of String(body ?? "").split(/\n{2,}/)) {
    const line = block.trim();
    // A heading, an image, a table, a list or a line that is only a link is not an opening.
    if (!line || /^(#{1,6}\s|!\[|\||[-*+]\s|\d+\.\s|>|```|<)/.test(line)) continue;
    const plain = line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (plain.split(" ").length < 6) continue;
    if (plain.length <= SUMMARY_CHARACTERS) return plain;
    const cut = plain.slice(0, SUMMARY_CHARACTERS);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).trimEnd()}…`;
  }
  return "";
}

/**
 * Copies one page into the Library: the file, then the state row.
 *
 * In that order, and the state row last on purpose. Every step before it is idempotent — the same
 * page copied twice produces the same file at the same path — so a crash anywhere in the sequence
 * costs one repeated copy on the next pass and never a missing file recorded as present.
 *
 * @returns {Promise<"mirrored"|"held"|"gone">}
 */
async function mirrorOnePage({ markdown, nodes, state, library, scope, actor, workspaceId, siteId, site, entry, now }) {
  const { page, filePath } = entry;

  const document = await markdown.findOne(
    { siteId, urlHash: page.urlHash },
    { projection: { markdown: 1, hash: 1 } },
  );
  // Deleted between listing and reading. The sweep at the top of the next pass marks its file.
  if (!document) return "gone";

  const existing = await nodes.findOne(
    { workspaceId, path: filePath, kind: LIBRARY_NODE_KINDS.file },
    { projection: { markdown: 1, protectedBlocks: 1, removedBlocks: 1 } },
  );
  const { fields, body } = splitFrontMatter(document.markdown ?? "");
  const at = now();
  const theirs = existing?.protectedBlocks ?? [];
  const removed = existing?.removedBlocks ?? [];
  // Room for what a person wrote inside the file, which is put back below and must still fit.
  const reserved = theirs.reduce((total, block) => total + block.text.length + 2, 0);
  const copy = composeSourceFile({
    page,
    known: entry.facts,
    body,
    hash: document.hash,
    limit: Math.max(1_000, LIBRARY_LIMITS.sourceMarkdown - reserved),
  });
  // Only a file a person has written in or deleted from is passed through the block keeper. It
  // rebuilds a document from its blocks, which is exactly right for carrying their paragraphs
  // into the new copy and would otherwise change the spacing of a page nobody touched.
  const text = theirs.length || removed.length
    ? keepUserWriting({ markdown: copy, previous: existing?.markdown ?? "", protectedBlocks: theirs, removedBlocks: removed })
    : copy;

  const settled = {
    siteId,
    sourceKind: LIBRARY_SOURCE_KINDS.page,
    url: page.url,
    path: filePath,
    hash: document.hash ?? null,
    removed: false,
  };

  let written;
  try {
    written = await library.writeFile({
      scope,
      path: filePath,
      title: titleOf(page, site),
      summary: summaryOf(page, fields, body, site),
      markdown: text,
      // The page it is a copy of, and nothing else. This is what makes `sources` on a source file
      // exactly the provenance a reader expects, and what lets the subject files above it be
      // traced back to a URL somebody can open.
      sources: [{ kind: LIBRARY_SOURCE_KINDS.page, ref: page.url }],
      tags: [],
      removed: false,
      page: entry.facts,
      actor,
    });
  } catch (error) {
    if (error?.code !== LIBRARY_ERROR_CODES.nodeLocked) throw error;
    // A person locked this file, or a folder above it, so nothing writes here: the copy stays as
    // it was when they locked it. Recorded at the page's hash rather than as a failure, because a
    // failure is retried every few minutes and this is a decision. The copy catches up the next
    // time the page changes after the lock is lifted. A copy that was being moved stays where it
    // was, which is where the row says it is.
    await state.updateOne(
      { workspaceId, sourceKey: page.urlHash },
      {
        $set: {
          ...settled,
          path: entry.relocateFrom ?? filePath,
          // Settled at these facts as well as this hash, so a locked copy is not tried again on
          // every pass because its header would have changed.
          facts: factsKey(entry.facts),
          held: LIBRARY_ERROR_CODES.nodeLocked,
          heldAt: at,
          mirroredAt: entry.row?.mirroredAt ?? at,
        },
        $unset: { error: "", skipped: "", reason: "", skippedAt: "" },
        $setOnInsert: { workspaceId, sourceKey: page.urlHash, createdAt: at },
      },
      { upsert: true },
    );
    return "held";
  }

  await state.updateOne(
    { workspaceId, sourceKey: page.urlHash },
    {
      $set: {
        ...settled,
        title: titleOf(page, site),
        words: written.words,
        facts: factsKey(entry.facts),
        mirroredAt: at,
        // A page the knowledge base is written from has new words, which is what the write run
        // is started by. A page it is not written from can change every day and start nothing,
        // and neither can a copy made only because its header changed or it moved.
        ...(entry.chosen && entry.moved ? { movedAt: at } : {}),
      },
      $unset: { error: "", skipped: "", reason: "", skippedAt: "", held: "", heldAt: "" },
      $setOnInsert: { workspaceId, sourceKey: page.urlHash, createdAt: at },
    },
    { upsert: true },
  );
  // The copy is at its new path and the row says so, so the old one stands for nothing. Should
  // this fail, the next pass's sweep finds it unclaimed and removes it.
  if (entry.relocateFrom) await library.remove({ scope, path: entry.relocateFrom, actor }).catch(() => {});
  return "mirrored";
}

/**
 * Assembles the stored file: a header this job knows, then the page's own Markdown, untouched.
 *
 * The header replaces the crawler's front matter rather than adding to it. Every field in it is
 * something this process knows exactly, it gives a reader the one thing a copy has to carry — the
 * address of the original — and its first line is what an agent citing the page copies from.
 *
 * A page longer than a source file may be is cut between blocks and says so. The whole page is
 * still what the retrieval index searches and what `content.readPages` opens.
 */
function composeSourceFile({ page, known, body, hash, limit, removed = false, lastSeen = null }) {
  const crawled = page.renderedAt ?? page.updatedAt ?? null;
  const facts = [
    `- Source: ${page.url}`,
    known.kind && known.kind !== "website" ? `- Kind: ${known.kind}` : null,
    known.publishedAt ? `- Published: ${isoDay(known.publishedAt)}` : null,
    known.modifiedAt ? `- Page last changed: ${isoDay(known.modifiedAt)}` : null,
    `- Copied from the page as crawled on ${isoDay(crawled)} (content hash \`${(hash ?? "unknown").slice(0, 12)}\`)`,
    removed ? `- **No longer on the site** (last seen ${isoDay(lastSeen ?? crawled)})` : null,
  ].filter(Boolean).join("\n");

  const text = String(body ?? "").trim();
  const room = limit - facts.length - 2;
  if (text.length <= room) return `${facts}\n\n${text}`.trim();

  const notice = `> The page continues at ${page.url}. This copy stops here because the page is longer than a source file may be.`;
  const cut = text.slice(0, Math.max(0, room - notice.length - 2));
  const boundary = cut.lastIndexOf("\n\n");
  return `${facts}\n\n${(boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd()}\n\n${notice}`;
}

/**
 * Marks a source file whose page has left the crawl, without moving or deleting it.
 *
 * Rewritten rather than only flagged, because the flag is a property of the row and the file is a
 * document somebody reads: a passage of it retrieved by a search has to carry the fact that the
 * page is gone, or the answer quotes a page that no longer exists as though it did.
 */
async function markRemoved({ library, nodes, scope, actor, row, at }) {
  const node = await nodes.findOne(
    { workspaceId: scope.workspaceId, path: row.path, kind: LIBRARY_NODE_KINDS.file },
    { projection: { markdown: 1, title: 1, summary: 1, sources: 1, tags: 1, locked: 1 } },
  );
  if (!node) return false;
  if (node.locked === true) return false;

  const body = String(node.markdown ?? "");
  const marker = `- **No longer on the site** (last seen ${isoDay(row.mirroredAt ?? row.notedAt ?? at)})`;
  if (body.includes("**No longer on the site**")) return false;

  try {
    await library.writeFile({
      scope,
      path: row.path,
      title: node.title,
      summary: node.summary,
      // Prepended, so it is the first thing a reader and a retrieved passage both see.
      markdown: `${marker}\n${body}`,
      // The page is gone, so there is nothing left for the file to cite. What it is a copy of
      // stays in its first lines.
      sources: [],
      tags: node.tags ?? [],
      removed: true,
      actor,
    });
    return true;
  } catch {
    // A locked branch, or a page a person has written in and the write cannot satisfy. The row is
    // still marked, so this is not attempted again every minute; the file simply keeps its words.
    return false;
  }
}

/**
 * Records that a page is not stored, and removes the file it used to have.
 *
 * The removal matters more than it looks. A page that became a duplicate, or started carrying
 * `noindex`, has to stop being in the Library — otherwise "what is in here and why" has two
 * answers, and the ledger's is the one nobody is reading.
 */
async function recordSkip({ database, state, scope, workspaceId, page, row, verdict, library, nodes, actor, now, stamped }) {
  // Already recorded, stamped as this job's own, with no file left behind to clear up. Re-writing
  // the same verdict every pass would move `reviewedAt` on the page for the rest of its life.
  if (row?.skipped === verdict.reason && !row.path && row.chosen === false && stamped) return;

  if (row?.path) {
    const node = await nodes.findOne(
      { workspaceId, path: row.path, kind: LIBRARY_NODE_KINDS.file },
      { projection: { hasUserContent: 1, locked: 1 } },
    );
    // A file somebody has written inside is theirs now; the store refuses to delete it and it
    // should. The row records the skip either way, so the ledger and the tree still agree on why.
    if (node && !node.hasUserContent && node.locked !== true) {
      await library.remove({ scope, path: row.path, actor }).catch(() => {});
    }
  }

  await reviewSources({
    database,
    scope: { workspaceId, siteId: scope.siteId, agentSlug: KNOWLEDGE_AGENT_SLUG, runId: null },
    sources: [{
      kind: LIBRARY_SOURCE_KINDS.page,
      key: page.urlHash,
      url: page.url,
      title: page.title ?? page.heading ?? null,
      hash: page.hash ?? null,
    }],
    relevant: false,
    reason: verdict.message ?? "Not stored.",
    by: SOURCE_LAYER_WRITER_SLUG,
  });

  await state.updateOne(
    { workspaceId, sourceKey: page.urlHash },
    {
      $set: {
        siteId: scope.siteId,
        sourceKind: LIBRARY_SOURCE_KINDS.page,
        url: page.url,
        skipped: verdict.reason,
        reason: verdict.message ?? null,
        skippedAt: now(),
        removed: false,
        chosen: false,
      },
      // A request for a page that cannot be stored is withdrawn rather than left outstanding: it
      // would otherwise queue a pass every minute for good, each one refusing it again.
      $unset: {
        path: "", hash: "", error: "", mirroredAt: "", notedAt: "", chosenReason: "", listedBy: "",
        lists: "", held: "", heldAt: "", include: "", includedAt: "",
      },
      $setOnInsert: { workspaceId, sourceKey: page.urlHash, createdAt: now() },
    },
    { upsert: true },
  );
}

/** Creates the folders a batch of files needs, outermost first, and only the missing ones. */
async function ensureFolders({ library, nodes, scope, actor, workspaceId, paths }) {
  const needed = new Map();
  for (const path of paths) {
    for (const folder of sourcePageFolders(path)) needed.set(folder.path, folder);
  }
  if (!needed.size) return;

  const existing = await nodes
    .find({ workspaceId, path: { $in: [...needed.keys()] } })
    .project({ path: 1 })
    .toArray();
  const have = new Set(existing.map((row) => row.path));

  // Sorted by depth so a parent is always created before the child that needs it.
  const missing = [...needed.values()]
    .filter((folder) => !have.has(folder.path))
    .sort((left, right) => left.path.length - right.path.length);

  for (const folder of missing) {
    await library.mkdir({
      scope,
      path: folder.path,
      title: folderTitle(folder.path),
      summary: folderSummary(folder.path, null),
      actor,
    });
  }
}

/**
 * Rewrites each source folder's summary to say how many pages are under it.
 *
 * Done once at the end of a completed pass rather than per file, because it is the one thing in
 * the mirror that depends on the whole of it. A folder whose summary says "12 pages" is the
 * difference between a tree a reader can skim and one they have to open every branch of.
 */
async function refreshFolderSummaries({ library, nodes, scope, actor, workspaceId }) {
  const folders = await nodes
    .find({
      workspaceId,
      kind: LIBRARY_NODE_KINDS.folder,
      path: { $regex: `^${SOURCE_ROOT_PATH}(/|$)` },
    })
    .project({ path: 1, summary: 1, title: 1, authors: 1, locked: 1 })
    .toArray();
  if (!folders.length) return;

  // Every page beneath a folder, however deep: `/services` with five folders of service pages
  // under it holds thirty-nine pages, and "0 pages" is what counting only its own would say.
  const counts = await nodes
    .aggregate([
      { $match: { workspaceId, kind: LIBRARY_NODE_KINDS.file, path: { $regex: `^${SOURCE_WEBSITE_PATH}/` } } },
      { $group: { _id: "$parentPath", files: { $sum: 1 } } },
    ])
    .toArray();
  const beneath = new Map();
  for (const row of counts) {
    for (const folder of sourcePageFolders(`${row._id}/-`)) {
      beneath.set(folder.path, (beneath.get(folder.path) ?? 0) + row.files);
    }
  }

  // A folder of the layer's own with no page beneath it any more — its pages were duplicates that
  // were cleared away, or moved — goes too, deepest first so that a chain of them empties.
  const emptied = new Set();
  const empty = folders
    .filter((folder) => (beneath.get(folder.path) ?? 0) === 0
      && folder.path.startsWith(`${SOURCE_WEBSITE_PATH}/`)
      && folder.authors?.agent === SOURCE_LAYER_WRITER_SLUG
      && folder.authors?.user !== true
      && folder.locked !== true)
    .sort((left, right) => right.path.length - left.path.length);
  for (const folder of empty) {
    try {
      await library.remove({ scope, path: folder.path, actor });
      emptied.add(folder.path);
    } catch {
      // Something a person made is still in it, or a lock is above it. It stays.
    }
  }

  for (const folder of folders) {
    if (emptied.has(folder.path)) continue;
    // A folder somebody made or locked is theirs; the mirror files into it and leaves its words.
    if (folder.locked === true || folder.authors?.user === true) continue;
    const summary = folderSummary(folder.path, beneath.get(folder.path) ?? 0);
    if (folder.summary === summary) continue;
    await library.mkdir({ scope, path: folder.path, title: folder.title ?? folderTitle(folder.path), summary, actor })
      .catch(() => {});
  }
}

/**
 * What a mirrored folder is called: the URL segment, in words.
 *
 * Short segments are upper-cased whole rather than title-cased, because a URL uses them as
 * initialisms and nothing else: `/services/ai` and `/services/cms` are AI and CMS, and rendering
 * them "Ai" and "Cms" makes the tree look like it was generated by something that had not read it.
 * Three characters is the line — long enough for the initialisms a site actually uses, short
 * enough that no ordinary word is caught by it.
 */
function folderTitle(path) {
  if (path === SOURCE_WEBSITE_PATH) return "Website";
  if (path === SOURCE_ROOT_PATH) return "Sources";
  return wordsOf(librarySegmentOf(path));
}

/** A slug as a few capitalised words. */
function wordsOf(slug) {
  return String(slug ?? "")
    .split("-")
    .filter(Boolean)
    .map((word) => (word.length <= 3 ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

/** The last path segment of a URL, as a slug. */
function lastSegment(url) {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "";
  } catch {
    return "";
  }
}

/** One line saying what is in a mirrored folder, for a reader skimming the tree. */
function folderSummary(path, files) {
  if (path === SOURCE_ROOT_PATH) {
    return "A copy of every source, by where it came from. Kept in step by code; agents read it and link to it.";
  }
  if (path === SOURCE_WEBSITE_PATH) {
    return "Every page of the crawled website as it was last read, at a path that mirrors its URL.";
  }
  const where = `\`${path.slice(SOURCE_WEBSITE_PATH.length)}/\``;
  if (files === null) return `Pages under ${where}.`;
  return files === 1 ? `1 page under ${where}.` : `${files.toLocaleString("en-US")} pages under ${where}.`;
}

/** A date as `YYYY-MM-DD`, which is as precise as any of these facts deserves to be. */
function isoDay(value) {
  const at = value instanceof Date ? value : new Date(value ?? Number.NaN);
  return Number.isNaN(at.getTime()) ? "an unknown date" : at.toISOString().slice(0, 10);
}
