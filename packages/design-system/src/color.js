/**
 * Colour arithmetic for the design system: one colour space to compare in, and the one contrast
 * formula accessibility is judged by.
 *
 * Colours arrive here as `#rrggbb`. The sampler that runs in Chrome resolves whatever a site wrote
 * — `oklch()`, `color-mix()`, a named colour — to sRGB on a canvas before anything leaves the
 * page, so nothing in Node has to parse CSS colour syntax, and "the colour" always means the one
 * that was painted.
 *
 * Differences are measured in OKLab, because that is the space in which equal distances look
 * equally different: fourteen greys that differ by a rounding error in a stylesheet are one grey
 * to the eye, and a clustering done in RGB would keep some of them apart and merge a blue into a
 * purple. Distances are scaled by 100 so the familiar threshold reads the familiar way: under 2
 * is a difference nobody sees.
 */

/** Matches a six-digit hexadecimal colour, with its hash. */
const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

/** Whether a value is a colour in the one form this module takes. */
export function isHexColor(value) {
  return typeof value === "string" && HEX_PATTERN.test(value);
}

/**
 * Brings a colour a person or a model wrote to the one form everything compares in.
 *
 * Accepts `#abc`, `#aabbcc` and either without the hash, in any case; returns null for anything
 * else rather than guessing, because a guessed colour stored as somebody's pinned primary is worse
 * than a refused one.
 *
 * @param {unknown} value the colour as written
 * @returns {string|null} `#rrggbb` in lower case, or null
 */
export function normalizeHex(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(text)) return `#${[...text].map((digit) => digit + digit).join("")}`;
  if (/^[0-9a-f]{6}$/.test(text)) return `#${text}`;
  return null;
}

/** The three sRGB channels of a colour, 0–255. */
export function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

/** One sRGB channel, 0–255, as linear light. */
function linear(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/**
 * A colour in OKLab: lightness, and two axes of colour.
 *
 * @param {string} hex `#rrggbb`
 * @returns {{l: number, a: number, b: number}}
 */
export function hexToOklab(hex) {
  const { r, g, b } = hexToRgb(hex);
  const red = linear(r);
  const green = linear(g);
  const blue = linear(b);
  const long = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const medium = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const short = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return {
    l: 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    a: 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
    b: 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short,
  };
}

/**
 * A colour in OKLCH — lightness, chroma, hue — rounded the way a stylesheet writes it.
 *
 * @param {string} hex `#rrggbb`
 * @returns {{l: number, c: number, h: number}} `l` 0–1, `c` from 0, `h` in degrees
 */
export function hexToOklch(hex) {
  const { l, a, b } = hexToOklab(hex);
  const chroma = Math.hypot(a, b);
  // A grey has no hue; reporting whatever the arithmetic left over would look like information.
  const hue = chroma < 0.002 ? 0 : (Math.atan2(b, a) * 180) / Math.PI;
  return {
    l: Math.round(l * 1000) / 1000,
    c: Math.round(chroma * 1000) / 1000,
    h: Math.round(((hue + 360) % 360) * 10) / 10,
  };
}

/** A colour as the `oklch()` a stylesheet would carry. */
export function formatOklch(hex) {
  const { l, c, h } = hexToOklch(hex);
  return `oklch(${l} ${c} ${h})`;
}

/**
 * How different two colours look, on a scale where under 2 is not noticeable.
 *
 * @param {string} left `#rrggbb`
 * @param {string} right `#rrggbb`
 */
export function colorDistance(left, right) {
  const first = hexToOklab(left);
  const second = hexToOklab(right);
  return Math.hypot(first.l - second.l, first.a - second.a, first.b - second.b) * 100;
}

/** The relative luminance WCAG defines, 0 for black through 1 for white. */
export function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * The WCAG contrast ratio of two colours, from 1 (identical) to 21 (black on white).
 *
 * @param {string} left `#rrggbb`
 * @param {string} right `#rrggbb`
 * @returns {number} rounded to two decimals
 */
export function contrastRatio(left, right) {
  const first = relativeLuminance(left);
  const second = relativeLuminance(right);
  const ratio = (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  return Math.round(ratio * 100) / 100;
}

/**
 * What a contrast ratio is good for, in WCAG's own words.
 *
 * @param {number} ratio from {@link contrastRatio}
 * @returns {"AAA"|"AA"|"AA-large"|"fail"} `AA-large` passes only for large or bold text
 */
export function contrastGrade(ratio) {
  if (ratio >= 7) return "AAA";
  if (ratio >= 4.5) return "AA";
  if (ratio >= 3) return "AA-large";
  return "fail";
}

/**
 * Collapses colours that look the same into one, keeping how much each was used.
 *
 * Greedy and ordered by weight, on purpose: the colour a site paints the most of becomes the
 * centre of its cluster, so the value reported is one the site actually uses rather than an
 * average nobody wrote. Two properties follow — the result is the same on every run over the same
 * input, and no reported colour is invented.
 *
 * @template {{hex: string, weight: number}} Entry
 * @param {Entry[]} colours what was seen, each with how much it counts
 * @param {object} [options]
 * @param {number} [options.threshold] the distance under which two colours are one
 * @param {(into: Entry, from: Entry) => void} [options.merge] folds one entry's detail into the
 *   cluster it joined; the weights are added here
 * @returns {Array<Entry & {members: string[]}>} clusters, heaviest first
 */
export function clusterColors(colours, { threshold = 2, merge = () => {} } = {}) {
  const ordered = [...colours].sort((left, right) => right.weight - left.weight || left.hex.localeCompare(right.hex));
  const clusters = [];
  for (const colour of ordered) {
    const home = clusters.find((cluster) => colorDistance(cluster.hex, colour.hex) < threshold);
    if (!home) {
      clusters.push({ ...colour, members: [colour.hex] });
      continue;
    }
    home.weight += colour.weight;
    if (!home.members.includes(colour.hex)) home.members.push(colour.hex);
    merge(home, colour);
  }
  return clusters.sort((left, right) => right.weight - left.weight || left.hex.localeCompare(right.hex));
}
