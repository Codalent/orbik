import { BRAND_ASSET_KINDS } from "@orbik/core";

import { removeSheet, renderSheet } from "./inPage.js";

/** The tallest sheet photographed, in pixels. A longer one is cut rather than refused. */
const MAX_SHEET_HEIGHT = 5000;

/** The sentence type is shown in: every letter of the alphabet, at a length a line of copy has. */
const PANGRAM = "The quick brown fox jumps over the lazy dog";

/** How many colours the swatch sheet shows. */
const MAX_SWATCHES = 24;

/** The kinds of text the specimen shows, in the order a type scale is read. */
const SPECIMEN_CATEGORIES = Object.freeze(["h1", "h2", "h3", "h4", "p", "text", "small", "nav-link", "button"]);

/** The largest size type is shown at on the specimen; a 96px hero heading would be most of a sheet. */
const MAX_SPECIMEN_SIZE = 64;

/**
 * Draws the type specimen and the swatch sheet on the site's own page, and photographs them.
 *
 * Called as the `work` of a render of the home page, after the observations are reduced: the
 * sheets show what was *observed*, in the site's own fonts, before any model has had a say.
 *
 * @param {object} page the settled puppeteer page
 * @param {object} observed the reduced observation
 * @returns {Promise<Array<{kind: string, buffer: Buffer, width: number, height: number, label: string}>>}
 */
export async function captureSheets(page, observed) {
  const sheets = [];
  const families = observed.fonts.families.filter((family) => family.origin !== "system").slice(0, 4);
  const styles = SPECIMEN_CATEGORIES
    .map((category) => observed.typography.find((style) => style.category === category))
    .filter(Boolean);

  if (families.length || styles.length) {
    const blocks = [
      ...families.map((family) => ({
        type: "family",
        label: `${family.family} · ${describeOrigin(family.origin)} · used for ${family.usedFor.slice(0, 5).join(", ")}`,
        name: family.family,
        css: cssFamily(family.cssFamily),
        weights: family.weights.length ? family.weights.slice(0, 6) : [400],
        // The name is set at the weight nearest regular: a family that also loads a hairline
        // weight should not be introduced in it.
        nameWeight: nearest(family.weights, 400),
      })),
      ...styles.map((style) => ({
        type: "type",
        label: `${style.category} · ${style.family ?? "unknown"} · ${style.size}px / ${style.lineHeight ?? "normal"} · ${style.weight}`,
        css: cssFamily(style.cssFamily),
        size: Math.min(style.size, MAX_SPECIMEN_SIZE),
        weight: style.weight,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        textTransform: style.textTransform,
        sample: PANGRAM,
      })),
    ];
    const shot = await photograph(page, { title: `Type specimen · ${observed.host}`, subtitle: "The site's own fonts at the sizes it sets them, as rendered.", blocks });
    if (shot) sheets.push({ kind: BRAND_ASSET_KINDS.specimen, label: "Type specimen", ...shot });
  }

  const swatches = observed.colors.slice(0, MAX_SWATCHES).map((colour) => ({
    hex: colour.hex,
    note: [
      colour.share >= 0.001 ? `${percent(colour.share)} of painted area` : null,
      colour.textShare >= 0.001 ? `${percent(colour.textShare)} of text` : null,
      colour.roles.slice(0, 3).join(", "),
    ].filter(Boolean).join(" · "),
  }));
  if (swatches.length) {
    const shot = await photograph(page, { title: `Observed colours · ${observed.host}`, subtitle: "Every colour the rendered pages paint, most used first. Near-identical colours are shown once.", blocks: [{ type: "swatches", swatches }] });
    if (shot) sheets.push({ kind: BRAND_ASSET_KINDS.swatches, label: "Observed colours", ...shot });
  }
  return sheets;
}

/**
 * Lays the harvested imagery out on one sheet and photographs it.
 *
 * This is what the graphics-language call is shown: one image rather than thirty-six, each cell
 * numbered so the answer can say which pictures it means. Drawn on a blank tab from bytes the
 * worker holds, so no site's script is near it.
 *
 * @param {object} page a blank tab of Orbik's own
 * @param {object} options
 * @param {string} options.host the site's host, for the title
 * @param {Array<{number: number, kind: string, dataUrl: string, width: number|null, height: number|null, background?: string}>} options.cells
 * @returns {Promise<{kind: string, buffer: Buffer, width: number, height: number, label: string}|null>}
 */
export async function captureContactSheet(page, { host, cells }) {
  if (!cells.length) return null;
  const shot = await photograph(page, {
    title: `Imagery · ${host}`,
    subtitle: "The site's own images, icons and logos as harvested. Numbers are how each is referred to.",
    width: 1280,
    blocks: [{
      type: "images",
      columns: 5,
      cellHeight: 190,
      cells: cells.map((cell) => ({
        src: cell.dataUrl,
        background: cell.background,
        caption: `#${cell.number} · ${cell.kind}${cell.width && cell.height ? ` · ${cell.width}×${cell.height}` : ""}`,
      })),
    }],
  });
  return shot ? { kind: BRAND_ASSET_KINDS.contactSheet, label: "Contact sheet", ...shot } : null;
}

/** Draws one sheet, photographs it and takes it down again. */
async function photograph(page, sheet) {
  try {
    const box = await page.evaluate(renderSheet, sheet);
    if (!box?.width || !box?.height) return null;
    const clip = { x: 0, y: 0, width: box.width, height: Math.min(box.height, MAX_SHEET_HEIGHT) };
    const buffer = await page.screenshot({ type: "webp", quality: 88, captureBeyondViewport: true, clip });
    return { buffer, width: clip.width, height: clip.height };
  } catch {
    return null;
  } finally {
    await page.evaluate(removeSheet).catch(() => {});
  }
}

/** The value of a list nearest a target, or the target when the list is empty. */
function nearest(values, target) {
  return values.reduce((best, value) => (Math.abs(value - target) < Math.abs(best - target) ? value : best), values[0] ?? target);
}

/** A family as the `font-family` value that selects it on the page it was read from. */
function cssFamily(family) {
  return family ? `"${String(family).replace(/["\\]/g, "")}", sans-serif` : "sans-serif";
}

/** Where a font comes from, in a few words for a label. */
function describeOrigin(origin) {
  return { "self-hosted": "self-hosted", "google-fonts": "Google Fonts", "adobe-fonts": "Adobe Fonts", "bunny-fonts": "Bunny Fonts", local: "installed font", web: "web font" }[origin] ?? "web font";
}

/** A share as a percentage a person reads at a glance. */
function percent(value) {
  const amount = value * 100;
  return amount >= 10 ? `${Math.round(amount)}%` : `${Math.round(amount * 10) / 10}%`;
}
