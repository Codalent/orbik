import { createHash } from "node:crypto";

import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

import { isPageLevel } from "./extract.js";
import { tryNormalizeUrl } from "./url.js";

/**
 * How much Markdown one page may keep, in bytes.
 *
 * A page of prose is five to fifty kilobytes. The cap is not for those; it is for the page that
 * turns out to be a hundred-thousand-row table or an inlined dataset, which would otherwise be
 * written whole into a document store that has a hard ceiling. The cut is marked in the text so
 * a reader — a person or a model — cannot mistake it for the end.
 */
const MARKDOWN_LIMIT_BYTES = 1_000_000;

/** What a cut page ends with. */
const TRUNCATION_NOTICE = "\n\n<!-- truncated: the page was longer than 1 MB of Markdown -->";

/** What a UTF-8 decoder puts where a cut split a character in two. */
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);

/**
 * What a cookie or consent banner is usually called.
 *
 * Exported because a second reader of pages needs the same answer: the Design system agent
 * samples a page's colours and type in Chrome, and a consent banner — somebody else's component,
 * in somebody else's colours — must not be counted as part of the site's design any more than it
 * is part of its content.
 */
export const CONSENT_SELECTORS = ".cookie, .cookies, .cookie-banner, .consent, #cookie-banner, #onetrust-consent-sdk";

/**
 * Elements that are never content: code, style, the chrome around the page, and anything that
 * is hidden or exists for a form. Removed before conversion so a blog post does not arrive with
 * the site's navigation at the top and its footer at the bottom of every file.
 *
 * `<header>` and `<footer>` are not on the list, because whether one is chrome depends on where it
 * is: the page's own are removed by {@link PAGE_LANDMARKS}, and an article's — which is where a
 * post's title usually sits — are content.
 */
const CHROME = [
  "script", "style", "noscript", "template", "iframe", "object", "embed", "svg", "canvas",
  "nav", "aside", "form", "button", "input", "select", "textarea", "dialog",
  "[role=navigation]", "[role=banner]", "[role=contentinfo]", "[role=complementary]", "[role=search]",
  "[role=dialog]", "[aria-hidden=true]", "[hidden]",
  CONSENT_SELECTORS,
  ".breadcrumb, .breadcrumbs, .share, .social, .newsletter, .sidebar, .skip-link",
].join(",");

/**
 * The page's header and footer, each with the role that makes one the page's own.
 *
 * Removed only when {@link isPageLevel} says they are the page's — the same rule the image
 * inventory uses to say an image is in the header. Removing every `<header>` took the title with
 * it wherever a site puts its H1 in `main > header` or `article > header`: 12 of 70 pages on one
 * site and 439 of 594 on another, measured on 2026-10-13.
 */
const PAGE_LANDMARKS = Object.freeze({ header: "banner", footer: "contentinfo" });

/**
 * Where the content of a page usually lives, most specific first.
 *
 * `main` and `article` are the page saying so itself. The rest are the names people give the
 * same thing when they do not use the elements for it. The body is the last resort, after the
 * chrome has been stripped from it.
 */
const CONTENT_ROOTS = [
  "main", "article", "[role=main]", "#main", "#content", "#main-content", "#primary",
  ".main-content", ".post-content", ".entry-content", ".article-content", ".article-body", ".content",
];

/**
 * How much of the page's text a candidate root must hold to be taken for the content.
 *
 * Without a floor the first match wins, and the first match can be a fragment: one card of a
 * listing — 29 words of 461 on a paginated tag page, measured on 2026-10-13 — or a
 * hero that happens to be called `.content`. The content is most of what a page says once its
 * chrome is gone, so a root holding less than most of it is a part of it, and the body, already
 * stripped of chrome, is the safer copy: it can carry a little extra, a fragment loses the rest.
 */
const ROOT_TEXT_SHARE = 0.6;

/**
 * The share of a block's text that must be link text for it to be taken for a menu.
 *
 * Only blocks before the first heading are judged. A menu built from `div`s rather than a `<nav>`
 * is links with a few labels between them: on one site's drawer menu, measured on 2026-10-13,
 * the labels ("Products", "Learn") were about 4% of its text. A paragraph that links a phrase or
 * two is nowhere near this.
 */
const NAVIGATION_LINK_SHARE = 0.9;

/**
 * The fewest links a block must hold to be taken for a menu.
 *
 * A pair of calls to action or a breadcrumb is two to four links and stays where it is; a menu is
 * many more. With {@link NAVIGATION_LINK_SHARE} and the before-the-first-heading rule, this keeps
 * a "Useful links" list at the end of an article, however many links it has.
 */
const NAVIGATION_MIN_LINKS = 8;

/**
 * Alt texts that say nothing about the picture: what a template writes when a field was left
 * empty, or the kind of thing an image is. Compared without case.
 */
const MEANINGLESS_ALTS = new Set(["null", "undefined", "image", "img", "photo", "picture"]);

/**
 * Alt texts that are a file's name rather than a description: an image extension at the end, a
 * capture tool's dated name (`CleanShot_2020-10-06_at_14.45.32_2x`), or a camera's numbered one.
 * Written to match a name and not a sentence, so "Screenshot of the giving dashboard" is kept.
 */
const FILENAME_ALTS = [
  /\.(?:avif|bmp|gif|heic|jpe?g|png|svg|tiff?|webp)$/i,
  /^(?:CleanShot|Screenshot)[\s_-]?\d{4}-\d{2}-\d{2}/i,
  /^(?:IMG_|DSC)\S*\d/,
];

/**
 * A Storyblok rendition: the original asset's path followed by `/m/` and the resize and filter
 * instructions. Captures the original's path.
 */
const STORYBLOK_RENDITION = /^(\/f\/.+?\.[a-z0-9]{2,5})\/m(?:\/.*)?$/i;

/**
 * Elements that start a block, flattened to inline text where a block cannot stand: in a link,
 * whose text is one line; in a table cell, which is one cell of one row; and in a heading made
 * from a disclosure's summary or a definition's term.
 */
const BLOCKS = new Set([
  "address", "article", "aside", "blockquote", "dd", "details", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr",
  "li", "main", "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th",
  "thead", "tr", "ul", "br",
]);

/** Containers in which a row of nothing but links or images is the layout putting blocks side by side. */
const LAYOUT_CONTAINERS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "CENTER", "DD", "DIV", "FIGURE", "FOOTER",
  "HEADER", "LI", "MAIN", "P", "SECTION",
]);

/** Elements whose Markdown is one line, so nothing inside them may be put on a line of its own. */
const ONE_LINE = new Set(["A", "CAPTION", "DT", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "SUMMARY", "TD", "TH"]);

/** The opening or closing line of a fenced code block, as the retrieval chunker reads one. */
const FENCE = /^\s*(?:```|~~~)/;

/** An image in Markdown, with an escaped bracket or parenthesis allowed inside it. */
const IMAGE_SYNTAX = /!\[(?:\\.|[^\]\\])*\]\((?:<[^>]*>|(?:\\.|[^)\\])*)\)/g;

/** A link in Markdown, capturing its text. */
const LINK_SYNTAX = /\[((?:\\.|[^\]\\])*)\]\((?:<[^>]*>|(?:\\.|[^)\\])*)\)/g;

/** One converter for the process; it holds no state between calls. */
const turndown = createTurndown();

/**
 * Converts one fetched HTML page to content-only Markdown.
 *
 * Runs inside the fetch job, on HTML the crawler already holds, so it costs no request and no
 * crawl budget — only a few tens of milliseconds of CPU per page, in a loop that is paced by
 * politeness delays anyway. It reads nothing but its arguments: the same page, the same
 * extraction and the same options give the same Markdown and the same hash.
 *
 * The result is the page's content, not the page: navigation, the page's own header and footer,
 * sidebars, cookie banners, forms and menus are removed, then the content root is taken and
 * cleaned of what only the layout needed — images with nothing to say, link titles, rendition
 * parameters, tracking parameters. A front-matter block carries what a reader needs to know about
 * the text without the page around it.
 *
 * @param {string} html the response body
 * @param {object} options
 * @param {string} options.url the page's URL, for resolving relative links and the front matter
 * @param {object} [options.extracted] what `extractPage` found, for the front matter and the title
 * @param {Date} [options.fetchedAt]
 * @param {object} [options.normalizeOptions] the site's URL normalisation policy (`stripParams`,
 *   `keepTrackingParams`, `sortQuery`), so a link in the text names a page as the crawler stored it;
 *   without one the defaults apply, which remove the common tracking parameters
 * @returns {{markdown: string, hash: string, bytes: number, truncated: boolean, words: number}}
 */
export function toMarkdown(html, { url, extracted = null, fetchedAt = new Date(), normalizeOptions = {} }) {
  const $ = cheerio.load(html ?? "");
  // Judged before anything is removed, because the rule reads what each one sits inside.
  $("header, footer").filter((_index, element) => isPageLevel($, element, PAGE_LANDMARKS[element.tagName])).remove();
  $(CHROME).remove();

  const root = contentRootOf($);
  dropLeadingMenus($, root);
  rewriteAddresses($, root, { base: url, normalizeOptions });
  flattenBlocks($, root.find("a[href], td, th").toArray());
  settleHeadings(root);
  unfoldDisclosures($, root);
  unfoldDefinitions($, root);

  const body = withTitle(finish(turndown.turndown(root.html() ?? "")), extracted?.headings?.h1?.[0]);
  const front = frontMatter({ url, extracted, fetchedAt });
  const { text, truncated } = capped(body, MARKDOWN_LIMIT_BYTES - Buffer.byteLength(front, "utf8"));
  const markdown = `${front}\n${text}\n`;

  return {
    markdown,
    // Taken over everything but the fetch time. With it, identical HTML fetched twice hashed twice
    // differently, so every crawl rewrote every page, the mirror copied every page again, and every
    // page the knowledge base is written from started a write run.
    hash: createHash("sha256").update(`${frontMatter({ url, extracted, fetchedAt: null })}\n${text}\n`).digest("hex"),
    bytes: Buffer.byteLength(markdown, "utf8"),
    truncated,
    words: countWords(body),
  };
}

/**
 * Chooses the element whose content is the page's content.
 *
 * The first candidate, most specific first, that holds {@link ROOT_TEXT_SHARE} of the text left
 * once the chrome is gone. Of several `article` elements the one with the most text is tried: on
 * a post followed by three related-post cards that is the post, and it passes; on a listing of
 * nine cards it is one card, and it fails, so the listing is taken whole from the body.
 */
function contentRootOf($) {
  const body = $("body");
  const floor = textLength(body) * ROOT_TEXT_SHARE;
  for (const selector of CONTENT_ROOTS) {
    const matches = $(selector);
    if (!matches.length) continue;
    const candidate = selector === "article" ? largestOf($, matches) : matches.first();
    const length = textLength(candidate);
    if (length > 0 && length >= floor) return candidate;
  }
  return body;
}

/** The one of several elements with the most text. */
function largestOf($, matches) {
  let best = matches.first();
  let most = textLength(best);
  matches.slice(1).each((_index, element) => {
    const length = textLength($(element));
    if (length > most) {
      best = $(element);
      most = length;
    }
  });
  return best;
}

/**
 * Removes menus that are not marked as one, from the part of the content before its first heading.
 *
 * A mega-menu or a drawer built from `div`s survives the `<nav>` rule and becomes the first thing
 * in the file: one product page (https://example.com/solutions/waf) began with "Products" and
 * 44 links. A block is
 * a menu when {@link NAVIGATION_LINK_SHARE} of its text is link text and it holds at least
 * {@link NAVIGATION_MIN_LINKS} links. Only what comes before the first heading is judged, because
 * that is where a page's chrome is and where its prose is not yet: a list of links further down is
 * the page's own. A block that is not a menu is looked inside, so a menu wrapped in a hero is found.
 * Text is what is measured; a row of logos with no words is not a menu by this rule.
 */
function dropLeadingMenus($, root) {
  const heading = root.find("h1, h2, h3, h4, h5, h6").first()[0];
  if (!heading) return;
  const measure = linkMeasure();
  const judge = (element) => {
    const { characters, linked, links } = measure(element);
    if (links >= NAVIGATION_MIN_LINKS && characters > 0 && linked >= characters * NAVIGATION_LINK_SHARE) {
      $(element).remove();
      return;
    }
    for (const child of [...element.children]) if (child.type === "tag") judge(child);
  };
  // What comes wholly before the heading: the earlier siblings of the heading and of each element
  // around it, up to the root. Listed before any is removed, because removing one unlinks it.
  const before = [];
  for (let node = heading; node && node !== root[0]; node = node.parent) {
    for (let sibling = node.prev; sibling; sibling = sibling.prev) if (sibling.type === "tag") before.push(sibling);
  }
  for (const element of before) judge(element);
}

/**
 * Builds a measure of an element's text: how many characters, how many of them are link text, and
 * how many links. Characters are counted without whitespace, so indentation in the markup does not
 * dilute a menu. Remembered per element, so judging a block and then its children reads each node once.
 */
function linkMeasure() {
  const known = new Map();
  const measure = (element) => {
    if (known.has(element)) return known.get(element);
    let characters = 0;
    let linked = 0;
    let links = 0;
    for (const child of element.children ?? []) {
      if (child.type === "text") characters += child.data.replace(/\s+/g, "").length;
      if (child.type !== "tag") continue;
      const inner = measure(child);
      characters += inner.characters;
      linked += inner.linked;
      links += inner.links;
    }
    if (element.name === "a" && element.attribs?.href !== undefined) {
      links += 1;
      linked = characters;
    }
    const result = { characters, linked, links };
    known.set(element, result);
    return result;
  };
  return measure;
}

/**
 * Makes every address in the content say what it points at, and drops what says nothing.
 *
 * - **Links** become absolute and go through the crawler's own `normalizeUrl` with the site's
 *   options, so a link in the file names the page as it is stored and loses its tracking
 *   parameters. The fragment is put back: the normaliser removes it because the server never sees
 *   it, but `#how-it-works` takes a reader somewhere. In-page anchors, `mailto:` and `tel:` are
 *   left as written.
 * - **Images** with nothing to say are removed: no alt, an empty one, or one from
 *   {@link MEANINGLESS_ALTS} or {@link FILENAME_ALTS}. An image whose `<figure>` has a caption is
 *   kept with the caption as its alt. The snapshot's image inventory keeps every image whatever
 *   this text drops, so nothing is lost.
 * - **Rendition addresses** are unwrapped to the original asset (see {@link originalAsset}).
 * - **`title` attributes** go from links and images: on 2,202 pages of one site they were
 *   the word `"null"`, and where they are real they repeat the text beside them.
 */
function rewriteAddresses($, root, { base, normalizeOptions }) {
  root.find("a[title], img[title]").removeAttr("title");
  root.find("a[href]").each((_index, element) => {
    const target = linkTarget($(element).attr("href"), base, normalizeOptions);
    if (target) $(element).attr("href", target);
  });
  root.find("img").each((_index, element) => {
    const image = $(element);
    const alt = altOf(image);
    if (!alt) {
      image.remove();
      return;
    }
    image.attr("alt", alt);
    const source = imageSource(image.attr("src"), base);
    if (source) image.attr("src", source);
  });
}

/** Where a link leads, absolute and normalised, or null to leave it as written. */
function linkTarget(value, base, normalizeOptions) {
  const href = String(value ?? "").trim();
  if (!href || /^(?:#|mailto:|tel:|javascript:|data:)/i.test(href)) return null;
  let absolute;
  try {
    absolute = new URL(href, base);
  } catch {
    // An address the URL parser refuses is left as written; the text around it still reads.
    return null;
  }
  const normalized = /^https?:$/.test(absolute.protocol) ? tryNormalizeUrl(absolute.href, normalizeOptions) : null;
  return normalized ? `${normalized.href}${absolute.hash}` : absolute.href;
}

/** What an image is worth saying about, as alt text, or "" when nothing is. */
function altOf(image) {
  const alt = collapse(image.attr("alt"));
  if (alt && !MEANINGLESS_ALTS.has(alt.toLowerCase()) && !FILENAME_ALTS.some((pattern) => pattern.test(alt))) return alt;
  const caption = image.closest("figure").find("figcaption").first();
  return caption.length ? collapse(caption.text()) : "";
}

/** An image's absolute address, unwrapped to the original when it is a rendition, or null to leave it. */
function imageSource(value, base) {
  const src = String(value ?? "").trim();
  if (!src || /^data:/i.test(src)) return null;
  try {
    const address = new URL(src, base);
    return (originalAsset(address) ?? address).href;
  } catch {
    return null;
  }
}

/**
 * The original behind an image service's rendition, for the two services the development sites
 * use, or null.
 *
 * A rendition's address is the original's with a size and a quality wrapped around it —
 * `/_next/image?url=%2Fimages%2Fhero.png&w=3840&q=75` — which tells a reader nothing and changes
 * whenever the site's breakpoints do. The Next.js optimiser's `url` is resolved against the
 * optimiser's own address, which is how Next resolves it; a Storyblok rendition is the asset's path
 * with `/m/` and the instructions after it. Every other address is left as written.
 */
function originalAsset(address) {
  if (address.pathname.endsWith("/_next/image")) {
    const inner = address.searchParams.get("url");
    if (!inner) return null;
    try {
      const original = new URL(inner, address);
      return /^https?:$/.test(original.protocol) ? original : null;
    } catch {
      return null;
    }
  }
  if (/(?:^|\.)storyblok\.com$/i.test(address.hostname)) {
    const match = STORYBLOK_RENDITION.exec(address.pathname);
    if (!match) return null;
    const original = new URL(address.href);
    original.pathname = match[1];
    return original;
  }
  return null;
}

/**
 * Turns the blocks inside each of some elements into inline text, each separated from the next
 * by a space.
 *
 * A card that is one big link with a heading and a paragraph in it came out as a link whose text
 * ran over several lines, and a `<th><h3>` broke the table it was in. Unwrapped rather than
 * read as text, so the emphasis, code and images inside survive. The blocks are found by walking
 * the elements rather than by a selector per element: a table of a few thousand cells would
 * otherwise compile the selector a few thousand times. A block inside two of the elements — a
 * link in a table cell — is unwrapped once.
 */
function flattenBlocks($, elements) {
  const blocks = new Set();
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (child.type !== "tag") continue;
      if (BLOCKS.has(child.name)) blocks.add(child);
      walk(child);
    }
  };
  for (const element of elements) walk(element);
  for (const block of blocks) {
    const node = $(block);
    node.before(" ");
    node.after(" ");
    node.replaceWith(node.contents());
  }
}

/**
 * Leaves the content one H1: the first, with every heading after a second one a level lower.
 *
 * The retrieval chunker ends a section at the next heading of the same or higher rank, so a stray
 * H1 — a changelog entry titled with one and written with `# Webhooks` and `# Endpoints` — closes
 * the title's section. The headings after the second H1 are lowered with it, so a subsection
 * stays below its section: what the page wrote as one level deeper stays one level deeper.
 */
function settleHeadings(root) {
  let first = false;
  let shift = 0;
  for (const heading of root.find("h1, h2, h3, h4, h5, h6").toArray()) {
    const level = Number(heading.name.slice(1));
    if (level === 1) {
      if (first) shift = 1;
      first = true;
    }
    if (shift) heading.name = `h${Math.min(6, level + shift)}`;
  }
}

/**
 * Turns a disclosure into a heading and its body, so a question and its answer are one section.
 *
 * `<details><summary>` is how an FAQ accordion is usually written, and the summary came out as a
 * plain paragraph: the chunker could never keep a question with its answer. The summary becomes a
 * heading one level below the nearest heading above it, or an H3 when there is none above it; the
 * level is taken from the page's own headings, so consecutive questions are siblings.
 */
function unfoldDisclosures($, root) {
  let above = null;
  for (const element of root.find("h1, h2, h3, h4, h5, h6, summary").toArray()) {
    if (element.name !== "summary") {
      above = Number(element.name.slice(1));
      continue;
    }
    flattenBlocks($, [element]);
    if (!collapse($(element).text())) {
      $(element).remove();
      continue;
    }
    element.name = `h${Math.min(6, (above ?? 2) + 1)}`;
  }
  root.find("details").each((_index, element) => {
    element.name = "div";
  });
}

/**
 * Turns a definition list into a bold line for each term and a paragraph for each definition.
 *
 * Markdown has no definition list, and the converter ran each term into its definition.
 */
function unfoldDefinitions($, root) {
  root.find("dt").each((_index, element) => {
    const term = $(element);
    flattenBlocks($, [element]);
    term.find("strong, b").each((_inner, emphasis) => {
      $(emphasis).replaceWith($(emphasis).contents());
    });
    if (!collapse(term.text())) {
      term.remove();
      return;
    }
    element.name = "p";
    term.wrapInner("<strong></strong>");
  });
  root.find("dl, dd").each((_index, element) => {
    element.name = "div";
  });
}

/**
 * The last pass over the converted text.
 *
 * Non-breaking spaces become spaces outside code: they are a typesetting instruction, they made the
 * same sentence match differently in a search, and one at the start of a line indents it into a
 * code block. A horizontal rule at either end of the body is removed: it separated the content
 * from chrome that is no longer there, and one at the top sat directly under the front matter.
 */
function finish(markdown) {
  const lines = linesOf(markdown.replace(/\r\n/g, "\n")).map(({ line, code }) =>
    code ? line : line.replace(/^( *)\xa0[\xa0 ]*/, "$1").replace(/\xa0/g, " "));
  return tidy(lines.join("\n"))
    .replace(/^(?:---[ \t]*(?:\n+|$))+/, "")
    .replace(/(?:(?:^|\n+)---[ \t]*)+$/, "")
    .trim();
}

/**
 * Puts the page's H1 at the top when the content came out without one.
 *
 * The title is what every heading path in the retrieval index hangs from, and what a reader of
 * the file looks for first. A page whose H1 sat in its own banner, or outside the root that was
 * chosen, would otherwise have none.
 */
function withTitle(body, heading) {
  if (!heading || linesOf(body).some(({ line, code }) => !code && /^#[ \t]+\S/.test(line))) return body;
  return `# ${turndown.escape(heading)}\n\n${body}`.trim();
}

/** Each line of a Markdown text, and whether it belongs to a fenced code block. */
function linesOf(markdown) {
  let fenced = false;
  return markdown.split("\n").map((line) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return { line, code: true };
    }
    return { line, code: fenced };
  });
}

/**
 * How many words of prose a body holds.
 *
 * Images are taken out and links reduced to their text, and a token counts only when it has a
 * letter or a digit and is not an address: split on whitespace alone, a home page's logo wall and
 * its rendition URLs counted as words.
 */
function countWords(body) {
  const prose = body.replace(IMAGE_SYNTAX, " ").replace(LINK_SYNTAX, "$1");
  return prose.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token) && !/^<?(?:https?:\/\/|www\.)/i.test(token)).length;
}

/** The body, cut to fit beside the front matter when it is too long, and whether it was cut. */
function capped(body, room) {
  if (Buffer.byteLength(body, "utf8") <= room) return { text: body, truncated: false };
  const cut = Buffer.from(body, "utf8").subarray(0, Math.max(0, room)).toString("utf8");
  // A cut through a multi-byte character decodes as a replacement character, which is not the page's.
  const text = cut.endsWith(REPLACEMENT_CHARACTER) ? cut.slice(0, -1) : cut;
  return { text: `${text}${TRUNCATION_NOTICE}`, truncated: true };
}

/**
 * The block at the top of every file that says what the text is.
 *
 * Front matter rather than a heading, because the point is to be machine-readable: an agent
 * handed this file learns the URL, the title, and when it was read without parsing prose. Without
 * a fetch time it is the block the content hash is taken over.
 */
function frontMatter({ url, extracted, fetchedAt }) {
  const lines = [
    `url: ${quote(url)}`,
    `title: ${quote(extracted?.title ?? "")}`,
    `description: ${quote(extracted?.metaDescription ?? "")}`,
    `canonical: ${quote(extracted?.canonical ?? "")}`,
    `lang: ${quote(extracted?.lang ?? "")}`,
    ...(fetchedAt ? [`fetched_at: ${quote(fetchedAt.toISOString())}`] : []),
  ];
  return `---\n${lines.join("\n")}\n---\n`;
}

function quote(value) {
  return JSON.stringify(String(value ?? ""));
}

/** Collapses the runs of blank lines conversion leaves behind, and trims the ends. */
function tidy(markdown) {
  return markdown
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textLength(node) {
  return node.text().replace(/\s+/g, " ").trim().length;
}

/** Collapses every run of whitespace to one space and trims. */
function collapse(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Whether a link or an image is one of a row of blocks the layout put side by side.
 *
 * Its container holds nothing else — no text of its own, no other element with anything in it —
 * and at least one more link or image: two buttons, a wall of logos. Written one after another
 * they ran into one line, `[Get started](…)[Learn more](…)`. An empty element beside them is a
 * spacer or an overlay and does not count. Never inside something that must stay one line: a
 * link, a heading or a table cell.
 */
function standsAlone(node) {
  const parent = node.parentNode;
  if (!parent || !LAYOUT_CONTAINERS.has(parent.nodeName)) return false;
  let blocks = 0;
  for (const sibling of parent.childNodes) {
    if (sibling.nodeType === 3 && sibling.nodeValue.trim()) return false;
    if (sibling.nodeType !== 1) continue;
    if (sibling.nodeName === "A" || sibling.nodeName === "IMG") {
      blocks += 1;
      continue;
    }
    if (sibling.textContent.trim() || sibling.querySelector("img")) return false;
  }
  if (blocks < 2) return false;
  for (let ancestor = parent; ancestor; ancestor = ancestor.parentNode) {
    if (ONE_LINE.has(ancestor.nodeName)) return false;
  }
  return true;
}

/**
 * Builds the converter with the choices that make the output readable rather than faithful.
 *
 * ATX headings and fenced code because that is what people write; the GFM plugin because
 * tables are the one thing plain Markdown cannot express and pages are full of them. Links with
 * no text and images with no source are dropped: they are tracking pixels and icon anchors, and
 * they leave `[]()` litter in the text. A link or image that stands alone in the layout gets a
 * line of its own, and list items are written `- item` with nesting at the item's text, as people
 * write them, rather than turndown's `-   item`.
 */
function createTurndown() {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    hr: "---",
  });
  service.use(gfm);
  const { inlineLink, image } = service.options.rules;
  // Added first, because a rule added later is asked first: the two that drop a link or an image
  // below must win over these.
  service.addRule("linkOnItsOwnLine", {
    filter: (node, options) => Boolean(inlineLink.filter(node, options)) && standsAlone(node),
    replacement: (content, node, options) => `\n\n${inlineLink.replacement(content, node, options)}\n\n`,
  });
  service.addRule("imageOnItsOwnLine", {
    filter: (node) => node.nodeName === "IMG" && Boolean(node.getAttribute("src")) && standsAlone(node),
    replacement: (content, node, options) => `\n\n${image.replacement(content, node, options)}\n\n`,
  });
  service.addRule("emptyLink", {
    filter: (node) => node.nodeName === "A" && !node.textContent.trim() && !node.querySelector("img"),
    replacement: () => "",
  });
  service.addRule("imageWithoutSource", {
    filter: (node) => node.nodeName === "IMG" && !node.getAttribute("src"),
    replacement: () => "",
  });
  service.addRule("listItem", {
    filter: "li",
    replacement: (content, node) => {
      const parent = node.parentNode;
      let prefix = "- ";
      if (parent.nodeName === "OL") {
        const start = Number.parseInt(parent.getAttribute("start") ?? "", 10);
        prefix = `${(Number.isFinite(start) ? start : 1) + Array.prototype.indexOf.call(parent.children, node)}. `;
      }
      // Leading space too, not only newlines: a link whose text began with one left it outside.
      const paragraph = /\n$/.test(content);
      const text = content.replace(/^\s+|\n+$/g, "") + (paragraph ? "\n" : "");
      return `${prefix}${text.replace(/\n/g, `\n${" ".repeat(prefix.length)}`)}${node.nextSibling ? "\n" : ""}`;
    },
  });
  return service;
}
