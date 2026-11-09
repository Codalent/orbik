import { LIBRARY_PATH_SEPARATOR } from "./library.js";

/**
 * Which pages the knowledge base is written from.
 *
 * Every page of a site is stored in the source layer, and storing one costs nothing. Writing the
 * knowledge base from one does cost something: a model has to read it. So the set is chosen, and
 * it is chosen here, by rule, with no model asked — because the alternative was the thing this
 * replaced. A model reading every page in order to decide whether to read it is one call per
 * page, and a site with 700 posts and a changelog of 4,000 entries is 4,700 of them.
 *
 * **The signal is who links to a page.** A page the navigation points at is linked from every
 * page of the site; a blog post is linked from its listing and a handful of related posts. That
 * difference is measured by the crawler already, it is free, and it does not care what the URL
 * looks like — a site that keeps its posts at `/a-post` rather than `/blog/a-post` is told apart
 * the same way.
 *
 * **It is a budget, filled in order.** There is a ceiling on how many pages and how many words
 * the knowledge base is written from, and pages are admitted until it is full:
 *
 * 1. a page a person asked for by name;
 * 2. a page a file of the knowledge base already cites, so nothing written goes quietly stale;
 * 3. pages linked from a large share of the site, most linked first;
 * 4. pages one of those links to from its content, when it links to few of them — eight case
 *    studies behind a "Case studies" page are the company's proof, and each has three links;
 * 5. everything else, most linked first.
 *
 * Ahead of all of it, a few kinds of page are never written from unless somebody asks: legal
 * boilerplate, logins and carts, pagination and tag listings, and pages with next to nothing on
 * them. A page that is merely short is a different case, and is decided by the same signal as
 * everything else: when the site points at it on purpose — from its navigation, or from a
 * listing — it is written from, because a contact page of forty words and a team member's
 * seventy-word profile are exactly what a reader wants and cost almost nothing to read. A short
 * page nothing points at is a stub, and is stored and left there.
 *
 * A wrong ranking therefore costs a bounded amount and is visible: every page gets a reason, the
 * source ledger shows it, and a person can pull any page in.
 */

/** The most pages a knowledge base is written from, unless a workspace sets its own. */
export const SYNTHESIS_PAGE_CEILING = 80;

/**
 * The most words of page a knowledge base is written from.
 *
 * A second bound beside the count, because the write run holds what it reads: eighty pages of
 * four thousand words each is more than a run can carry, and it is the first version of this agent
 * failing all over again. About a hundred and sixty thousand tokens of reading.
 */
const SYNTHESIS_WORD_CEILING = 120_000;

/** The share of a site's pages that must link to a page before it counts as linked site-wide. */
const SITE_WIDE_SHARE = 0.25;

/**
 * The fewest linking pages that can make a page site-wide, whatever the share works out to.
 *
 * A floor for small sites: on a six-page site a quarter is two pages, and two links are a related
 * post, not the navigation.
 */
const SITE_WIDE_MINIMUM = 4;

/**
 * The most pages a listing may link to and still have every one of them chosen.
 *
 * Two dozen is a portfolio or a team; seven hundred is an archive. The first is read whole and
 * the second is stored, indexed and described from its titles.
 */
const SMALL_LISTING_PAGES = 24;

/**
 * The fewest words a page must have before the knowledge base is written from it at all.
 *
 * Thirty is a heading, a sentence and a button: a booking form, a page that failed to render.
 */
const SYNTHESIS_MIN_WORDS = 30;

/**
 * Below this a page is short, and is written from only when the site itself points at it.
 *
 * It was the single floor while every page chosen cost a model call of its own. The cost is gone,
 * so the question is no longer whether a short page is worth reading but whether anybody meant
 * it to be found.
 */
const SYNTHESIS_SHORT_WORDS = 100;

/** How many listings are remembered for one page. More than this says nothing a reader needs. */
const MAX_LISTINGS_PER_PAGE = 12;

/**
 * Why a page is or is not written from, as a fixed set of reasons.
 *
 * A closed set rather than free text because these are read back by a person asking "why is my
 * best post not in here", and a reason nobody can act on should not have been a rule.
 */
const SELECTION_REASONS = Object.freeze({
  /** A person asked for this page by name. */
  included: "included",
  /** A file of the knowledge base cites it already. */
  inUse: "in-use",
  /** Linked from a large share of the site: the navigation, the footer. */
  siteWide: "site-wide",
  /** One of a few pages a site-wide page links to from its content. */
  listed: "listed",
  /** Admitted on its link count while the budget had room. */
  ranked: "ranked",
  /** Legal, privacy, terms: real pages, and not what the business is. */
  boilerplate: "boilerplate",
  /** Login, checkout, cart, account: machinery rather than prose. */
  transactional: "transactional",
  /** Pagination, tag, category and author listings: a list of links, not a page about something. */
  listing: "listing",
  /** Next to nothing on it. */
  thin: "thin",
  /** Short, and neither the navigation nor a listing links to it. */
  stub: "stub",
  /** The budget was full before its turn came. */
  beyondCeiling: "beyond-ceiling",
});

/** The reasons that mean a page is written from. */
const CHOSEN_REASONS = new Set([
  SELECTION_REASONS.included,
  SELECTION_REASONS.inUse,
  SELECTION_REASONS.siteWide,
  SELECTION_REASONS.listed,
  SELECTION_REASONS.ranked,
]);

/** Path segments that mean "this is a list of other pages", wherever they appear. */
const LISTING_SEGMENTS = Object.freeze([
  "page", "pages", "tag", "tags", "category", "categories", "author", "authors",
  "archive", "archives", "feed", "rss", "sitemap", "search", "filter", "label", "labels",
]);

/** Path segments that mean "legal boilerplate". */
const BOILERPLATE_SEGMENTS = Object.freeze([
  "privacy", "privacy-policy", "terms", "terms-of-service", "terms-and-conditions", "terms-of-use",
  "legal", "cookie-policy", "cookies", "gdpr", "imprint", "impressum", "disclaimer",
  "accessibility-statement", "refund-policy", "returns-policy",
]);

/** Path segments that mean "machinery a visitor transacts with". */
const TRANSACTIONAL_SEGMENTS = Object.freeze([
  "login", "log-in", "signin", "sign-in", "signup", "sign-up", "register", "logout", "log-out",
  "cart", "checkout", "basket", "account", "my-account", "dashboard", "password", "reset-password",
  "verify", "subscribe", "unsubscribe", "thank-you", "thanks", "404", "not-found",
]);

/**
 * How many pages must link to a page before it counts as linked site-wide.
 *
 * A share of the site rather than a number, which is what makes it mean the same thing on a
 * seventy-page brochure and a five-thousand-page publication: the navigation is on every page of
 * both, and a post is not.
 *
 * @param {number} siteSize pages the crawler rendered
 */
function siteWideThreshold(siteSize) {
  return Math.max(SITE_WIDE_MINIMUM, Math.ceil(Math.max(0, siteSize) * SITE_WIDE_SHARE));
}

/**
 * The pages linked from a large share of the site, and the home page with them.
 *
 * Asked for separately from the choice itself because the caller needs it first: what these pages
 * link to is the one thing the choice reads that is not already on a page's own row.
 *
 * @param {ReadonlyArray<{key: string, inboundCount?: number, depth?: number|null}>} pages
 * @param {number} siteSize pages the crawler rendered
 * @returns {Set<string>} their keys
 */
export function siteWidePages(pages, siteSize) {
  const threshold = siteWideThreshold(siteSize);
  const keys = new Set();
  for (const page of pages) {
    if ((page.inboundCount ?? 0) >= threshold || page.depth === 0) keys.add(page.key);
  }
  return keys;
}

/**
 * Chooses the pages a knowledge base is written from.
 *
 * @param {ReadonlyArray<object>} pages every page stored in the source layer
 * @param {string} pages[].key the crawler's URL hash
 * @param {string} pages[].url
 * @param {number} [pages[].words]
 * @param {number} [pages[].inboundCount] how many pages link to it
 * @param {number|null} [pages[].depth] clicks from the home page
 * @param {Date|string|null} [pages[].publishedAt]
 * @param {boolean} [pages[].included] a person asked for it by name
 * @param {boolean} [pages[].cited] a file of the knowledge base cites it
 * @param {object} options
 * @param {number} options.siteSize pages the crawler rendered, which is what a share is a share of
 * @param {Map<string, Iterable<string>>} [options.outbound] for each site-wide page, the keys of
 *   the pages it links to
 * @param {number} [options.ceiling] the most pages to choose
 * @param {number} [options.words] the most words to choose
 * @returns {{decisions: Map<string, {chosen: boolean, reason: string, message: string,
 *   listedBy: string[]}>, listings: Array<{key: string, url: string, children: string[],
 *   small: boolean}>, threshold: number, counts: Record<string, number>}}
 */
export function chooseSynthesisPages(pages, {
  siteSize,
  outbound = new Map(),
  ceiling = SYNTHESIS_PAGE_CEILING,
  words = SYNTHESIS_WORD_CEILING,
} = {}) {
  const threshold = siteWideThreshold(siteSize);
  const siteWide = siteWidePages(pages, siteSize);
  const byKey = new Map(pages.map((page) => [page.key, page]));
  const setAside = new Map();
  for (const page of pages) {
    const rule = setAsideRule(page);
    if (rule) setAside.set(page.key, rule);
  }

  // The tail: pages that are neither linked site-wide nor set aside by rule. A site-wide page's
  // links to these are necessarily links from its content, because a link in the navigation is on
  // every page and would have made its target site-wide.
  const isTail = (key) => byKey.has(key) && !siteWide.has(key) && !setAside.has(key);

  const listings = [];
  const listedBy = new Map();
  for (const key of siteWide) {
    const listing = byKey.get(key);
    if (!listing) continue;
    const children = [...new Set(outbound.get(key) ?? [])].filter((child) => child !== key && isTail(child));
    if (!children.length) continue;
    listings.push({ key, url: listing.url, children, small: children.length <= SMALL_LISTING_PAGES });
  }
  // Fewest children first, so the listing a page is described by is the most specific one: a case
  // study is "listed on /case-studies" rather than "listed on the home page".
  listings.sort((left, right) => left.children.length - right.children.length || left.url.localeCompare(right.url));
  for (const listing of listings) {
    for (const child of listing.children) {
      if (!listedBy.has(child)) listedBy.set(child, []);
      listedBy.get(child).push(listing);
    }
  }

  const decisions = new Map();
  const counts = Object.fromEntries(Object.values(SELECTION_REASONS).map((reason) => [reason, 0]));
  const budget = { pages: ceiling, words };
  const decide = (page, reason, detail = {}) => {
    const chosen = CHOSEN_REASONS.has(reason);
    if (chosen) {
      budget.pages -= 1;
      budget.words -= page.words ?? 0;
    }
    counts[reason] += 1;
    decisions.set(page.key, {
      chosen,
      reason,
      message: messageFor(reason, { page, siteSize, ceiling, ...detail }),
      listedBy: (listedBy.get(page.key) ?? []).slice(0, MAX_LISTINGS_PER_PAGE).map((listing) => listing.key),
    });
  };
  /** Whether the budget still has room for this page. */
  const fits = (page) => budget.pages > 0 && budget.words - (page.words ?? 0) >= 0;

  // What a person asked for and what is already in use are in whatever the budget says. They are
  // counted against it, so a workspace that pulls in forty pages by hand has forty fewer chosen
  // for it, but neither is ever dropped to make room.
  for (const page of pages) {
    if (page.included === true) decide(page, SELECTION_REASONS.included);
  }
  for (const page of pages) {
    if (!decisions.has(page.key) && page.cited === true) decide(page, SELECTION_REASONS.inUse);
  }
  for (const page of pages) {
    if (!decisions.has(page.key) && setAside.has(page.key)) decide(page, setAside.get(page.key));
  }

  const remaining = () => pages.filter((page) => !decisions.has(page.key));

  for (const page of remaining().filter((entry) => siteWide.has(entry.key)).sort(byProminence)) {
    if (fits(page)) decide(page, SELECTION_REASONS.siteWide);
  }

  // Among the listed, the page more site-wide pages point at goes first: a case study shown on
  // the home page, the case-studies page and two service pages is one the company keeps choosing.
  const smallListings = (page) => (listedBy.get(page.key) ?? []).filter((listing) => listing.small);
  const listed = remaining()
    .filter((page) => smallListings(page).length > 0)
    .sort((left, right) => smallListings(right).length - smallListings(left).length || byProminence(left, right));
  for (const page of listed) {
    if (fits(page)) decide(page, SELECTION_REASONS.listed, { listing: smallListings(page)[0] });
  }

  // What is left was reached by neither the navigation nor a listing. A short page among those is
  // a stub, whatever its link count says.
  for (const page of remaining()) {
    // Not the ones the budget turned away above: those were pointed at, and say so.
    if (siteWide.has(page.key) || smallListings(page).length) continue;
    if ((page.words ?? 0) < SYNTHESIS_SHORT_WORDS) decide(page, SELECTION_REASONS.stub);
  }

  for (const page of remaining().sort(byProminence)) {
    if (fits(page)) decide(page, SELECTION_REASONS.ranked);
  }
  for (const page of remaining()) decide(page, SELECTION_REASONS.beyondCeiling);

  return { decisions, listings, threshold, counts };
}

/**
 * The rule that sets a page aside whatever links to it, or null.
 *
 * The segment lists are conventions of the web rather than of any one site — `/privacy-policy`,
 * `/login`, `/page/3` — which is the difference between these and a rule about `/blog/`.
 */
function setAsideRule(page) {
  const segments = pathSegmentsOf(page.url);
  if (segments.some((segment) => BOILERPLATE_SEGMENTS.includes(segment))) return SELECTION_REASONS.boilerplate;
  if (segments.some((segment) => TRANSACTIONAL_SEGMENTS.includes(segment))) return SELECTION_REASONS.transactional;
  // A numbered page — `/blog/page/3` — is pagination whatever else it looks like.
  if (isListingUrl(page.url)) return SELECTION_REASONS.listing;
  if ((page.words ?? 0) < SYNTHESIS_MIN_WORDS) return SELECTION_REASONS.thin;
  return null;
}

/**
 * Whether a URL is an archive of other pages by the web's own conventions: pagination, and the
 * tag, category and author listings a publishing tool generates — `/blog/page/3`, `/tag/kubernetes`,
 * `/author/emile`.
 *
 * Asked of the path alone, and only of a segment with something after it, so `/tags` as a page
 * of its own is not caught and `/tag/kubernetes` is. Such a page is a list of titles and excerpts
 * of posts that are pages in their own right, which is why the knowledge base is not written
 * from it and the retrieval index does not hold it.
 *
 * @param {string} url the page's URL, or its path
 */
export function isListingUrl(url) {
  const segments = pathSegmentsOf(url);
  return segments.some((segment, index) => LISTING_SEGMENTS.includes(segment) && index < segments.length - 1);
}

/**
 * Most linked first; then nearest the home page; then newest; then longest.
 *
 * The date is the tie-break that stands in for the old age rule. Nothing is left out for being
 * old any more, but of two posts with three links each the one from this year is the better guess
 * at what the company says now.
 */
function byProminence(left, right) {
  const inbound = (right.inboundCount ?? 0) - (left.inboundCount ?? 0);
  if (inbound) return inbound;
  const depth = (left.depth ?? Number.MAX_SAFE_INTEGER) - (right.depth ?? Number.MAX_SAFE_INTEGER);
  if (depth) return depth;
  const published = timeOf(right.publishedAt) - timeOf(left.publishedAt);
  if (published) return published;
  const words = (right.words ?? 0) - (left.words ?? 0);
  if (words) return words;
  return String(left.url).localeCompare(String(right.url));
}

/** A date as a number for sorting, with a missing or unreadable one sorting oldest. */
function timeOf(value) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/** The sentence a person reads beside a page in the source ledger. */
function messageFor(reason, { page, siteSize, ceiling, listing = null }) {
  const inbound = page.inboundCount ?? 0;
  const linked = inbound === 1 ? "Linked from 1 page" : `Linked from ${inbound.toLocaleString("en-US")} pages`;
  switch (reason) {
    case SELECTION_REASONS.included:
      return "You asked for this page to be included.";
    case SELECTION_REASONS.inUse:
      return "The knowledge base already cites this page.";
    case SELECTION_REASONS.siteWide:
      return page.depth === 0
        ? "The home page."
        : `Linked from ${inbound.toLocaleString("en-US")} of the site's ${siteSize.toLocaleString("en-US")} pages.`;
    case SELECTION_REASONS.listed: {
      const others = listing ? listing.children.length - 1 : 0;
      const where = listing ? pathOf(listing.url) : "a page the navigation links to";
      return others > 0
        ? `Listed on ${where} with ${others} other ${others === 1 ? "page" : "pages"}.`
        : `Linked from the content of ${where}.`;
    }
    case SELECTION_REASONS.ranked:
      return `${linked}, which is within the ${ceiling.toLocaleString("en-US")} the knowledge base is written from.`;
    case SELECTION_REASONS.boilerplate:
      return "Stored and searchable. Not written from: a legal or privacy page.";
    case SELECTION_REASONS.transactional:
      return "Stored and searchable. Not written from: a login, cart or checkout page.";
    case SELECTION_REASONS.listing:
      return "Stored and searchable. Not written from: pagination, a tag, a category or an author page.";
    case SELECTION_REASONS.thin:
      return `Stored and searchable. Not written from: fewer than ${SYNTHESIS_MIN_WORDS} words.`;
    case SELECTION_REASONS.stub:
      return `Stored and searchable. Not written from: fewer than ${SYNTHESIS_SHORT_WORDS} words, and neither ` +
        "the navigation nor a listing links to it.";
    default:
      return `Stored and searchable. ${linked}; the knowledge base is written from the ` +
        `${ceiling.toLocaleString("en-US")} most linked-to pages.`;
  }
}

/** The path of a URL, for naming a page to a person. */
function pathOf(url) {
  try {
    return new URL(url).pathname || LIBRARY_PATH_SEPARATOR;
  } catch {
    return String(url);
  }
}

/** The lowercase path segments of a URL. */
function pathSegmentsOf(value) {
  let pathname = String(value ?? "");
  try {
    pathname = new URL(pathname).pathname;
  } catch {
    // Already a path.
  }
  return pathname.toLowerCase().split(LIBRARY_PATH_SEPARATOR).filter(Boolean);
}
