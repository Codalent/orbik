import { formatDate, personFromEmail } from "@/lib/format";

/**
 * What the Library page knows without a server.
 *
 * The path rules and the reserved paths are duplicated from `@orbik/library` rather than imported,
 * because the web app is a separate build that does not depend on the workspace packages. They are
 * part of the URL and part of what a person may type into a "new folder" box, so a change to
 * either is already a coordinated one — the same arrangement the knowledge slugs have always had.
 */

/** The agent that builds and maintains the Library; also its route segment. */
export const LIBRARY_AGENT_SLUG = "business-knowledge-base";

/**
 * What the two files every Library has, and the folder they sit in, are to every reader.
 *
 * The overview and the index used to be `/overview` and `/index`. They are roles now, carried by
 * the node: they live in the Library's first top-level folder (`00 Start Here` by default), which
 * a person may rename, and the role travels with them. The API says where they are as
 * `overviewPath` and `indexPath`; nothing here assumes a path. Mirrors `LIBRARY_ROLES` in
 * `@orbik/library`.
 */
export const LIBRARY_ROLES = Object.freeze({ overview: "overview", index: "index", start: "start" });

/** Where a Library from before roles keeps its overview, until it is rebuilt. Only a fallback. */
export const LEGACY_OVERVIEW_PATH = "/overview";

/**
 * The top-level folders code writes rather than a person chooses. Fixed in path and title, shown
 * after the chosen folders, and never renamed, moved, reordered or deleted from here.
 */
export const FIXED_TOP_LEVEL_PATHS = Object.freeze(["/brand", "/sources"]);

/** Whether a node is one of the code-written top-level folders. */
export function isFixedFolder(path) {
  return FIXED_TOP_LEVEL_PATHS.includes(path);
}

/**
 * Which entry point a node is, if any: `overview`, `index`, or null.
 *
 * By the role on the node first, then by the paths the API named — which is how a Library from
 * before roles, whose overview has no role yet, still gets its front page treated as one.
 *
 * @param {object|null} node
 * @param {{overviewPath?: string|null, indexPath?: string|null}} [roles]
 */
export function entryRoleOf(node, roles = {}) {
  if (!node) return null;
  if (node.role === LIBRARY_ROLES.overview || node.role === LIBRARY_ROLES.index) return node.role;
  if (roles.overviewPath && node.path === roles.overviewPath) return LIBRARY_ROLES.overview;
  if (roles.indexPath && node.path === roles.indexPath) return LIBRARY_ROLES.index;
  return null;
}

/**
 * Every node a tree the page holds lists, by path: folders, files, and the source pages a folder
 * shows by reference.
 *
 * What the page knows about a file it has not opened — its title for a tab or a link, its role for
 * an icon, its address for a copy of a page — is what the tree said about it, so one walk answers
 * all of those questions for as long as that tree is the one on screen.
 *
 * @param {object|null} tree the tree from GET /library, with any branches fetched since
 * @returns {Map<string, object>}
 */
export function indexTree(tree) {
  const index = new Map();
  const walk = (node) => {
    for (const child of node?.children ?? []) {
      index.set(child.path, child);
      walk(child);
    }
    for (const page of node?.sourcePages?.pages ?? []) {
      if (!index.has(page.path)) index.set(page.path, page);
    }
  };
  walk(tree);
  return index;
}

/** Whether a path is a copy of a page of the site, or a folder of them: the layer only code writes. */
export function isSourcePath(path) {
  return String(path ?? "").startsWith("/sources/") || path === "/sources";
}

/**
 * A URL as the Library shows it: the site and the path, without the scheme.
 *
 * `example.com/#capabilities` says which page, and which site, in the width a tab or a rail has;
 * the scheme and a trailing slash say nothing a reader needs.
 */
export function hostAndPath(url) {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`.replace(/\/$/, "");
    return `${parsed.host.replace(/^www\./, "")}${path}`;
  } catch {
    return url ?? "";
  }
}

/** Finds a node anywhere in a tree the page holds, or null. */
export function findInTree(tree, path) {
  const walk = (children) => {
    for (const node of children ?? []) {
      if (node.path === path) return node;
      if (path.startsWith(`${node.path}/`)) return walk(node.children);
    }
    return null;
  };
  return path === "/" ? tree : walk(tree?.children);
}

/** Mirrors the bounds in `@orbik/library`, so a form can say no before the API has to. */
export const LIBRARY_LIMITS = Object.freeze({
  depth: 6,
  segment: 64,
  title: 120,
  summary: 400,
  markdown: 60_000,
  sourceMarkdown: 200_000,
  tags: 12,
});

/**
 * How long a file at this path may be.
 *
 * A file under `/sources` is a copy of a page and may be as long as one; everything else is
 * writing somebody decided the length of.
 */
export function markdownLimitFor(path) {
  return String(path ?? "").startsWith("/sources/") ? LIBRARY_LIMITS.sourceMarkdown : LIBRARY_LIMITS.markdown;
}

/**
 * Turns what a person typed into a path segment.
 *
 * "Case Studies" becomes `case-studies`. The display name is kept separately, so what somebody
 * writes in the "new folder" box is what they see in the tree; this is only the address.
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

/** The parent of a path; the root's parent is the root. */
export function parentPathOf(path) {
  const segments = String(path ?? "").split("/").filter(Boolean);
  if (segments.length <= 1) return "/";
  return `/${segments.slice(0, -1).join("/")}`;
}

/** Joins a parent path and a segment into a child path. */
export function joinPath(parentPath, segment) {
  return parentPath === "/" ? `/${segment}` : `${parentPath}/${segment}`;
}

/** How many levels deep a path sits: `/services` is 1, `/services/ai` is 2, the root is 0. */
export function depthOf(path) {
  return String(path ?? "").split("/").filter(Boolean).length;
}

/** A day and month, and the year only when it is not this one: "Sep 22", "Dec 3, 2025". */
export function formatShortDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  const thisYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, thisYear ? { month: "short", day: "numeric" } : { dateStyle: "medium" });
}

/**
 * How long ago something happened, in words, for the last hour; the date after that.
 *
 * "A minute ago" is what a person watching a run wants to read about a file it just rewrote. By
 * the next day the exact time is the useful thing again, so the relative form stops at an hour.
 */
export function formatRelative(iso, now = Date.now()) {
  if (!iso) return "";
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-minutes, "minute");
  return formatDate(iso);
}

/**
 * Who made a person's change, when it was not made here: "you, via Claude".
 *
 * A person's own AI may write to the Library over MCP with a credential they allowed to write. The
 * change is theirs — it is protected from the agents like any edit of theirs — and the server says
 * which client made it, by the name the token or the approved app carries, so the history can say
 * so. Null for a change made on this page, and for an agent's.
 *
 * In a workspace several people write in, the change may be somebody else's: the server names
 * the account (`userId`, `email`), and anyone but the signed-in person is called by name — "Priya",
 * "Priya, via Claude". Without a name, or without knowing who is reading, it is "you" as before.
 *
 * @param {{kind?: string, userId?: string, email?: string|null, via?: {client?: string|null}}|null|undefined} updatedBy
 * @param {string} you how "you" is written where this goes: "you" mid-sentence, "You" to start one
 * @param {string|null} [viewerId] the signed-in person's account
 */
export function personLabel(updatedBy, you = "you", viewerId = null) {
  const client = updatedBy?.kind === "user" ? updatedBy.via?.client : null;
  const someoneElse = updatedBy?.kind === "user" && updatedBy.userId && viewerId && updatedBy.userId !== viewerId;
  const who = someoneElse ? personFromEmail(updatedBy.email)?.name ?? "someone" : you;
  return client ? `${who}, via ${client}` : who;
}

/**
 * Whose a file's kept passages are, as far as the signed-in person is concerned.
 *
 * `total` is every passage a person wrote; `mine` those the viewer did. `allMine` is true when
 * they all are — or when the server does not say who wrote them, which is a file written before
 * workspaces had members — and is what lets the page keep saying "your passages".
 *
 * @param {{protectedBlocks?: number, userBlockAuthors?: Array<{userId: string}|null>}} node
 * @param {string|null} viewerId
 * @returns {{total: number, mine: number, allMine: boolean}}
 */
export function passagesOf(node, viewerId) {
  const total = typeof node?.protectedBlocks === "number" ? node.protectedBlocks : node?.userBlocks?.length ?? 0;
  const authors = node?.userBlockAuthors;
  if (!Array.isArray(authors) || !viewerId) return { total, mine: total, allMine: true };
  const mine = authors.filter((author) => author?.userId === viewerId).length;
  return { total, mine, allMine: mine === authors.length };
}

/**
 * "N of your passages kept", or — when some are other people's — how many are kept and how many
 * of them are the viewer's.
 */
export function keptPassagesLabel(node, viewerId) {
  const { total, mine, allMine } = passagesOf(node, viewerId);
  if (allMine) return `${total} of your passages kept`;
  if (mine > 0) return `${total} passages kept, ${mine} yours`;
  return `${total} ${total === 1 ? "passage" : "passages"} by others kept`;
}

/**
 * Where a workspace is between its site being copied and its Library being written, as a sentence
 * or two.
 *
 * Shared by the two places that have to say it — a Library with no files at all, and one with no
 * overview — so they cannot give different accounts of the same wait. It names the switch when the
 * switch is what is being waited on: copying the pages happens whether or not the agent is set to
 * work, and writing the Library from them does not.
 */
export function writingStatus({ coverage, working, inFlight }) {
  const outstanding = (coverage?.pending ?? 0) + (coverage?.failed ?? 0);
  const stored = coverage?.stored ?? 0;
  const first = stored > 0
    ? `${stored.toLocaleString()} ${stored === 1 ? "page" : "pages"} of your site ${stored === 1 ? "has" : "have"} been copied into Sources.`
    : "Every page of your site is copied into Sources.";
  const second = inFlight
    ? "The agent is writing the overview and the folders around it now."
    : outstanding > 0
      ? `${outstanding.toLocaleString()} more ${outstanding === 1 ? "is" : "are"} still to be copied, and the agent writes the overview and the folders around it from the pages your site links to most${working ? " when that is done" : " once it is set to work"}.`
      : working
        ? "The agent writes the overview and the folders around it from the pages your site links to most, starting within a few minutes."
        : "The agent has not been set to work, so nothing has been written from those pages yet. Set it to work and it writes the overview and the folders around it.";
  return `${first} ${second}`;
}

/**
 * Who wrote a node, as one short label.
 *
 * Both writers are recorded, and "both" is the interesting case rather than an edge one: it is
 * the normal state of a file an agent built and a person corrected, and seeing it is what tells a
 * reader that the corrections are being kept.
 */
export function authorLabel(node) {
  const byAgent = Boolean(node?.authors?.agent);
  const byUser = node?.authors?.user === true;
  if (byAgent && byUser) return "Agent + you";
  if (byUser) return "You";
  if (byAgent) return "Agent";
  return null;
}
