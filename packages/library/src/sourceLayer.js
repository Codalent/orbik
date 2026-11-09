import {
  LIBRARY_LIMITS,
  LIBRARY_PATH_SEPARATOR,
  LIBRARY_ROOT_PATH,
  isWithinLibraryPath,
  libraryDepth,
  slugifySegment,
} from "./library.js";

/**
 * The source layer of the Library: one file per source page, at a path that mirrors where it came
 * from, holding the page as the crawler rendered it.
 *
 * A Library has two layers. The subject tree — an overview, an index, a file per subject — is
 * judgement, written by a model. This layer is not: it is a mirror, and nothing in it is decided.
 * Where a file lives is derived from the page's URL, what it says is the page's own Markdown, and
 * its title and summary are the page's own title and description.
 *
 * It used to hold a *note* per page, a digest written by one model call each. That made the cost
 * of a site follow its page count: a blog of 700 posts and a changelog of 4,000 entries is 4,700
 * model calls before the first sentence of the knowledge base is written, and another for every
 * post that later changes. So the model call went. Storing a page costs nothing now, every page
 * is stored, and model calls are spent only on the pages chosen for the knowledge base — which is
 * `selection.js`'s rule, not a model's.
 *
 * This module holds the conventions every reader of the layer has to agree on: where a source file
 * lives, and which pages are not stored at all.
 *
 * **The path is dictated, never chosen.** `https://example.com/services/ai/chatbots` becomes
 * `/sources/website/services/ai/chatbots`. Because it is derived from the URL rather than decided
 * by a model, it is the same on every run, costs nothing to compute, and needs no record of what
 * was decided last time.
 *
 * **The origin is in the path** because other sources are expected: a Notion connector would fill
 * `/sources/notion/…` beside this without either layer learning about the other. The alternative —
 * `/website` and `/notion` at the root — saves one level against the depth limit and mixes source
 * folders in with the subject folders a reader is meant to start from.
 */

/** The folder every source layer sits under. Reserved: agents other than its writer stay out. */
export const SOURCE_ROOT_PATH = "/sources";

/** The crawl's own branch of it. One site per workspace today, so no host segment. */
export const SOURCE_WEBSITE_PATH = "/sources/website";

/** The reserved, code-managed folders of the source layer. */
const SOURCE_RESERVED_FOLDERS = Object.freeze([SOURCE_ROOT_PATH, SOURCE_WEBSITE_PATH]);

/**
 * Who the source layer belongs to, as a Library author.
 *
 * Not an agent definition: the mirror is a background job with no instructions and no schedule,
 * for the same reason the indexer is not one. It needs a name here because the Library records who
 * wrote every file, and because the store uses it to keep every *other* agent out of `/sources`: a
 * copy of the site is only worth citing if the agent citing it cannot quietly rewrite the page.
 *
 * The value says "notes" because it is stored: on every file the layer has ever written, and on
 * the ledger rows written on the knowledge agent's behalf. It dates from when the layer held a
 * note per page, and renaming it would strand those rows for nothing a reader would notice.
 */
export const SOURCE_LAYER_WRITER_SLUG = "source-notes";

/**
 * Who chose a page for the knowledge base, or left it out, on the ledger.
 *
 * A second name beside the writer's, because the two rows mean different things. A row stamped
 * with the writer's slug says where a page is stored; a row stamped with this says code decided
 * whether the knowledge base is written from it. Neither is anybody's opinion, which is what lets
 * the next pass reconsider both.
 */
export const SOURCE_SELECTION_SLUG = "source-selection";

/**
 * The segment a page is stored under when its own path is also a folder.
 *
 * A URL can be a document and a directory at once. `https://example.com/blog` is a real page — the
 * blog's index — and `/blog/a-post` puts a folder at the same path in the mirror, so the file
 * cannot simply be `/sources/website/blog`: a Library path is a folder or a file and never both.
 * Every static site generator answers this the same way, with an index file inside the directory,
 * and so does this.
 *
 * The site's root takes it too, for the same reason: `/sources/website` is the folder every file
 * hangs off, so the home page is `/sources/website/home`. That the two cases share an answer is
 * not a coincidence — the root is simply the first URL that is also a directory.
 *
 * A site that publishes a real `/home` page beside its root gets the collision resolved by
 * {@link sourcePagePath}, which is why this is a default rather than a rule.
 */
const SOURCE_HOME_SEGMENT = "home";

/**
 * Why a page is not in the source layer at all, as a fixed set of reasons.
 *
 * Three, and all of them are about what the page *is* rather than about what it is worth.
 * Everything that used to be set aside to save a model call — a short page, a legal page, an old
 * post — is stored now, because storing it costs nothing; whether the knowledge base is written
 * from it is a separate question with its own reasons, in `selection.js`.
 */
const SOURCE_SKIP_REASONS = Object.freeze({
  /** A trailing-slash or otherwise duplicate URL of a page that is stored. */
  duplicate: "duplicate",
  /** The page itself says not to index it, so the site does not want it read at all. */
  noindex: "noindex",
  /** The crawler rendered no text from it at all, so there is nothing to store. */
  empty: "empty",
});

/**
 * The reasons nobody can override: a person asking for the page changes nothing about it.
 *
 * A duplicate is still the same words under another URL, and a page with no text still has none.
 * The ledger does not offer to include these, because an offer that cannot be honoured is worse
 * than none.
 */
export const SOURCE_FIXED_SKIPS = Object.freeze([SOURCE_SKIP_REASONS.duplicate, SOURCE_SKIP_REASONS.empty]);

/** One sentence per reason, written for the person reading the ledger. */
const SOURCE_SKIP_MESSAGES = Object.freeze({
  [SOURCE_SKIP_REASONS.duplicate]: "Not stored: the same page under another URL. The copy is of the original.",
  [SOURCE_SKIP_REASONS.noindex]: "Not stored: the page tells search engines not to index it.",
  [SOURCE_SKIP_REASONS.empty]: "Not stored: the page has no text.",
});

/** Whether a path sits inside the source layer at all. */
export function isSourceLayerPath(path) {
  return isWithinLibraryPath(path, SOURCE_ROOT_PATH);
}

/** Whether a path is one of the source layer's own reserved folders. */
export function isReservedSourceFolder(path) {
  return SOURCE_RESERVED_FOLDERS.includes(path);
}

/**
 * Where the source file for one page belongs.
 *
 * The URL's path decides it, segment by segment, slugified the way every other Library path is.
 * Three things have to be handled and none of them is a judgement call:
 *
 * - **The site root** has no segments, so it takes {@link SOURCE_HOME_SEGMENT}.
 * - **A path deeper than the Library allows** is folded: the segments that fit are kept and the
 *   rest are joined into the last one, so `/a/b/c/d/e` becomes `…/a/b/c/d-e` rather than being
 *   refused. A refused file would be a page with no home, which is the one outcome this whole
 *   layer exists to prevent.
 * - **A segment that slugifies to nothing** — a path of punctuation, a non-Latin slug — falls back
 *   to a short digest of the original, so it is stable across runs and still addressable.
 *
 * Collisions are possible and are not resolved here: two URLs that differ only in case, or a site
 * with both `/home` and `/`, would land on one path. The caller knows which files already exist
 * and passes `taken`, which is also what keeps the answer stable — the page that got there first
 * keeps the plain path.
 *
 * @param {string} url the page URL
 * @param {object} [options]
 * @param {Set<string>|null} [options.taken] paths already used by another page's file
 * @param {Set<string>|null} [options.folders] paths that other pages' files sit inside, so a URL
 *   that is also a directory is stored at `<path>/home` rather than colliding with its own folder.
 *   Build it with {@link sourcePageFolders} over every page's unadjusted path.
 * @param {string} [options.root] the branch to mirror into; `/sources/website` by default
 * @returns {string|null} the file's path, or null when the URL cannot be parsed
 */
export function sourcePagePath(url, { taken = null, folders = null, root = SOURCE_WEBSITE_PATH } = {}) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }

  const raw = pathname.split(LIBRARY_PATH_SEPARATOR).filter(Boolean);
  const segments = raw.map((segment, index) => slugifySegment(segment) || digestSegment(segment, index));
  if (!segments.length) segments.push(SOURCE_HOME_SEGMENT);

  // What the mirror may spend: the depth ceiling, less the branch it hangs off.
  const allowance = Math.max(1, LIBRARY_LIMITS.depth - libraryDepth(root));
  const folded = segments.length <= allowance
    ? segments
    : [
      ...segments.slice(0, allowance - 1),
      slugifySegment(segments.slice(allowance - 1).join("-")) || digestSegment(pathname, allowance),
    ];

  let candidate = `${root}${LIBRARY_PATH_SEPARATOR}${folded.join(LIBRARY_PATH_SEPARATOR)}`;
  // The URL is also a directory — `/blog` with `/blog/a-post` under it — so the file goes inside
  // it rather than where the folder has to be. Done before the collision check below, because the
  // adjusted path is the one that can collide.
  if (folders?.has(candidate)) {
    candidate = `${candidate}${LIBRARY_PATH_SEPARATOR}${SOURCE_HOME_SEGMENT}`;
    folded.push(SOURCE_HOME_SEGMENT);
  }
  if (!taken || !taken.has(candidate)) return candidate;

  // A suffix derived from the URL rather than a counter, so the same collision resolves the same
  // way whichever order the pages happen to be stored in. The segment is shortened to make room
  // for it: a slug already at the length limit used to lose the suffix to the limit, so the
  // "distinct" path was the taken one, and two pages were copied over each other at it.
  const suffix = digestSegment(url, 0);
  const last = folded.at(-1).slice(0, Math.max(1, LIBRARY_LIMITS.segment - suffix.length - 1)).replace(/-+$/, "");
  const distinct = [...folded.slice(0, -1), slugifySegment(`${last}-${suffix}`)];
  return `${root}${LIBRARY_PATH_SEPARATOR}${distinct.join(LIBRARY_PATH_SEPARATOR)}`;
}

/**
 * The folders a source file's path needs, outermost first.
 *
 * Generated rather than asked of a model for the same reason the path is: a folder named after a
 * URL segment is not a decision, and two thousand of them are not two thousand decisions.
 *
 * @param {string} filePath a path from {@link sourcePagePath}
 * @returns {Array<{path: string, name: string}>} the ancestor folders below the root
 */
export function sourcePageFolders(filePath) {
  const segments = filePath.split(LIBRARY_PATH_SEPARATOR).filter(Boolean);
  const folders = [];
  // The last segment is the file itself; everything before it is a folder.
  for (let index = 1; index < segments.length; index += 1) {
    const path = LIBRARY_PATH_SEPARATOR + segments.slice(0, index).join(LIBRARY_PATH_SEPARATOR);
    if (path === LIBRARY_ROOT_PATH) continue;
    folders.push({ path, name: segments[index - 1] });
  }
  return folders;
}

/**
 * Decides whether one page is stored in the source layer, by rule.
 *
 * Default is **store**, and what is left is three rules. A duplicate is not a page: storing it
 * would put the same words in the Library twice under two paths, which is the one thing "one home
 * per fact" forbids outright, and nothing overrides it. A page with no text has nothing to store.
 * A page carrying `noindex` is the site saying do not read this, and it is left out unless a
 * person asks for it by name.
 *
 * `noindex` is asked of the *reason*, never of the crawler's `indexable` boolean. On a real site
 * that boolean is dominated by `CANONICAL_TO_OTHER` — a page whose canonical tag names its own
 * trailing-slash twin — and on the first site this was measured against, trusting it would have
 * skipped all thirty-nine service pages, which are the entire business.
 *
 * @param {object} page what is known about the page
 * @param {boolean} [page.variant] a trailing-slash or duplicate twin of another URL
 * @param {boolean} [page.noindex] the page asks not to be indexed, or robots.txt disallows it
 * @param {number} [page.words] how many words the crawler rendered from it
 * @param {boolean} [page.included] a person asked for this page by name
 * @returns {{store: boolean, reason: string|null, message: string|null}}
 */
export function sourceMirrorVerdict(page) {
  if (page.variant) return skip(SOURCE_SKIP_REASONS.duplicate);
  if ((page.words ?? 0) === 0) return skip(SOURCE_SKIP_REASONS.empty);
  if (page.noindex === true && page.included !== true) return skip(SOURCE_SKIP_REASONS.noindex);
  return { store: true, reason: null, message: null };
}

/** A skip verdict with the message a person reads beside it. */
function skip(reason) {
  return { store: false, reason, message: SOURCE_SKIP_MESSAGES[reason] ?? null };
}

/**
 * A short, stable segment for a piece of text that has no usable slug.
 *
 * Not a hash of cryptographic interest — it only has to be deterministic, lowercase-alphanumeric
 * and short enough to leave room beside the segment it is appended to.
 */
function digestSegment(value, salt) {
  let hash = 0x811c9dc5;
  const text = `${salt}:${value}`;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `p${hash.toString(36)}`;
}
