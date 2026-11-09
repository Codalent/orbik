import { AGENT_COLLECTIONS, BRAND_LIMITS } from "@orbik/core";

/**
 * Path segments that mark a page as machinery or small print rather than as the site's design.
 *
 * Such pages are linked from every footer, so by inbound links alone they would be the first ones
 * chosen — and a privacy policy is eight screens of body text with none of the components a
 * design system is read from.
 */
const UNREPRESENTATIVE = /(^|\/)(privacy|terms|legal|cookies?|gdpr|imprint|impressum|disclaimer|login|signin|sign-in|signup|sign-up|register|cart|checkout|account|search|sitemap|feed|rss|404|unsubscribe)(\/|-|$)/i;

/**
 * Chooses the pages one derivation renders.
 *
 * A person's own list wins when there is one: it is the override the setup page offers, and it is
 * read here at the start of the run, so a page added the day before a scheduled run is rendered
 * by that run. Otherwise the choice is the crawl's: the home page, then the most linked-to page
 * of each of the most linked-to route patterns.
 *
 * Routes rather than pages, for the reason the Library judges routes: a site is ten to thirty
 * templates, not two thousand independent designs. One blog post shows what every blog post looks
 * like, and the eight slots are better spent on eight different templates than on the eight most
 * popular posts.
 *
 * Only pages the crawler rendered to Markdown are candidates, which is what "answered 2xx with
 * HTML" means in the stored crawl, and a duplicate under another URL never is.
 *
 * A site whose addresses are all one or two shapes — `/[slug]`, `/[slug]/[slug]` — has fewer
 * patterns than there are slots. The slots left over go to the most linked-to pages of sections
 * not yet represented, a section being the first segment of the path: `/blog/a-post` stands for
 * one template and `/services/ai` for another, even where the crawl sees a single pattern.
 *
 * @param {object} options
 * @param {import("mongodb").Db} options.database connected database
 * @param {import("mongodb").ObjectId} options.siteId the crawl site
 * @param {string} options.seedUrl the site's own address, which is its home page
 * @param {object[]} [options.chosen] the pages on the agent's setup, when a person chose any
 * @param {number} [options.limit] how many pages at most
 * @returns {Promise<{pages: Array<{url: string, label: string, title: string|null, pattern: string|null, reason: string}>, source: "setup"|"crawl"}>}
 */
export async function selectPages({ database, siteId, seedUrl, chosen = [], limit = BRAND_LIMITS.pages }) {
  if (chosen.length) {
    return {
      source: "setup",
      pages: chosen.slice(0, limit).map((page) => ({ url: page.url, label: page.label, title: null, pattern: page.pattern ?? null, reason: "chosen" })),
    };
  }

  const home = { url: seedUrl, label: "Home", title: null, pattern: "/", reason: "home" };
  const [rendered, registry] = await Promise.all([
    database.collection(AGENT_COLLECTIONS.markdown).find({ siteId }).project({ urlHash: 1, url: 1, title: 1, heading: 1 }).toArray(),
    database
      .collection(AGENT_COLLECTIONS.urls)
      .find({ siteId })
      .project({ urlHash: 1, routePattern: 1, inboundCount: 1, depth: 1, variantOf: 1, lastStatus: 1 })
      .toArray(),
  ]);
  const signals = new Map(registry.map((row) => [row.urlHash, row]));
  const homeKey = comparable(seedUrl);

  const byPattern = new Map();
  const candidates = [];
  for (const page of rendered) {
    const signal = signals.get(page.urlHash);
    if (!signal || signal.variantOf || (Number.isInteger(signal.lastStatus) && signal.lastStatus >= 300)) continue;
    if (comparable(page.url) === homeKey) continue;
    let path = "/";
    try {
      path = new URL(page.url).pathname;
    } catch {
      continue;
    }
    if (UNREPRESENTATIVE.test(path)) continue;
    const pattern = signal.routePattern ?? path;
    // Labelled by its path, which is short and says which template it is; the title is kept
    // beside it for a reader who knows the page by name.
    const candidate = {
      url: page.url,
      label: decodePath(path),
      title: page.title ?? page.heading ?? null,
      pattern,
      section: path.split("/").filter(Boolean)[0] ?? "",
      segments: path.split("/").filter(Boolean).length,
      inbound: signal.inboundCount ?? 0,
      depth: signal.depth ?? 9,
    };
    candidates.push(candidate);
    const group = byPattern.get(pattern) ?? { pattern, pages: 0, inbound: 0, best: null };
    group.pages += 1;
    group.inbound = Math.max(group.inbound, candidate.inbound);
    // The page that stands for its pattern: the most linked-to, then the shallowest, then by
    // address so the same crawl always yields the same choice.
    if (!group.best || better(candidate, group.best)) group.best = candidate;
    byPattern.set(pattern, group);
  }

  const patterns = [...byPattern.values()].sort(
    (left, right) => right.inbound - left.inbound || right.pages - left.pages || left.pattern.localeCompare(right.pattern),
  );
  const pages = [home];
  const taken = new Set();
  // A template is told apart by where it sits and how deep: a section's index and a page inside
  // the section are two layouts.
  const templateOf = (candidate) => `${candidate.section}/${Math.min(candidate.segments, 3)}`;
  const add = (candidate, reason) => {
    pages.push({ url: candidate.url, label: candidate.label.slice(0, 120), title: candidate.title ? String(candidate.title).slice(0, 200) : null, pattern: candidate.pattern, reason });
    taken.add(candidate.url);
  };
  for (const group of patterns) {
    if (pages.length >= limit) break;
    add(group.best, group.pages > 1 ? `most linked-to of ${group.pages} pages under ${group.pattern}` : "one of the most linked-to pages");
  }
  const represented = new Set(pages.slice(1).map((page) => templateOf(candidates.find((candidate) => candidate.url === page.url))));
  for (const candidate of [...candidates].sort((left, right) => (better(left, right) ? -1 : 1))) {
    if (pages.length >= limit) break;
    if (taken.has(candidate.url) || represented.has(templateOf(candidate))) continue;
    represented.add(templateOf(candidate));
    add(candidate, `most linked-to page of the /${candidate.section} section at its depth`);
  }
  return { source: "crawl", pages };
}

/** A path as a person reads it: percent-escapes decoded, no trailing slash. */
function decodePath(path) {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

/** Whether one candidate should stand for its pattern rather than another. */
function better(candidate, current) {
  if (candidate.inbound !== current.inbound) return candidate.inbound > current.inbound;
  if (candidate.depth !== current.depth) return candidate.depth < current.depth;
  return candidate.url.localeCompare(current.url) < 0;
}

/** An address in the form two spellings of one page share: no fragment, no trailing slash. */
function comparable(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`.toLowerCase();
  } catch {
    return String(url).toLowerCase();
  }
}
