/**
 * Words a page must have before identical text is accepted as proof of duplication.
 *
 * Without this, every page that renders nothing server-side — a JavaScript shell, a soft error, an
 * empty category — hashes to the same near-empty string and the whole site collapses into one
 * group. Redirects and canonical tags are statements the site made on purpose and need no such
 * floor; text equality is an inference, and this is the evidence it requires.
 */
const MIN_WORDS_FOR_TEXT_MATCH = 20;

/** How a URL came to be treated as a variant, kept so a grouping can be explained rather than guessed at. */
const DUPLICATE_REASONS = Object.freeze({
  redirect: "REDIRECTS_TO",
  canonical: "CANONICAL_TO",
  identicalText: "IDENTICAL_TEXT",
});

/**
 * Folds a site's URLs into groups that are really one page, and elects which URL represents each.
 *
 * The crawler already collects three independent proofs that two URLs are the same page and, until
 * now, discarded all of them. In order of how much they can be trusted:
 *
 * 1. **A redirect.** The server was asked and answered. Nothing overrides this.
 * 2. **A canonical tag.** The site's own declaration about itself.
 * 3. **Identical readable text.** An inference, so it needs the word floor above, and it is what
 *    catches the case the other two miss entirely — two URLs both returning 200, both claiming to
 *    be canonical, serving the same page. That is the trailing-slash duplicate nobody declared.
 *
 * This is a pure function over what the crawl already recorded: it makes no queries, so the whole
 * policy can be read and tested in one place rather than inferred from a pipeline.
 *
 * @param {Array<object>} pages one entry per crawled URL, carrying `urlHash`, `url`, `status`,
 *   `finalUrlHash`, `canonicalHash`, `selfCanonical`, `textHash`, `wordCount`, `inbound`, `inSitemap`
 * @returns {Map<string, {groupKey: string, variantOf: string|null, reason: string|null}>}
 */
export function groupDuplicates(pages) {
  const byHash = new Map(pages.map((page) => [page.urlHash, page]));
  const defersTo = new Map();

  // Declared duplicates first: a redirect or a canonical is a statement, not a guess.
  for (const page of pages) {
    const declared = declaredTargetOf(page, byHash);
    if (declared) defersTo.set(page.urlHash, declared);
  }

  // Then inferred ones, which may only join a group, never redirect an existing declaration.
  for (const members of textClustersOf(pages)) {
    const representative = elect(members);
    for (const member of members) {
      if (member.urlHash === representative.urlHash) continue;
      if (defersTo.has(member.urlHash)) continue;
      defersTo.set(member.urlHash, { hash: representative.urlHash, reason: DUPLICATE_REASONS.identicalText });
    }
  }

  const grouped = new Map();
  for (const page of pages) {
    const root = rootOf(page.urlHash, defersTo);
    grouped.set(page.urlHash, {
      groupKey: root,
      variantOf: root === page.urlHash ? null : root,
      reason: root === page.urlHash ? null : defersTo.get(page.urlHash)?.reason ?? null,
    });
  }
  return grouped;
}

/**
 * Reads the URL a page declares itself a duplicate of, if any.
 *
 * A target outside the crawl is ignored rather than followed: a page canonicalising to another
 * domain is a finding in its own right, but it is not evidence about which of *this* site's URLs
 * are the same page, and inventing a group around a URL never fetched would put a page nobody has
 * seen at the head of it.
 */
function declaredTargetOf(page, byHash) {
  if (page.finalUrlHash && page.finalUrlHash !== page.urlHash && byHash.has(page.finalUrlHash)) {
    return { hash: page.finalUrlHash, reason: DUPLICATE_REASONS.redirect };
  }
  if (
    page.canonicalHash
    && page.canonicalHash !== page.urlHash
    && page.selfCanonical !== true
    && byHash.has(page.canonicalHash)
  ) {
    return { hash: page.canonicalHash, reason: DUPLICATE_REASONS.canonical };
  }
  return null;
}

/** Groups successful pages by the hash of their readable text, above the evidence floor. */
function textClustersOf(pages) {
  const byText = new Map();
  for (const page of pages) {
    if (page.status !== 200 || !page.textHash) continue;
    if ((page.wordCount ?? 0) < MIN_WORDS_FOR_TEXT_MATCH) continue;
    const cluster = byText.get(page.textHash);
    if (cluster) cluster.push(page);
    else byText.set(page.textHash, [page]);
  }
  return [...byText.values()].filter((cluster) => cluster.length > 1);
}

/**
 * Chooses the URL that should represent a group.
 *
 * The order encodes what a search engine would most likely settle on, so Orbik's answer and the
 * one showing up in results do not disagree without reason: a page that actually works, that says
 * it is canonical, that the site lists in its own sitemap, that is served over HTTPS, that the
 * site links to most, and — only to break a genuine tie — the shortest URL.
 *
 * HTTPS sits above the link count because old posts link to `http://` addresses: on a site that
 * answers both without redirecting, the plain-HTTP copy of a page can be the more linked, and
 * electing it put `http://` URLs at the head of 650 groups of one development site — in the
 * Library, in citations, and at a path with a collision suffix, since the HTTPS twin had already
 * taken the plain one.
 */
function elect(members) {
  return [...members].sort((left, right) =>
    score(right) - score(left)
    || (right.inbound ?? 0) - (left.inbound ?? 0)
    || left.url.length - right.url.length
    || (left.urlHash < right.urlHash ? -1 : 1))[0];
}

/** Ranks one candidate on the properties that survive a tie-break, most important first. */
function score(page) {
  return (page.status === 200 ? 8 : 0)
    + (page.selfCanonical === true ? 4 : 0)
    + (page.inSitemap ? 2 : 0)
    + (String(page.url).startsWith("https:") ? 1 : 0);
}

/**
 * Follows a chain of deferrals to the URL at its end.
 *
 * Chains are real: `/a/` redirects to `/a`, which canonicalises to `/`. Cycles are real too —
 * two pages canonicalising to each other is a common misconfiguration — so the walk is bounded and
 * a cycle resolves to its lowest hash, which is arbitrary but identical for every member and so
 * cannot produce two groups for one cycle.
 */
function rootOf(hash, defersTo) {
  const seen = new Set([hash]);
  let current = hash;
  while (defersTo.has(current)) {
    const next = defersTo.get(current).hash;
    if (seen.has(next)) return [...seen].sort()[0];
    seen.add(next);
    current = next;
  }
  return current;
}
