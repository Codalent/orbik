/**
 * The Library's vocabulary: what a path is, what a node may hold, and where the bounds are.
 *
 * The Library is a filesystem — folders and files per workspace, like an Obsidian vault — that two
 * kinds of writer share: agents, which build and maintain it from what they read, and people, who
 * correct it and add what no crawler could know. That is the whole reason this module exists in
 * `@orbik/library` rather than beside either writer. A person saving `/clients/deeplearning-ai`
 * through the API and an agent writing the same file through `library.write` have to obey one set
 * of rules about paths, depth, size and reserved names; two copies of those rules would diverge on
 * the first change, and the symptom would be a file one writer could create and the other could
 * not open.
 */

/** Separator between path segments, and the path of the implicit root. */
export const LIBRARY_PATH_SEPARATOR = "/";

/**
 * The root of every workspace's Library.
 *
 * Implicit: there is no document for it, and it is named after the workspace rather than stored.
 * A root that were a row would be a row every query had to special-case, and a name a person
 * could rename out of step with the workspace it belongs to.
 */
export const LIBRARY_ROOT_PATH = "/";

/** What a node is. A folder holds children and a summary; a file holds Markdown. */
export const LIBRARY_NODE_KINDS = Object.freeze({ folder: "folder", file: "file" });

/** Every node kind, as an array. */
export const LIBRARY_NODE_KIND_VALUES = Object.freeze(Object.values(LIBRARY_NODE_KINDS));

/**
 * The two files every Library has, and the folder they sit in, as roles a node carries.
 *
 * Everything else is the agent's judgement per site — a consultancy grows `services` and
 * `clients`, a SaaS grows `product` and `plans` — but a consumer arriving at a Library it has
 * never seen has to be able to start reading without being told the folder names first. The
 * overview and the index are that entry point.
 *
 * They used to be fixed paths, `/overview` and `/index`. They are roles now, because they live
 * inside the Library's first top-level folder (`00 Start Here` by default), and that folder is a
 * person's to rename: a constant path would break the day somebody called it "Start". So the
 * node carries the role, the role follows the node through any rename, and everything that
 * needs the overview asks where it is (`store.roles`) rather than assuming. The tree root names
 * both as `overviewPath` and `indexPath`, which is how an outside reader finds them.
 *
 * `start` is the folder they are written into: the group of the chosen structure that holds the
 * entry points. Until a file has taken the role, the overview's path is `<start>/overview`.
 */
export const LIBRARY_ROLES = Object.freeze({
  /** The front page: the briefing everything starts from. Cannot be deleted; agents never move it. */
  overview: "overview",
  /** The entry map: what to read for which job. Cannot be deleted; may be rewritten freely. */
  index: "index",
  /** The top-level folder the overview and the index are written into. */
  start: "start",
});

/** The roles a file can carry, as opposed to the folder's. */
export const LIBRARY_FILE_ROLES = Object.freeze([LIBRARY_ROLES.overview, LIBRARY_ROLES.index]);

/**
 * Where the overview and the index were before they were roles, and where a Library that has
 * no start folder still keeps them.
 *
 * Only a fallback now. A Library built before the structure step has its overview at
 * `/overview` with no role on it, and nothing migrates it (existing Libraries are rebuilt, not
 * migrated): until it is rebuilt, these are where its entry points are found. Nothing writes to
 * them once a start folder exists.
 */
export const LIBRARY_RESERVED_PATHS = Object.freeze({
  overview: "/overview",
  index: "/index",
});

/**
 * Bounds on a Library, generous for real writing and hostile to a runaway agent.
 *
 * The node ceiling is the one that matters, and it is now two ceilings rather than one, because
 * the Library holds two different kinds of thing.
 *
 * The **subject tree** — the overview, the index, the folders a person chose — is a briefing a person
 * can hold in their head and an agent can list in one call. Five hundred nodes is already an
 * archive, and an agent that would rather file than decide will happily produce five thousand, so
 * that ceiling stays exactly where it was.
 *
 * The **source layer** under `/sources` is not a judgement at all: it is one file per crawled
 * page, at a path derived from the URL, holding the page as the crawler rendered it. Counting it
 * against the same ceiling would have meant a two-thousand-page site could not be mirrored, which
 * is the thing the source layer exists to make possible — so it has a ceiling of its own, two
 * orders of magnitude larger, bounding the storage rather than the agent's discretion.
 */
export const LIBRARY_LIMITS = Object.freeze({
  /** Segments in a path. Six is deeper than any vault a person navigates by hand. */
  depth: 6,
  /** Folders and files one workspace may hold outside the source layer. */
  nodes: 500,
  /**
   * Source files and their folders one workspace may hold under `/sources`.
   *
   * Sized to the crawler rather than to a briefing. A source file costs no model call, so the
   * only bound left is storage: the crawler is built for sites of up to about fifty thousand
   * URLs, and this leaves room for the folders above them. It was five thousand while every file
   * was a model's note, and a site of 4,700 posts could not fit under it.
   */
  sourceNodes: 60_000,
  /** Longest single path segment. */
  segment: 64,
  /** Longest whole path, including separators. */
  path: 400,
  title: 120,
  summary: 400,
  /** A page of prose is a few kilobytes; this is the ceiling, not the target. */
  markdown: 60_000,
  /**
   * The longest file under `/sources`, which is a copy of a page rather than a piece of writing.
   *
   * Higher than a subject file's ceiling because nobody chose its length: a long guide is as long
   * as the site made it. A page beyond this is cut at a block boundary and says so, and the whole
   * of it is still what the retrieval index searches.
   */
  sourceMarkdown: 200_000,
  /** Source references one file may cite. */
  sources: 200,
  /** Free labels on one node. */
  tags: 12,
  tag: 40,
  /** Wiki-style `[[links]]` one file may carry. */
  links: 200,
  /** Versions kept per file. Two writers share these documents, so restore has to exist. */
  revisions: 20,
  /**
   * Versions kept per file under `/sources`.
   *
   * Fewer, because the file is a copy and the crawler keeps the page's own history. A block shown
   * on every page of a site changes every source file at once, and twenty kept versions of each
   * of several thousand pages would be the largest collection in the database for no reader.
   * Three is the current copy, the one before it, and room for a person's own edit between them.
   */
  sourceRevisions: 3,
  /** Children a folder listing returns before it is elided with a count. */
  children: 200,
  /** Top-level groups a chosen structure may have. More than a dozen is a list, not a grouping. */
  groups: 12,
  /** Longest group title: `05 Content`, not a sentence about it. */
  groupTitle: 40,
});

/** Matches one path segment: lowercase words and digits joined by hyphens. */
const LIBRARY_SEGMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Stable failure codes every Library rule raises.
 *
 * They are part of the contract with the model, not diagnostics. An agent that is told
 * `PROTECTED_CONTENT_MISSING` and given the text can restore the paragraph and retry within the
 * same run; an agent told "write failed" can only give up or guess.
 */
export const LIBRARY_ERROR_CODES = Object.freeze({
  invalidPath: "INVALID_PATH",
  parentMissing: "PARENT_MISSING",
  notAFolder: "NOT_A_FOLDER",
  nodeMissing: "NODE_MISSING",
  nodeExists: "NODE_EXISTS",
  kindMismatch: "KIND_MISMATCH",
  nodeLocked: "NODE_LOCKED",
  protectedContentMissing: "PROTECTED_CONTENT_MISSING",
  removedContentReintroduced: "REMOVED_CONTENT_REINTRODUCED",
  unknownSource: "UNKNOWN_SOURCE",
  unresolvedLink: "UNRESOLVED_LINK",
  reservedPath: "RESERVED_PATH",
  libraryFull: "LIBRARY_FULL",
  folderNotEmpty: "FOLDER_NOT_EMPTY",
  userFolderProtected: "USER_FOLDER_PROTECTED",
  revisionMissing: "REVISION_MISSING",
  invalidStructure: "INVALID_STRUCTURE",
  topLevelProtected: "TOP_LEVEL_PROTECTED",
});

/**
 * The ways a person's write can reach the Library other than from the Library page itself.
 *
 * Two: their own AI, over the MCP endpoint, with a credential they allowed to write; and Ask, the
 * chat in Orbik's side panel, carrying out something they asked for in it. A write that names one
 * is recorded as the person's with `updatedBy.via`, and is held to their locks.
 */
export const LIBRARY_WRITE_CHANNELS = Object.freeze({ mcp: "mcp", ask: "ask" });

/**
 * A rule the Library refused, carrying a code both callers can act on.
 *
 * One error type for two very different boundaries: the tools turn it into a `ToolError` a model
 * reads and retries, and the API turns it into an HTTP failure a person reads. Neither can invent
 * its own codes without the other drifting, so the code is decided here, once, beside the rule
 * that raises it.
 */
export class LibraryError extends Error {
  /**
   * @param {object} options failure detail
   * @param {string} options.code one of {@link LIBRARY_ERROR_CODES}
   * @param {string} options.message safe description, written for a model and a person to read
   * @param {object} [options.detail] structured extra the caller may render, e.g. missing blocks
   */
  constructor({ code, message, detail = null }) {
    super(message);
    this.name = "LibraryError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Turns a display name into a path segment.
 *
 * "Case Studies" becomes `case-studies`, and "02 Offer" becomes `02-offer`; the display form is
 * kept on the node as `name`, so a folder reads as a person wrote it and addresses as a machine
 * needs it. A number at the front of a top-level folder's title is a naming convention Orbik
 * suggests and nothing more: it is part of the title and so of the path, and never read as a
 * position. Ordering is the explicit `order` field a person sets.
 *
 * @param {string} value a display name
 * @returns {string} a path segment, empty when nothing usable survives
 */
export function slugifySegment(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, LIBRARY_LIMITS.segment)
    .replace(/-+$/g, "");
}

/**
 * Canonicalizes a path and refuses anything that is not one.
 *
 * Accepts the forms a caller reasonably writes — `services`, `/services/`, `//services` — and
 * returns the one form everything else in the Library compares against. Refusing rather than
 * repairing is reserved for what a caller cannot have meant: a segment that is not a slug, a path
 * deeper than the ceiling, a traversal attempt.
 *
 * @param {unknown} value the path as written
 * @param {{allowRoot?: boolean}} [options] whether `/` is an acceptable answer
 * @returns {string} the canonical path
 * @throws {LibraryError} `INVALID_PATH`
 */
export function normalizeLibraryPath(value, { allowRoot = false } = {}) {
  if (typeof value !== "string") {
    throw new LibraryError({ code: LIBRARY_ERROR_CODES.invalidPath, message: "A path must be a string." });
  }
  const trimmed = value.trim();
  const segments = trimmed.split(LIBRARY_PATH_SEPARATOR).filter(Boolean);
  if (!segments.length) {
    if (allowRoot) return LIBRARY_ROOT_PATH;
    throw new LibraryError({
      code: LIBRARY_ERROR_CODES.invalidPath,
      message: "The root of the Library is not a node; name a folder or a file inside it.",
    });
  }
  if (segments.length > LIBRARY_LIMITS.depth) {
    throw new LibraryError({
      code: LIBRARY_ERROR_CODES.invalidPath,
      message: `A path may be at most ${LIBRARY_LIMITS.depth} levels deep; "${trimmed}" is ${segments.length}.`,
    });
  }
  for (const segment of segments) {
    if (segment.length > LIBRARY_LIMITS.segment || !LIBRARY_SEGMENT_PATTERN.test(segment)) {
      throw new LibraryError({
        code: LIBRARY_ERROR_CODES.invalidPath,
        message:
          `"${segment}" is not a usable path segment. Use lowercase words and digits joined by ` +
          `hyphens, at most ${LIBRARY_LIMITS.segment} characters: services, case-studies, llms-txt.`,
      });
    }
  }
  const path = LIBRARY_PATH_SEPARATOR + segments.join(LIBRARY_PATH_SEPARATOR);
  if (path.length > LIBRARY_LIMITS.path) {
    throw new LibraryError({
      code: LIBRARY_ERROR_CODES.invalidPath,
      message: `A path may be at most ${LIBRARY_LIMITS.path} characters.`,
    });
  }
  return path;
}

/** The segments of a canonical path, root being none. */
function librarySegments(path) {
  return path.split(LIBRARY_PATH_SEPARATOR).filter(Boolean);
}

/** How deep a path sits. The root is 0, `/services` is 1. */
export function libraryDepth(path) {
  return librarySegments(path).length;
}

/** The last segment of a path, which is its addressable name. */
export function librarySegmentOf(path) {
  return librarySegments(path).at(-1) ?? "";
}

/** The path of a node's parent; the root's parent is itself. */
export function libraryParentPath(path) {
  const segments = librarySegments(path);
  if (segments.length <= 1) return LIBRARY_ROOT_PATH;
  return LIBRARY_PATH_SEPARATOR + segments.slice(0, -1).join(LIBRARY_PATH_SEPARATOR);
}

/** Every ancestor path of a node, root first, the node itself excluded. */
export function libraryAncestorPaths(path) {
  const segments = librarySegments(path);
  const ancestors = [LIBRARY_ROOT_PATH];
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(LIBRARY_PATH_SEPARATOR + segments.slice(0, index).join(LIBRARY_PATH_SEPARATOR));
  }
  return ancestors;
}

/** Whether `candidate` is `path` or sits underneath it. */
export function isWithinLibraryPath(candidate, path) {
  if (path === LIBRARY_ROOT_PATH) return true;
  return candidate === path || candidate.startsWith(`${path}${LIBRARY_PATH_SEPARATOR}`);
}

/**
 * How a source stands in relation to the file it was read for.
 *
 * `page` is the crawl — the only provider that exists today. The other kinds are named now
 * because the ledger and the reference shape are keyed on them: a Notion page or a meeting note
 * arriving later must be a new provider module, not a change to every tool that cites a source.
 */
export const LIBRARY_SOURCE_KINDS = Object.freeze({
  /** A page of the workspace's own crawled site, keyed by the crawler's URL hash. */
  page: "page",
  /** A route pattern of that site — a verdict about a shape of page rather than one page. */
  route: "route",
  /** A prose document from somewhere else: a Notion page, a vault note, a meeting note. */
  document: "document",
});

/** Every source kind, as an array. */
export const LIBRARY_SOURCE_KIND_VALUES = Object.freeze(Object.values(LIBRARY_SOURCE_KINDS));

/**
 * The top-level folders written by code rather than chosen by a person, in the order they are
 * shown: after every folder of the chosen structure, whatever it is called or numbered.
 *
 * A rank rather than an `order` value on each, because a node with an `order` sorts *before*
 * every node without one: giving `/sources` an order would put it first, above the numbered
 * folders it is meant to follow. Their paths and titles are fixed, so a rank by path is stable.
 */
const LIBRARY_FIXED_TAIL = Object.freeze(["/brand", "/sources"]);

/** Where a node sits in the fixed tail, or -1 when it is not one of those folders. */
function fixedTailRank(node) {
  return LIBRARY_FIXED_TAIL.indexOf(node?.path ?? "");
}

/**
 * Default sibling order: folders first, then by display name.
 *
 * A person may override it per folder with an explicit `order`, and an agent never sets one —
 * which is what keeps a weekly run from reshuffling a tree somebody has arranged. Nodes without
 * an order sort after those with one, so setting the order of two siblings does not scatter the
 * rest. At the top level the default happens to put `00 Start Here`, `01 Company`, … in numeric
 * order, which is the whole point of numbering them; the code-written folders (`/brand`,
 * `/sources`) come after all of them.
 *
 * @param {object} left a node
 * @param {object} right a node
 */
export function compareLibrarySiblings(left, right) {
  const leftTail = fixedTailRank(left);
  const rightTail = fixedTailRank(right);
  if (leftTail !== -1 || rightTail !== -1) {
    if (leftTail === -1) return -1;
    if (rightTail === -1) return 1;
    return leftTail - rightTail;
  }
  const leftOrder = Number.isInteger(left.order) ? left.order : null;
  const rightOrder = Number.isInteger(right.order) ? right.order : null;
  if (leftOrder !== null || rightOrder !== null) {
    if (leftOrder === null) return 1;
    if (rightOrder === null) return -1;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  }
  if (left.kind !== right.kind) return left.kind === LIBRARY_NODE_KINDS.folder ? -1 : 1;
  return String(left.name ?? "").localeCompare(String(right.name ?? ""), undefined, { numeric: true });
}
