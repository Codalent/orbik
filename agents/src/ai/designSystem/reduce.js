import { clusterColors, hexToOklch } from "@orbik/design-system";

import { EXTRACTOR_VERSION } from "./fingerprint.js";

/** How many colour clusters an observation keeps. Past forty they are anti-aliasing, not palette. */
const MAX_COLOURS = 40;

/** How many styles of each kind of text an observation keeps. */
const STYLES_PER_CATEGORY = 4;

/** The least share of a kind of text a style must set to be kept beside the commonest one. */
const STYLE_SHARE = 0.04;

/** The share of spacing values a unit must divide before it is called the site's base unit. */
const BASE_UNIT_SHARE = 0.6;

/** Families a stylesheet names that are not a typeface anybody chose. */
const GENERIC_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace",
  "ui-rounded", "-apple-system", "blinkmacsystemfont", "emoji", "math", "fangsong", "inherit", "initial",
]);

/**
 * Reduces what every rendered page said into one record of the site's design as observed.
 *
 * Nothing here is judgement. Colours that look the same are counted as one, the same text style
 * seen on five pages is counted five times, and a base unit is reported only when most of the
 * spacing actually divides by it. What a colour is *for* — which grey is the border, whether the
 * orange is the primary — is left to the proposal that is written from this record, and to the
 * person who corrects it. That separation is the point of storing the two apart: this half can
 * always be checked against the site.
 *
 * @param {object} input
 * @param {string} input.host the site's host
 * @param {Array<{page: object, desktop: object|null, mobile: object|null}>} input.rendered each
 *   page with the sample it gave at each width; null where it could not be rendered
 * @returns {object} the observed record, without the asset references the caller adds
 */
export function reduceSamples({ host, rendered }) {
  const desktop = rendered.filter((entry) => entry.desktop).map((entry, index) => ({ ...entry, index, sample: entry.desktop }));
  const home = desktop[0]?.sample ?? null;
  const undetermined = [];

  // ---- colours
  const merged = new Map();
  let totalArea = 0;
  let totalText = 0;
  for (const { sample, page } of desktop) {
    for (const colour of sample.colours) {
      const entry = merged.get(colour.hex) ?? { hex: colour.hex, weight: 0, area: 0, textArea: 0, roles: {}, pages: new Set() };
      entry.area += colour.area;
      entry.textArea += colour.textArea;
      for (const [role, weight] of Object.entries(colour.roles)) entry.roles[role] = (entry.roles[role] ?? 0) + weight;
      entry.pages.add(page.url);
      merged.set(colour.hex, entry);
      totalArea += colour.area;
      totalText += colour.textArea;
    }
  }
  // One weight for ordering: a colour is as present as its larger share, of what is painted or of
  // what is written. Text is a sliver of a page's pixels and most of what a reader looks at.
  for (const entry of merged.values()) {
    entry.weight = Math.max(totalArea ? entry.area / totalArea : 0, totalText ? entry.textArea / totalText : 0);
  }
  const clusters = clusterColors([...merged.values()], {
    merge(into, from) {
      into.area += from.area;
      into.textArea += from.textArea;
      for (const [role, weight] of Object.entries(from.roles)) into.roles[role] = (into.roles[role] ?? 0) + weight;
      for (const url of from.pages) into.pages.add(url);
    },
  });
  const colors = clusters.slice(0, MAX_COLOURS).map((cluster) => ({
    hex: cluster.hex,
    oklch: hexToOklch(cluster.hex),
    share: share(cluster.area, totalArea),
    textShare: share(cluster.textArea, totalText),
    roles: Object.entries(cluster.roles)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 6)
      .map(([role]) => role),
    pages: cluster.pages.size,
    // Which pages, so a reader can go and look: a colour seen on one page is a different kind of
    // fact from one seen on all of them.
    seenOn: [...cluster.pages].slice(0, 8),
    members: cluster.members.length > 1 ? cluster.members.slice(0, 8) : undefined,
  }));

  // ---- typography
  const styles = new Map();
  for (const { sample } of desktop) {
    for (const style of sample.typography) {
      const key = [style.category, style.family, style.size, style.weight, style.lineHeight, style.letterSpacing, style.textTransform, style.color].join("|");
      const entry = styles.get(key) ?? { ...style, count: 0, characters: 0, pages: 0, probe: undefined };
      entry.count += style.count;
      entry.characters += style.characters;
      entry.pages += 1;
      entry.rendered = entry.rendered ?? style.rendered ?? null;
      styles.set(key, entry);
    }
  }
  const mobileSizes = new Map();
  for (const entry of rendered) {
    for (const style of entry.mobile?.typography ?? []) {
      const current = mobileSizes.get(style.category);
      if (!current || style.characters > current.characters) mobileSizes.set(style.category, style);
    }
  }
  const byCategory = new Map();
  for (const style of styles.values()) {
    if (!byCategory.has(style.category)) byCategory.set(style.category, []);
    byCategory.get(style.category).push(style);
  }
  const typography = [];
  for (const [category, entries] of byCategory) {
    entries.sort((left, right) => right.characters - left.characters);
    const written = entries.reduce((sum, style) => sum + style.characters, 0);
    // The commonest style always, and others only when they set a real share of that kind of
    // text: one accented word in one heading is a flourish, not a second heading style.
    const kept = entries.filter((style, index) => index === 0 || style.characters >= written * STYLE_SHARE);
    kept.slice(0, STYLES_PER_CATEGORY).forEach((style, index) => {
      const mobile = index === 0 ? mobileSizes.get(category) : null;
      typography.push({
        category,
        family: displayFamily(style.family),
        cssFamily: style.family,
        rendered: style.rendered?.family ?? null,
        size: style.size,
        weight: style.weight,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        textTransform: style.textTransform,
        italic: style.italic === true,
        color: style.color,
        marginTop: style.marginTop,
        marginBottom: style.marginBottom,
        count: style.count,
        characters: style.characters,
        pages: style.pages,
        sample: style.sample,
        mobileSize: mobile && mobile.size !== style.size ? mobile.size : null,
      });
    });
  }
  typography.sort((left, right) => categoryOrder(left.category) - categoryOrder(right.category) || right.characters - left.characters);

  // ---- fonts
  const fonts = reduceFonts({ desktop, typography, host });
  if (!fonts.families.length) undetermined.push({ field: "typography.families", reason: "No text style could be read from the rendered pages." });

  // ---- spacing
  const spacing = {};
  for (const field of ["containers", "sectionPadding", "gutters", "gaps", "margins", "paddings"]) {
    spacing[field] = sumLists(desktop.map(({ sample }) => sample.spacing[field])).slice(0, 12);
  }
  const everySpace = sumLists([spacing.sectionPadding, spacing.gutters, spacing.gaps, spacing.margins, spacing.paddings]);
  const spaceWeight = everySpace.reduce((sum, entry) => sum + entry.weight, 0);
  const divisible = (unit) => everySpace.filter((entry) => entry.value % unit === 0).reduce((sum, entry) => sum + entry.weight, 0) / (spaceWeight || 1);
  spacing.base = !spaceWeight ? null : divisible(8) >= BASE_UNIT_SHARE ? 8 : divisible(4) >= BASE_UNIT_SHARE ? 4 : null;
  spacing.scale = everySpace
    .filter((entry) => entry.weight >= spaceWeight * 0.015)
    .map((entry) => entry.value)
    .sort((left, right) => left - right)
    .slice(0, 14);
  spacing.containerMaxWidth = spacing.containers[0]?.value ?? null;
  if (spacing.base === null && spaceWeight) {
    undetermined.push({ field: "spacing.base", reason: "The spacing values seen do not share a common unit of 4 or 8 pixels." });
  }
  if (spacing.containerMaxWidth === null) {
    undetermined.push({ field: "spacing.containerMaxWidth", reason: "No centred container with a maximum width was seen." });
  }

  // ---- shape
  const kinds = new Set(desktop.flatMap(({ sample }) => Object.keys(sample.shape.radius)));
  const shape = {
    radius: Object.fromEntries([...kinds].map((kind) => [kind, sumLists(desktop.map(({ sample }) => sample.shape.radius[kind] ?? [])).slice(0, 5)])),
    borderWidths: sumLists(desktop.map(({ sample }) => sample.shape.borderWidths)).slice(0, 4),
    shadows: mergeBy(desktop.flatMap(({ sample }) => sample.shape.shadows), (shadow) => shadow.css).slice(0, 6),
  };

  // ---- components
  const withClip = (recipe, index) => {
    const { probe, ...rest } = recipe;
    return { ...rest, clip: probe ? `${index}:${probe}` : null };
  };
  const recipes = (field, keyOf, limit) =>
    mergeBy(
      desktop.flatMap(({ sample, index }) => sample.components[field].map((recipe) => withClip(recipe, index))),
      keyOf,
      (into, from) => {
        into.clip = into.clip ?? from.clip;
        into.hover = into.hover ?? from.hover;
        if (from.labels) into.labels = [...new Set([...(into.labels ?? []), ...from.labels])].slice(0, 4);
      },
    ).slice(0, limit);
  const firstWith = (field) => {
    const found = desktop.find(({ sample }) => sample.components[field]);
    return found ? withClip(found.sample.components[field], found.index) : null;
  };
  const components = {
    buttons: recipes("buttons", (button) => [button.variant, button.background, button.gradient, button.color, button.borderColor, button.radius, button.fontSize, button.fontWeight].join("|"), 6),
    inputs: recipes("inputs", (input) => [input.background, input.borderColor, input.radius, input.height].join("|"), 2),
    cards: recipes("cards", (card) => [card.background, card.borderColor, card.radius, card.shadow].join("|"), 3),
    nav: firstWith("nav"),
    footer: firstWith("footer"),
    hero: firstWith("hero"),
  };
  for (const button of components.buttons) button.fontFamily = displayFamily(button.fontFamily);
  // What colour a region's words are is read from the words, not from the region's own `color`,
  // which is only what they would inherit if nothing set one.
  const textColourOf = (role) => clusters.filter((cluster) => cluster.roles[role]).sort((left, right) => right.roles[role] - left.roles[role])[0]?.hex ?? null;
  if (components.footer) components.footer.color = textColourOf("footer-text");
  if (components.nav) components.nav.color = textColourOf("nav-text");
  if (!components.buttons.length) undetermined.push({ field: "components.button", reason: "No button was seen on the rendered pages." });
  if (!components.inputs.length) undetermined.push({ field: "components.input", reason: "No form field was seen on the rendered pages." });
  if (!components.cards.length) undetermined.push({ field: "components.card", reason: "No bordered or shadowed card was seen on the rendered pages." });
  if (!components.nav) undetermined.push({ field: "components.nav", reason: "No navigation bar was found at the top of the rendered pages." });
  if (!components.footer) undetermined.push({ field: "components.footer", reason: "No footer element was found on the rendered pages." });

  // ---- motion
  const motion = {
    durations: sumLists(desktop.map(({ sample }) => sample.motion.durations)).slice(0, 4),
    easings: sumLists(desktop.map(({ sample }) => sample.motion.easings)).slice(0, 3),
    reducedMotion: home ? home.motion.reducedMotion : null,
  };

  return {
    version: EXTRACTOR_VERSION,
    host,
    document: home
      ? {
          title: home.document.title,
          lang: home.document.lang,
          themeColor: home.document.themeColor,
          ogImage: home.document.ogImage,
          manifest: home.document.manifest,
          icons: home.document.icons,
          organizationLogo: home.document.organizationLogo,
        }
      : null,
    customProperties: home ? home.customProperties.slice(0, 120) : [],
    fonts,
    colors,
    gradients: mergeBy(desktop.flatMap(({ sample }) => sample.gradients), (gradient) => gradient.css, (into, from) => { into.area += from.area; }).slice(0, 6),
    typography,
    spacing,
    shape,
    components,
    motion,
    undetermined,
  };
}

/**
 * The typefaces a site uses, each with where it came from and what it sets.
 *
 * A build tool that self-hosts fonts renames them — `__Inter_e798ec` — and declares a metric
 * fallback beside each. The name a person knows is kept for reading, the name the stylesheet uses
 * is kept for rendering the specimen with, and the fallbacks are left out: they are an
 * implementation detail of loading, not a typeface the site chose.
 */
function reduceFonts({ desktop, typography, host }) {
  const families = new Map();
  const ensure = (cssFamily) => {
    if (!cssFamily || isFallback(cssFamily)) return null;
    const family = displayFamily(cssFamily);
    if (!families.has(family)) {
      families.set(family, { family, cssFamily, weights: new Set(), italic: false, origin: null, sourceUrl: null, generic: GENERIC_FAMILIES.has(family.toLowerCase()), usedFor: new Set(), characters: 0, rendered: null });
    }
    return families.get(family);
  };

  for (const { sample } of desktop) {
    for (const face of sample.fonts.loaded) {
      const entry = ensure(face.family);
      if (!entry) continue;
      for (const weight of String(face.weight).split(/\s+/).map(Number).filter(Number.isFinite)) entry.weights.add(weight);
      if (face.style === "italic") entry.italic = true;
      entry.origin = entry.origin ?? "web";
    }
    for (const source of sample.fonts.sources) {
      const entry = families.get(displayFamily(source.family));
      if (!entry || entry.sourceUrl || !source.url) continue;
      entry.sourceUrl = source.url.startsWith("data:") ? null : source.url;
      entry.origin = originOf(source.url, host);
    }
    for (const link of sample.fonts.links) {
      const origin = originOf(link, host);
      for (const match of link.matchAll(/family=([^&:]+)/g)) {
        const entry = families.get(decodeURIComponent(match[1]).replace(/\+/g, " "));
        if (entry && (!entry.origin || entry.origin === "web")) entry.origin = origin;
      }
    }
  }
  for (const style of typography) {
    const entry = ensure(style.cssFamily);
    if (!entry) continue;
    entry.usedFor.add(style.category);
    entry.characters += style.characters;
    entry.weights.add(style.weight);
    entry.rendered = entry.rendered ?? style.rendered;
    if (!entry.origin) entry.origin = entry.generic ? "system" : "local";
  }

  return {
    body: (desktop[0]?.sample.fonts.body ?? []).filter((family) => !isFallback(family)).map(displayFamily),
    families: [...families.values()]
      .filter((entry) => entry.usedFor.size > 0)
      .sort((left, right) => right.characters - left.characters)
      .slice(0, 8)
      .map((entry) => ({
        family: entry.family,
        cssFamily: entry.cssFamily,
        rendered: entry.rendered,
        origin: entry.origin,
        sourceUrl: entry.sourceUrl,
        weights: [...entry.weights].sort((left, right) => left - right).slice(0, 12),
        italic: entry.italic,
        usedFor: [...entry.usedFor],
        characters: entry.characters,
      })),
  };
}

/** Where a font file was served from, in the terms a person choosing a font thinks in. */
function originOf(url, host) {
  let name = "";
  try {
    name = new URL(url).hostname;
  } catch {
    return "other";
  }
  if (name === host || name.endsWith(`.${host}`) || host.endsWith(`.${name}`)) return "self-hosted";
  if (/(^|\.)(gstatic|googleapis)\.com$/.test(name)) return "google-fonts";
  if (/(^|\.)typekit\.net$/.test(name)) return "adobe-fonts";
  if (/(^|\.)bunny\.net$/.test(name)) return "bunny-fonts";
  return "other";
}

/** Whether a family is the metric fallback a build tool declares beside the real one. */
function isFallback(family) {
  return /_Fallback_[0-9a-f]{6}$/i.test(family) || / Fallback$/i.test(family);
}

/** A family's name as a person knows it: `__IBM_Plex_Sans_c8daab` is IBM Plex Sans. */
export function displayFamily(family) {
  if (!family) return family ?? null;
  const built = /^__(.+?)_[0-9a-f]{6}$/i.exec(family);
  return built ? built[1].replace(/_/g, " ") : family;
}

/** A part as a share of a whole, to three decimals; zero when there is no whole. */
function share(part, whole) {
  return whole ? Math.round((part / whole) * 1000) / 1000 : 0;
}

/** Adds up lists of `{value, weight}`, heaviest first. */
function sumLists(lists) {
  const totals = new Map();
  for (const list of lists) {
    for (const entry of list ?? []) totals.set(entry.value, (totals.get(entry.value) ?? 0) + entry.weight);
  }
  return [...totals.entries()].map(([value, weight]) => ({ value, weight })).sort((left, right) => right.weight - left.weight || String(left.value).localeCompare(String(right.value)));
}

/** Merges entries that share a key, adding their counts, most counted first. */
function mergeBy(entries, keyOf, fold = () => {}) {
  const merged = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...entry });
      continue;
    }
    if (typeof entry.count === "number") current.count = (current.count ?? 0) + entry.count;
    fold(current, entry);
  }
  return [...merged.values()].sort((left, right) => (right.count ?? right.area ?? 0) - (left.count ?? left.area ?? 0));
}

/** Where a kind of text sorts in a listing: headings in order, then running text, then the rest. */
function categoryOrder(category) {
  const order = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "text", "li", "a", "nav-link", "button", "input", "label", "small", "blockquote"];
  const index = order.indexOf(category);
  return index === -1 ? order.length : index;
}
