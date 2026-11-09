import { createHash } from "node:crypto";
import * as cheerio from "cheerio";

/** Elements whose text is markup or code rather than page content. */
const NON_CONTENT_ELEMENTS = "script, style, noscript, template, svg, iframe";

/** Caps that keep one hostile or generated page from filling the database. */
const EXTRACT_LIMITS = Object.freeze({
  maxLinks: 5000,
  maxHeadings: 200,
  maxHreflang: 200,
  maxStructuredDataTypes: 50,
  maxTextLength: 500_000,
  maxAnchorLength: 500,
  /** Images listed for one page; the rest are counted, with how many of them lack an alt. */
  maxImages: 200,
  /** The longest image or link address kept. A longer one is generated, and is not an address to fetch. */
  maxImageUrlLength: 2048,
  /** The longest existing alt text, caption, heading or nearby text kept beside an image. */
  maxImageTextLength: 300,
  /**
   * How much text an image's container may hold and still count as "the text beside the image".
   * A card with a name and a role is under this; the body of an article is far over it, and the
   * opening of an article is not text about a picture halfway down it.
   */
  maxImageContainerText: 400,
  /** How many ancestors are tried for that container. */
  maxImageContainerLevels: 5,
});

/**
 * The shape of the image inventory, raised when what is listed for an image changes.
 *
 * A snapshot written before the inventory existed has none, and that absence is how a reader tells
 * a page that has not been fetched in full since from a page with no images. The number lets a
 * later change to the list be told apart the same way.
 */
const IMAGE_INVENTORY_VERSION = 1;

/** Where an image's real address is kept by the scripts that load images late. */
const LAZY_SOURCE_ATTRIBUTES = Object.freeze(["data-src", "data-lazy-src", "data-original"]);

/** Where a set of sizes is kept, the late-loading spelling first. */
const SRCSET_ATTRIBUTES = Object.freeze(["data-srcset", "srcset"]);

/**
 * The width a size is chosen for when an address has to be picked from a set.
 *
 * Wide enough that text in a screenshot or a chart is still legible, and no wider: the reader of
 * these addresses downloads the file, and a 3,840-pixel rendition says nothing a 1,080-pixel one
 * does not.
 */
const PREFERRED_IMAGE_WIDTH = 1000;

/** `<source>` types skipped while another is on offer: formats a model cannot be shown. */
const UNREADABLE_SOURCE_TYPES = Object.freeze(new Set(["image/avif", "image/svg+xml", "image/heic", "image/jxl"]));

/**
 * Extracts every signal the crawler stores about one HTML page.
 *
 * This runs once per page and its output is what every later agent reads, so it collects the
 * union of what those agents need rather than the minimum this crawl uses. Re-fetching a page
 * because a downstream agent wanted one more field is the expensive mistake here.
 *
 * Values are returned **as written in the markup**, not as verdicts. `canonical` is the raw href,
 * `metaRobots` is the directives found. Deciding what they mean is
 * {@link import("./indexability.js").computeIndexability}'s job, and keeping extraction free of
 * judgement is what lets that verdict change without re-crawling the site.
 *
 * @param {string} html page source
 * @param {object} [options]
 * @param {string} [options.url] page URL, used to resolve relative references
 * @returns {object} extracted page signals
 */
export function extractPage(html, options = {}) {
  const $ = cheerio.load(html ?? "");

  const title = firstText($, "head title");
  const metaDescription = metaContent($, "description");
  const robotsDirectives = new Set();
  // `googlebot` overrides `robots` for Google specifically. Both are collected because a page
  // carrying only a `googlebot` noindex is still a page the owner does not want indexed, and
  // reporting it as indexable would be technically true and practically useless.
  for (const name of ["robots", "googlebot"]) {
    for (const directive of parseDirectives(metaContent($, name))) robotsDirectives.add(directive);
  }

  const text = readableText($);
  const links = extractLinks($, options.url);

  return {
    title,
    titleLength: title ? title.length : 0,
    metaDescription,
    metaDescriptionLength: metaDescription ? metaDescription.length : 0,
    metaRobots: [...robotsDirectives],
    canonical: attributeOf($, 'link[rel~="canonical"]', "href"),
    lang: attributeOf($, "html", "lang"),
    hreflang: $('link[rel~="alternate"][hreflang]')
      .slice(0, EXTRACT_LIMITS.maxHreflang)
      .map((_index, element) => ({
        hreflang: $(element).attr("hreflang")?.trim() ?? null,
        href: $(element).attr("href")?.trim() ?? null,
      }))
      .get()
      .filter((entry) => entry.hreflang && entry.href),
    headings: {
      h1: headingTexts($, "h1"),
      h2: headingTexts($, "h2"),
      h3: headingTexts($, "h3"),
    },
    wordCount: countWords(text),
    // A hash of the readable text, not of the HTML: a page whose only change is a rotating
    // build-id comment or a CSRF token has not changed for a reader, and treating it as changed
    // would make every recrawl look like a site-wide content update.
    textHash: createHash("sha256").update(text).digest("hex"),
    structuredDataTypes: structuredDataTypes($),
    dates: pageDates($),
    images: countImages($),
    // The same images one by one, beside the counts and never in place of them: the counts are
    // read by the crawl page and by other agents, and stay exactly what they were.
    imageInventory: imageInventory($, options.url),
    openGraph: {
      title: propertyContent($, "og:title"),
      description: propertyContent($, "og:description"),
      type: propertyContent($, "og:type"),
      image: propertyContent($, "og:image"),
    },
    links,
    linkCount: links.length,
  };
}

/**
 * Reads directives from an `X-Robots-Tag` response header.
 *
 * The header carries the same vocabulary as the meta tag and takes the same effect, but applies
 * to non-HTML responses too. It may appear several times, and a single value may name a specific
 * crawler (`googlebot: noindex`); the token before a colon is the agent, not a directive.
 *
 * @param {string | string[] | undefined} header raw header value(s)
 * @returns {string[]} lowercase directives
 */
export function parseXRobotsTag(header) {
  const values = Array.isArray(header) ? header : [header];
  const directives = new Set();
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const part of value.split(",")) {
      const trimmed = part.trim().toLowerCase();
      if (!trimmed) continue;
      // Strip a leading agent name so `googlebot: noindex` records `noindex`, not the agent.
      const directive = trimmed.includes(":") ? trimmed.slice(trimmed.indexOf(":") + 1).trim() : trimmed;
      if (directive) directives.add(directive);
    }
  }
  return [...directives];
}

/** Collects anchor and `link` references with the attributes that decide how they count. */
function extractLinks($, base) {
  const links = [];
  $("a[href]").each((_index, element) => {
    if (links.length >= EXTRACT_LIMITS.maxLinks) return false;
    const node = $(element);
    const rel = (node.attr("rel") ?? "").toLowerCase();
    links.push({
      href: node.attr("href").trim(),
      anchor: normalizeWhitespace(node.text()).slice(0, EXTRACT_LIMITS.maxAnchorLength),
      rel: rel || null,
      // `nofollow`, `ugc`, and `sponsored` all tell a search engine not to pass authority, so
      // treating only `nofollow` as unfollowed would over-count a site's real link equity.
      nofollow: /\b(nofollow|ugc|sponsored)\b/.test(rel),
      base: base ?? null,
    });
    return true;
  });
  return links;
}

/**
 * When the page says it was published and last changed.
 *
 * Nothing else the crawler stores answers "how old is this". The HTTP `last-modified` header is
 * usually absent on a statically generated site — it was null on every page of the first site this
 * was measured against — and a sitemap's `lastmod` is a deployment date, not a publication one: a
 * site rebuilt on Tuesday reports every post as modified on Tuesday.
 *
 * So the page's own claim is read, in the order a page is most likely to mean it: Open Graph's
 * article properties, then JSON-LD, then a `<time datetime>` element. A date that cannot be parsed
 * is dropped rather than guessed at — a wrong publication date would age a page out of the Library
 * on the strength of a typo.
 *
 * Extracted here, with the rest of the page's signals, rather than looked up per row later: this
 * runs once per fetch and a lookup into stored HTML would mean keeping the HTML.
 */
function pageDates($) {
  const structured = structuredDates($);
  return {
    published: parseDate(
      propertyContent($, "article:published_time")
      ?? metaContent($, "date")
      ?? structured.published
      ?? attributeOf($, "time[datetime]", "datetime"),
    ),
    modified: parseDate(
      propertyContent($, "article:modified_time")
      ?? propertyContent($, "og:updated_time")
      ?? structured.modified,
    ),
  };
}

/** Reads `datePublished` and `dateModified` from the page's JSON-LD, at any nesting depth. */
function structuredDates($) {
  const found = { published: null, modified: null };
  $('script[type="application/ld+json"]').each((_index, element) => {
    let parsed;
    try {
      parsed = JSON.parse($(element).text());
    } catch {
      return;
    }
    collectDates(parsed, found);
  });
  return found;
}

/** Walks a JSON-LD value, keeping the first date of each kind it finds. */
function collectDates(value, found, depth = 0) {
  if (depth > 10 || !value || (found.published && found.modified)) return;
  if (Array.isArray(value)) {
    for (const item of value) collectDates(item, found, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  if (!found.published && typeof value.datePublished === "string") found.published = value.datePublished;
  if (!found.modified && typeof value.dateModified === "string") found.modified = value.dateModified;
  for (const child of Object.values(value)) collectDates(child, found, depth + 1);
}

/**
 * Parses a date a page wrote, or returns null.
 *
 * Bounded either side because a page can say anything: a `0001-01-01` placeholder from a CMS and a
 * date in the future are both meaningless as "when was this published", and letting either through
 * would make an age comparison answer confidently and wrongly.
 */
function parseDate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const at = new Date(value.trim());
  if (Number.isNaN(at.getTime())) return null;
  const year = at.getUTCFullYear();
  if (year < 1995 || at.getTime() > Date.now() + DAY_MS) return null;
  return at;
}

/** A day, in milliseconds: the slack allowed for a clock or a timezone, not for a future post. */
const DAY_MS = 86_400_000;

/** Extracts the `@type` values declared by JSON-LD blocks, ignoring unparseable ones. */
function structuredDataTypes($) {
  const types = new Set();
  $('script[type="application/ld+json"]').each((_index, element) => {
    let parsed;
    try {
      parsed = JSON.parse($(element).text());
    } catch {
      // Invalid JSON-LD is common and is a finding for the schema agent, not a parse failure
      // that should cost us the rest of the page's signals.
      return;
    }
    collectTypes(parsed, types);
  });
  return [...types].slice(0, EXTRACT_LIMITS.maxStructuredDataTypes);
}

/** Walks a JSON-LD value, gathering every `@type` at any nesting depth. */
function collectTypes(value, types, depth = 0) {
  if (depth > 10 || types.size >= EXTRACT_LIMITS.maxStructuredDataTypes || !value) return;
  if (Array.isArray(value)) {
    for (const item of value) collectTypes(item, types, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const declared = value["@type"];
  for (const type of Array.isArray(declared) ? declared : [declared]) {
    if (typeof type === "string" && type) types.add(type);
  }
  for (const child of Object.values(value)) collectTypes(child, types, depth + 1);
}

/** Counts images and how many lack alt text, which is an accessibility and SEO finding. */
function countImages($) {
  let total = 0;
  let missingAlt = 0;
  $("img").each((_index, element) => {
    total += 1;
    // An explicit empty alt marks a decorative image and is correct; a missing attribute is not.
    if ($(element).attr("alt") === undefined) missingAlt += 1;
  });
  return { total, missingAlt };
}

/**
 * Lists the page's images, each with what the markup says about it.
 *
 * {@link countImages} says how many images lack alt text; this says which, and gives whatever
 * describes an image what it needs to decide whether one is worth describing and to describe it
 * in context — without fetching the page a second time. Per image:
 *
 * - **its address**, absolute. An image loaded late by a script has a placeholder in `src` and its
 *   real address elsewhere, so the address is looked for in `data-src`, `data-lazy-src` and
 *   `data-original`, then in `data-srcset` and `srcset`, then in the `<source>` elements of a
 *   surrounding `<picture>`, and `srcFrom` records where it was found. No script is run: an image
 *   whose address appears nowhere in the markup is listed with `src: null`, and one embedded in
 *   the page as a `data:` address is listed the same way with `srcFrom: "inline"` (the bytes are
 *   not copied into the snapshot).
 * - **its alt state**, exactly as {@link countImages} judges it: `missing` when there is no
 *   attribute, `empty` when the attribute says the image is decorative, `present` otherwise, with
 *   the text.
 * - **its `title` attribute**, which some sites fill where the alt text should have gone.
 * - **where it leads**, when it is inside a link, and the link's own words when it has any.
 * - **the words around it**: the heading above it in the page, the caption of its `<figure>`, and
 *   the text of its own small container — a card with a name under a portrait. That last one is
 *   kept only when the container is small and holds no other image, because the heading above an
 *   image can belong to the item before it, and a name must never be attached to the wrong face.
 * - **the size the markup states**, from `width` and `height` or an inline style, so an icon or a
 *   tracking pixel can be told without downloading it.
 * - **which part of the page it is in**: the page's header, its footer, its navigation, or its
 *   content. A `<header>` or `<footer>` inside an article or a section belongs to that article,
 *   as HTML defines it, and counts as content.
 * - whether the markup itself **hides it from assistive technology** (`aria-hidden`,
 *   `role="presentation"`), which is another way of saying an image is decorative.
 *
 * Everything is as written in the markup, like the rest of extraction: which images need alt text
 * is the agent's judgement, made from these facts.
 *
 * The list is capped, and the images beyond the cap are counted with how many of them have no alt
 * attribute, so the list and the count beside it always add up to {@link countImages}'s figures.
 *
 * @param {import("cheerio").CheerioAPI} $ the parsed page
 * @param {string} [pageUrl] the page's address, which relative addresses are resolved against
 * @returns {{version: number, items: object[], beyondCap: {total: number, missingAlt: number}}}
 */
function imageInventory($, pageUrl) {
  const base = documentBase($, pageUrl);
  const items = [];
  const beyondCap = { total: 0, missingAlt: 0 };
  // Headings and images are walked together, in the order they appear, so each image can be given
  // the heading most recently passed.
  let heading = null;

  $("h1, h2, h3, h4, h5, h6, img").each((_index, element) => {
    const node = $(element);
    if (element.tagName !== "img") {
      heading = normalizeWhitespace(node.text()).slice(0, EXTRACT_LIMITS.maxImageTextLength) || heading;
      return;
    }

    const alt = node.attr("alt");
    if (items.length >= EXTRACT_LIMITS.maxImages) {
      beyondCap.total += 1;
      if (alt === undefined) beyondCap.missingAlt += 1;
      return;
    }

    const altText = alt === undefined ? null : normalizeWhitespace(alt);
    // Read block by block, so a caption made of a title and a paragraph keeps the space between.
    const figcaption = node.closest("figure").find("figcaption").first();
    const caption = figcaption.length
      ? boundedText(figcaption[0], EXTRACT_LIMITS.maxImageTextLength).slice(0, EXTRACT_LIMITS.maxImageTextLength) || null
      : null;
    const nearby = nearbyText($, node);
    const anchor = node.closest("a[href]");
    items.push({
      ...imageAddress($, node, base),
      alt: alt === undefined ? "missing" : altText ? "present" : "empty",
      altText: altText ? altText.slice(0, EXTRACT_LIMITS.maxImageTextLength) : null,
      title: normalizeWhitespace(node.attr("title")).slice(0, EXTRACT_LIMITS.maxImageTextLength) || null,
      link: linkTarget(anchor.attr("href"), base),
      // What the link says in words, when it says anything: an image that is a link's only content
      // has to carry the link's purpose, and one beside the link's text does not.
      linkText: anchor.length ? boundedText(anchor[0], EXTRACT_LIMITS.maxImageTextLength).slice(0, EXTRACT_LIMITS.maxImageTextLength) || null : null,
      heading,
      caption,
      // The caption is inside the figure, so a small figure's text is its caption again.
      nearby: nearby && nearby !== caption ? nearby : null,
      width: statedSize(node, "width"),
      height: statedSize(node, "height"),
      region: regionOf($, node),
      presentational: isPresentational(node),
    });
  });

  return { version: IMAGE_INVENTORY_VERSION, items, beyondCap };
}

/** The address relative addresses are resolved against: the page's, unless it declares a base. */
function documentBase($, pageUrl) {
  const declared = attributeOf($, "base[href]", "href");
  if (!declared) return pageUrl ?? null;
  try {
    return new URL(declared, pageUrl ?? undefined).href;
  } catch {
    return pageUrl ?? null;
  }
}

/**
 * Finds an image's real address, and says where in the markup it was.
 *
 * `src` is taken as it stands unless it is a placeholder. It is one when it is empty or a `data:`
 * address, and also whenever the element carries a late-loading attribute: a script that puts the
 * real address in `data-src` puts something else in `src` until it runs.
 */
function imageAddress($, node, base) {
  const src = String(node.attr("src") ?? "").trim();
  const inline = /^data:/i.test(src);
  const lazy = LAZY_SOURCE_ATTRIBUTES.map((attribute) => [attribute, String(node.attr(attribute) ?? "").trim()]);

  const candidates = [
    ...lazy,
    ...(lazy.some(([, value]) => value) || inline || !src ? [] : [["src", src]]),
    ...SRCSET_ATTRIBUTES.map((attribute) => [attribute, pickFromSrcset(node.attr(attribute))]),
    ["source", pictureSource($, node)],
    // Last, because it was passed over above for a reason: an element with `data-src` whose real
    // address could not be read still has whatever its `src` says.
    ["src", inline ? "" : src],
  ];
  for (const [from, value] of candidates) {
    const address = fetchableAddress(value, base);
    if (address) return { src: address, srcFrom: from };
  }
  return { src: null, srcFrom: inline ? "inline" : null };
}

/**
 * Chooses one address from a `srcset`.
 *
 * Candidates are separated by commas and each may end in a width (`640w`) or a density (`2x`); a
 * comma inside an address is part of the address, as the HTML standard reads it. With widths, the
 * narrowest candidate that is at least {@link PREFERRED_IMAGE_WIDTH} wide is taken, or the widest
 * when none is; with densities, the densest; with neither, the first.
 */
function pickFromSrcset(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const candidates = [];
  for (const match of value.matchAll(/(\S+?)((?:\s+\d+(?:\.\d+)?[wxh])*)\s*(?:,(?=\s)|,?\s*$)/g)) {
    const url = match[1].replace(/,+$/, "");
    if (!url) continue;
    const width = /(\d+)w/.exec(match[2]);
    const density = /(\d+(?:\.\d+)?)x/.exec(match[2]);
    candidates.push({ url, width: width ? Number(width[1]) : null, density: density ? Number(density[1]) : null });
  }
  if (!candidates.length) return "";

  const widths = candidates.filter((candidate) => candidate.width !== null).sort((left, right) => left.width - right.width);
  if (widths.length) return (widths.find((candidate) => candidate.width >= PREFERRED_IMAGE_WIDTH) ?? widths.at(-1)).url;
  const densities = candidates.filter((candidate) => candidate.density !== null).sort((left, right) => right.density - left.density);
  return (densities[0] ?? candidates[0]).url;
}

/** An address from the `<source>` elements of the image's `<picture>`, in a readable format first. */
function pictureSource($, node) {
  const sources = node.closest("picture").find("source").toArray().map((element) => $(element));
  const readable = sources.filter((source) => !UNREADABLE_SOURCE_TYPES.has(String(source.attr("type") ?? "").trim().toLowerCase()));
  for (const source of [...readable, ...sources]) {
    for (const attribute of SRCSET_ATTRIBUTES) {
      const picked = pickFromSrcset(source.attr(attribute));
      if (picked) return picked;
    }
  }
  return "";
}

/** An absolute `http(s)` address without its fragment, or null when the value is not one. */
function fetchableAddress(value, base) {
  if (typeof value !== "string" || !value.trim()) return null;
  let parsed;
  try {
    parsed = new URL(value.trim(), base ?? undefined);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  parsed.hash = "";
  return parsed.href.length <= EXTRACT_LIMITS.maxImageUrlLength ? parsed.href : null;
}

/** Where a linked image leads: absolute when it is a web address, as written when it is not. */
function linkTarget(href, base) {
  if (typeof href !== "string" || !href.trim()) return null;
  const value = href.trim();
  return fetchableAddress(value, base) ?? value.slice(0, EXTRACT_LIMITS.maxImageUrlLength);
}

/**
 * The text of the smallest container around an image that holds any, when that container is small.
 *
 * Climbs from the image until an ancestor has text. If that text is short and the image is the
 * only one in the container — a card, a list item, a figure — it is about the image and is
 * returned. If it is long, the image sits in running prose, and if the container holds other
 * images its words belong to all of them; either way nothing is returned, because the start of
 * an article says nothing about a picture inside it.
 */
function nearbyText($, node) {
  let current = node.parent();
  for (let level = 0; level < EXTRACT_LIMITS.maxImageContainerLevels && current.length; level += 1) {
    const tag = current[0].tagName;
    if (!tag || tag === "body" || tag === "html") return null;
    // A container that holds a second image is a gallery, a grid of cards or the page itself, and
    // its words are about all of its images: three names beside three portraits say nothing about
    // which is whose.
    if (current.find("img").length > 1) return null;
    const text = boundedText(current[0], EXTRACT_LIMITS.maxImageContainerText + 1);
    if (text.length > EXTRACT_LIMITS.maxImageContainerText) return null;
    if (text) return text.slice(0, EXTRACT_LIMITS.maxImageTextLength);
    current = current.parent();
  }
  return null;
}

/**
 * An element's text, read only as far as `limit` characters.
 *
 * Asked of every image's ancestors, most of which are the whole page: reading all of a page's text
 * once per image to learn that it is long would cost more than the rest of extraction together.
 */
function boundedText(element, limit) {
  const parts = [];
  let length = 0;
  const walk = (node) => {
    if (length >= limit) return;
    if (node.type === "text") {
      parts.push(node.data);
      length += node.data.trim().length;
      return;
    }
    if (node.type !== "tag") return;
    for (const child of node.children ?? []) walk(child);
  };
  walk(element);
  return normalizeWhitespace(parts.join(" "));
}

/** A size the markup states in pixels, from the attribute or an inline style, or null. */
function statedSize(node, dimension) {
  const attribute = String(node.attr(dimension) ?? "").trim();
  const fromAttribute = /^(\d{1,5})(?:px)?$/i.exec(attribute);
  if (fromAttribute) return Number(fromAttribute[1]);
  const fromStyle = new RegExp(`(?:^|;)\\s*${dimension}\\s*:\\s*(\\d{1,5})(?:\\.\\d+)?px`, "i").exec(node.attr("style") ?? "");
  return fromStyle ? Number(fromStyle[1]) : null;
}

/**
 * Which part of the page an image is in.
 *
 * Navigation wherever it is. A header or a footer only when it is the page's own, by
 * {@link isPageLevel}: the hero image in an article's own `<header>` is content.
 */
function regionOf($, node) {
  if (node.closest("nav, [role=navigation]").length) return "navigation";
  const pageLevel = (selector, role) =>
    node.parents(`${selector}, [role=${role}]`).toArray().some((element) => isPageLevel($, element, role));
  if (pageLevel("header", "banner")) return "header";
  if (pageLevel("footer", "contentinfo")) return "footer";
  return "content";
}

/**
 * Whether a header or a footer is the page's own — its banner or its contentinfo — rather than
 * part of the content.
 *
 * HTML gives `<header>` and `<footer>` that meaning when they are not inside an article, a section,
 * the main content, an aside or a navigation block, and an explicit `banner` or `contentinfo` role
 * says so outright. Inside one of those they belong to it: a post's title sits in the post's own
 * `<header>`, and the name under a quotation in the quotation's `<footer>`.
 *
 * Exported because the Markdown converter asks the same question to decide what to remove, and
 * two copies of the rule would be two answers to whether a page's title is chrome.
 *
 * @param {import("cheerio").CheerioAPI} $ the parsed page
 * @param {import("domhandler").Element} element a `<header>` or `<footer>`, or an element with the role
 * @param {"banner"|"contentinfo"} role the role that makes it the page's own
 * @returns {boolean}
 */
export function isPageLevel($, element, role) {
  return $(element).attr("role") === role || !$(element).parents("article, aside, main, nav, section").length;
}

/** Whether the markup hides the image from assistive technology, on it or on something around it. */
function isPresentational(node) {
  const role = String(node.attr("role") ?? "").trim().toLowerCase();
  return role === "presentation" || role === "none" || node.closest('[aria-hidden="true"]').length > 0;
}

/** Returns the page's readable text with markup, script, and style content removed. */
function readableText($) {
  const body = $("body").length ? $("body").clone() : $.root().clone();
  body.find(NON_CONTENT_ELEMENTS).remove();
  return normalizeWhitespace(body.text()).slice(0, EXTRACT_LIMITS.maxTextLength);
}

/** Counts whitespace-separated words. */
function countWords(text) {
  if (!text) return 0;
  return text.split(" ").filter(Boolean).length;
}

/** Returns trimmed heading texts, bounded so a generated page cannot store thousands. */
function headingTexts($, selector) {
  return $(selector)
    .slice(0, EXTRACT_LIMITS.maxHeadings)
    .map((_index, element) => normalizeWhitespace($(element).text()))
    .get()
    .filter(Boolean);
}

/** Reads a `meta[name]` content value. */
function metaContent($, name) {
  return attributeOf($, `meta[name="${name}" i]`, "content");
}

/** Reads a `meta[property]` content value, as Open Graph uses. */
function propertyContent($, property) {
  return attributeOf($, `meta[property="${property}" i]`, "content");
}

/** Reads one attribute from the first matching element, or null. */
function attributeOf($, selector, attribute) {
  const value = $(selector).first().attr(attribute);
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
}

/** Reads the trimmed text of the first matching element, or null. */
function firstText($, selector) {
  const value = normalizeWhitespace($(selector).first().text());
  return value || null;
}

/** Splits a comma-separated directive list into lowercase tokens. */
function parseDirectives(value) {
  if (typeof value !== "string") return [];
  return value.split(",").map((directive) => directive.trim().toLowerCase()).filter(Boolean);
}

/** Collapses every run of whitespace to one space and trims. */
function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
