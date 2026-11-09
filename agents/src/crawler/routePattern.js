/**
 * Siblings sharing a parent before their segment is treated as a value rather than a name.
 *
 * Below this, a path segment is almost certainly part of the site's vocabulary — `/docs/api`,
 * `/docs/guides` — and collapsing it would hide the structure a person navigates by. Above it, the
 * segment is a key into a collection, and listing four hundred of them individually is what makes
 * a URL list unreadable in the first place.
 */
const MIN_SIBLINGS_TO_COLLAPSE = 5;

/** Longest path a pattern is derived for, so one absurd URL cannot produce an absurd pattern. */
const MAX_SEGMENTS = 12;

/** Placeholder names, chosen to read the way a router would write them. */
const PLACEHOLDERS = Object.freeze({
  id: "[id]",
  year: "[year]",
  month: "[month]",
  day: "[day]",
  slug: "[slug]",
});

/**
 * Splits a URL's path into the segments a route is built from.
 *
 * A trailing slash produces an empty final segment, which is dropped: `/blog` and `/blog/` are
 * still two different URLs to the registry — that decision belongs to the normalizer — but they
 * are unquestionably the same *route*, and a route tree that showed them as two branches would be
 * wrong in a way no user would forgive.
 *
 * @param {string} pathname a URL pathname, or a full URL
 * @returns {string[]} decoded, non-empty path segments
 */
function pathSegmentsOf(pathname) {
  const path = typeof pathname === "string" ? pathname : "";
  const raw = path.startsWith("http") ? safePathname(path) : path;
  return raw
    .split("/")
    .filter(Boolean)
    .slice(0, MAX_SEGMENTS)
    .map(decodeSegment);
}

/**
 * Derives a route pattern for every path, using the whole corpus to decide what is a value.
 *
 * A single URL cannot tell you whether `2024` is a year, an identifier, or a product line called
 * "2024" — only its siblings can. That is why this takes the site's paths together rather than
 * offering a `patternOf(url)` that would have to guess, and why the result is stable for a given
 * corpus but may legitimately change as a site grows: the tenth blog post is what turns
 * `/blog/hello` from a page into an instance of `/blog/[slug]`.
 *
 * @param {string[]} paths every known pathname for one site
 * @param {object} [options]
 * @param {number} [options.minSiblings] siblings before a segment collapses to a placeholder
 * @returns {Map<string, string>} pathname to its route pattern
 */
export function derivePatterns(paths, options = {}) {
  const minSiblings = options.minSiblings ?? MIN_SIBLINGS_TO_COLLAPSE;
  const root = { children: new Map(), terminal: false };

  const segmented = new Map();
  for (const path of paths) {
    const segments = pathSegmentsOf(path);
    segmented.set(path, segments);
    let node = root;
    for (const segment of segments) {
      let child = node.children.get(segment);
      if (!child) {
        child = { children: new Map(), terminal: false };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.terminal = true;
  }

  // Each trie node decides once whether its children are a vocabulary or a collection, and the
  // answer is cached on the node so every path through it gets the same pattern.
  const patterns = new Map();
  for (const [path, segments] of segmented) {
    const rendered = [];
    let node = root;
    for (const segment of segments) {
      const placeholder = collapsedNameFor(node, minSiblings);
      rendered.push(placeholder ?? segment);
      node = placeholder ? mergedChild(node) : node.children.get(segment);
      if (!node) break;
    }
    patterns.set(path, `/${rendered.join("/")}`);
  }
  return patterns;
}

/**
 * Decides what one node's children collapse to, or null when they stay literal.
 *
 * Memoized on the node because it is asked once per path that passes through, and the answer
 * cannot differ between them without producing two patterns for one route.
 */
function collapsedNameFor(node, minSiblings) {
  if (node.collapsed !== undefined) return node.collapsed;

  const names = [...node.children.keys()];
  // A numeric family collapses immediately: three product IDs are already a collection, and
  // nobody names a section of their site `4821`.
  if (names.length >= 2 && names.every(isNumeric)) {
    node.collapsed = names.every(isYear) ? PLACEHOLDERS.year
      : names.every(isMonthOrDay) ? PLACEHOLDERS.month
        : PLACEHOLDERS.id;
    return node.collapsed;
  }

  node.collapsed = names.length >= minSiblings ? PLACEHOLDERS.slug : null;
  return node.collapsed;
}

/**
 * Merges every child of a collapsed node into one, so the subtree below a placeholder is analysed
 * as a single population.
 *
 * Without this, `/blog/a/comments` and `/blog/b/comments` would be looked at as two separate
 * one-child subtrees and never recognised as the same route.
 */
function mergedChild(node) {
  if (node.merged) return node.merged;
  const merged = { children: new Map(), terminal: false };
  for (const child of node.children.values()) {
    merged.terminal = merged.terminal || child.terminal;
    for (const [name, grandchild] of child.children) {
      const existing = merged.children.get(name);
      if (!existing) {
        merged.children.set(name, grandchild);
        continue;
      }
      // Two subtrees can carry the same segment name; keep both populations under it.
      for (const [key, value] of grandchild.children) existing.children.set(key, value);
      existing.terminal = existing.terminal || grandchild.terminal;
    }
  }
  node.merged = merged;
  return merged;
}

/** Reads a pathname from an absolute URL without throwing on a malformed one. */
function safePathname(value) {
  try {
    return new URL(value).pathname;
  } catch {
    return value;
  }
}

/** Decodes a percent-encoded segment, leaving it alone when the encoding is broken. */
function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Reports whether a segment is entirely digits. */
function isNumeric(segment) {
  return /^\d+$/.test(segment);
}

/** Reports whether a segment reads as a calendar year rather than an arbitrary number. */
function isYear(segment) {
  return /^\d{4}$/.test(segment) && Number(segment) >= 1900 && Number(segment) <= 2199;
}

/** Reports whether a segment reads as a month or day number. */
function isMonthOrDay(segment) {
  return /^\d{1,2}$/.test(segment) && Number(segment) >= 1 && Number(segment) <= 31;
}
