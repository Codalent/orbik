/**
 * What a source is: one thing a workspace reads, crawled on its own schedule and copied into the
 * Library under a folder of its own.
 *
 * A source is a crawl site (`crawl_sites`). Every workspace has one, its website, which is the
 * site it was made for; a person can add more. Some are other sites of theirs — a documentation
 * subdomain, a second domain — crawled the way the website is. Others are pages about them
 * elsewhere — a review profile, a directory listing, an article — of which only the pages a person
 * listed are read, and never the rest of that site.
 *
 * The API, the crawler and the Library all read the same document, so the rule for what a missing
 * field means lives here once. A site stored before sources existed carries none of these fields
 * and is the workspace's website: `describeSource` says so, and the `2026-11-19-sources` migration
 * writes it down.
 */

/** The website's folder under `/sources`, and the word routes accept in place of its id. */
export const WEBSITE_SOURCE = "website";

/** Whose pages a source holds. */
export const SOURCE_RELATION = Object.freeze({
  /** A site of the workspace's own: Orbik follows every link on its host. */
  own: "own",
  /** Pages about the workspace on somebody else's site: only the pages listed are read. */
  elsewhere: "elsewhere",
});

/** How much of its host a source covers. */
export const SOURCE_MODE = Object.freeze({
  /** Every page links and sitemaps lead to on the host. */
  site: "site",
  /** Only addresses under one path, such as `/guides/`. */
  section: "section",
  /** Only the addresses listed, and (when asked) their own "next page" pages. */
  pages: "pages",
});

/** Whether the knowledge base may be written from a source, or only search and Ask read it. */
export const SOURCE_KNOWLEDGE_USE = Object.freeze({ use: "use", copy: "copy" });

/**
 * What a source is, which tells the knowledge base how to use it.
 *
 * `guidance` is what the knowledge base agent is told about pages of this kind, and what the web
 * app shows under the choice: the same sentence, so a person reads the rule the model is given.
 */
export const SOURCE_PURPOSES = Object.freeze([
  Object.freeze({
    id: "product",
    label: "Company & product",
    guidance: "Read as what the company says about itself and what it sells.",
  }),
  Object.freeze({
    id: "docs",
    label: "Documentation",
    guidance: "Read for what the product does and how; not where the company’s claims come from.",
  }),
  Object.freeze({
    id: "blog",
    label: "Blog & news",
    guidance: "Read for what the company has said and when; dated, and never taken as current fact on its own.",
  }),
  Object.freeze({
    id: "reviews",
    label: "Testimonials & reviews",
    guidance: "Quoted word for word with the reviewer’s name and where they wrote it, never rewritten as the company speaking.",
  }),
  Object.freeze({
    id: "press",
    label: "Press & mentions",
    guidance: "Quoted and attributed to the publication, as what others say about the company.",
  }),
  Object.freeze({
    id: "other",
    label: "Something else",
    guidance: "Copied into the Library for search; the knowledge base decides case by case whether to use it.",
  }),
]);

/** The purpose ids, in the order they are offered. */
export const SOURCE_PURPOSE_IDS = Object.freeze(SOURCE_PURPOSES.map((purpose) => purpose.id));

/** One purpose by id, falling back to "Something else" for a value this release does not know. */
export function sourcePurpose(id) {
  return SOURCE_PURPOSES.find((purpose) => purpose.id === id) ?? SOURCE_PURPOSES.at(-1);
}

/**
 * Bounds on what a person can ask of a source.
 *
 * `pages` caps a page-list source: each listed page is a request on every visit, and a list longer
 * than this is a site, which is what the other modes are for. `perWorkspace` keeps the Sources page
 * a list a person reads rather than a database. `pagination` is how many "next page" pages one
 * listed page may lead to, which bounds a review listing that never stops paging.
 */
export const SOURCE_LIMITS = Object.freeze({
  perWorkspace: 20,
  pages: 50,
  pagination: 30,
  excludePatterns: 50,
  nameLength: 60,
  folderLength: 40,
});

/**
 * The share of a month's crawl allowance a source other than the website must leave untouched,
 * so the website — what every other part of Orbik is built on — always has room to be read.
 */
export const SOURCE_RESERVE_SHARE = 0.2;

/** How often a source's pages are read again when nobody chose for a page: once a week. */
export const SOURCE_DEFAULT_PAGE_INTERVAL_HOURS = 168;

/**
 * The MongoDB filter for a workspace's website, given its id.
 *
 * `primary` is written on every site by the `2026-11-19-sources` migration; the second branch is
 * for the moment between a process starting and the migration being run, when an old site has no
 * field and is the website all the same.
 */
export function websiteFilter(workspaceId) {
  return { workspaceId, $or: [{ primary: true }, { primary: { $exists: false } }] };
}

/**
 * A site document as a source, with every field this release reads filled in.
 *
 * @param {object} site a `crawl_sites` document
 * @returns {{primary: boolean, relation: string, mode: string, name: string, folder: string,
 *   purpose: string, knowledgeUse: string, section: string|null, pageUrls: string[],
 *   followPagination: boolean, excludePatterns: string[], pageIntervalHours: number|null, host: string|null}}
 */
export function describeSource(site) {
  const primary = site?.primary !== false;
  const relation = primary ? SOURCE_RELATION.own : (site?.relation ?? SOURCE_RELATION.own);
  const mode = relation === SOURCE_RELATION.elsewhere ? SOURCE_MODE.pages : (site?.mode ?? SOURCE_MODE.site);
  return {
    primary,
    relation,
    mode,
    name: site?.name ?? (primary ? "Website" : hostOf(site?.seedUrl) ?? "Source"),
    folder: site?.folder ?? (primary ? WEBSITE_SOURCE : null),
    purpose: SOURCE_PURPOSE_IDS.includes(site?.purpose) ? site.purpose : (primary ? "product" : "other"),
    // The website is what the knowledge base is about: it is always written from.
    knowledgeUse: primary ? SOURCE_KNOWLEDGE_USE.use : (site?.knowledgeUse ?? SOURCE_KNOWLEDGE_USE.use),
    section: mode === SOURCE_MODE.section ? (site?.section ?? null) : null,
    pageUrls: mode === SOURCE_MODE.pages ? (site?.pageUrls ?? []) : [],
    followPagination: mode === SOURCE_MODE.pages && site?.followPagination === true,
    excludePatterns: site?.excludePatterns ?? [],
    pageIntervalHours: site?.pageIntervalHours !== undefined
      ? site.pageIntervalHours
      : (primary ? null : SOURCE_DEFAULT_PAGE_INTERVAL_HOURS),
    host: site?.host ?? hostOf(site?.seedUrl),
  };
}

/**
 * The address patterns that keep a crawl inside one section, for the crawler's `includePatterns`.
 *
 * `/guides/` admits `/guides`, `/guides/` and everything under it, with or without a query, and
 * not `/guidesfoo`.
 */
export function sectionPatterns(section) {
  const base = String(section ?? "").replace(/\/+$/, "");
  if (!base) return [];
  return [base, `${base}/*`, `${base}?*`];
}

/**
 * Normalises what a person typed as a section to `/path/`, or null when it names no section.
 *
 * @param {string} value `guides`, `/guides`, `/guides/` or `/docs/guides/`
 */
export function normalizeSection(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed || /[?#*\s]/.test(trimmed)) return null;
  return `/${trimmed}/`;
}

/**
 * Query parameters a listing pages with. Only ever a number: `?page=2`, `?p=3`, `?offset=20`.
 */
const PAGINATION_PARAMS = new Set(["page", "p", "pg", "paged", "pagenum", "page_num", "offset", "start"]);

/** `/page/3` or `/page/3/` at the end of a path. */
const PAGINATION_PATH = /^(.*?)\/page\/(\d{1,5})\/?$/;

/**
 * Where one address sits in a listing that pages: the listing it belongs to, and which page it is.
 *
 * Read from the address alone, so the crawler can tell at discovery and again at fetch time that
 * `clutch.co/profile/acme?page=2` belongs with `clutch.co/profile/acme` without having to remember
 * which page linked to it. Exactly one pagination parameter, holding a number, or a `/page/N`
 * ending; anything else is not a page of a listing.
 *
 * @param {URL|{hostname: string, pathname: string, search: string}} url
 * @returns {{base: string, page: number}|null} `base` is `paginationBase` of the listing's first page
 */
export function paginationOf(url) {
  const params = new URLSearchParams(url.search ?? "");
  const paging = [...params.keys()].filter((key) => PAGINATION_PARAMS.has(key.toLowerCase()));
  if (paging.length === 1 && /^\d{1,5}$/.test(params.get(paging[0]) ?? "")) {
    const page = Number(params.get(paging[0]));
    params.delete(paging[0]);
    return { base: baseKey(url.hostname, url.pathname, params), page };
  }
  if (paging.length === 0) {
    const match = PAGINATION_PATH.exec(url.pathname ?? "");
    if (match) return { base: baseKey(url.hostname, match[1] || "/", params), page: Number(match[2]) };
  }
  return null;
}

/**
 * The key a listing's pages share: host, path without a trailing slash, and the query that is
 * left, sorted.
 *
 * @param {URL|{hostname: string, pathname: string, search: string}} url
 */
export function paginationBase(url) {
  return baseKey(url.hostname, url.pathname, new URLSearchParams(url.search ?? ""));
}

function baseKey(hostname, pathname, params) {
  const path = String(pathname || "/").replace(/\/+$/, "") || "/";
  const sorted = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = new URLSearchParams(sorted).toString();
  return `${String(hostname).toLowerCase()}${path}${query ? `?${query}` : ""}`;
}

/** The hostname of an absolute URL, lowercased, or null. */
export function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The domain a website's host stands for, for telling a site of the workspace's own from somebody
 * else's: the host without a leading `www.`.
 *
 * No public suffix list: `docs.example.co.uk` is matched against `example.co.uk` because the
 * website is `example.co.uk` (or `www.example.co.uk`), not because the suffix is known. That is the
 * question asked — is this address under the website's own domain — and a person can always say
 * otherwise.
 */
export function ownDomainOf(host) {
  return String(host ?? "").toLowerCase().replace(/^www\./, "");
}

/** Whether `host` is the website's domain or one of its subdomains. */
export function isUnderDomain(host, domain) {
  const candidate = String(host ?? "").toLowerCase();
  const own = ownDomainOf(domain);
  if (!candidate || !own) return false;
  return candidate === own || candidate.endsWith(`.${own}`);
}
