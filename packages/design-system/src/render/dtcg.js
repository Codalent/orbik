import { hexToRgb } from "../color.js";
import { resolveTokens } from "./tokens.js";

/** Where Orbik's own notes about a token go, so a tool that does not know them can ignore them. */
const EXTENSION = "app.orbik";

/** A length as the format writes one. */
const dimension = (value, unit = "px") => ({ value, unit });

/** A colour as the format writes one: its space, its channels from 0 to 1, and the hex beside it. */
function color(hex) {
  const { r, g, b } = hexToRgb(hex);
  const channel = (value) => Math.round((value / 255) * 10000) / 10000;
  return { colorSpace: "srgb", components: [channel(r), channel(g), channel(b)], hex };
}

/**
 * One layer of a CSS box-shadow as the format's shadow object, or null when it cannot be read.
 *
 * Accepts the two orders a shadow arrives in: as a stylesheet writes it, colour last, and as a
 * browser reports it, colour first. A layer with a colour that is not hex or `rgb()` is not
 * guessed at: the token is left out and the raw value is kept in the extension instead.
 */
function shadowLayer(layer) {
  const text = layer.trim();
  const inset = /\binset\b/.test(text);
  const colourMatch = /(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i.exec(text);
  const lengths = text.replace(colourMatch?.[0] ?? "", "").replace(/\binset\b/, "").trim().split(/\s+/).map((part) => Number.parseFloat(part));
  if (!colourMatch || lengths.length < 2 || lengths.some((value) => !Number.isFinite(value))) return null;
  let value = null;
  const rgba = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+%?))?\s*\)/i.exec(colourMatch[0]);
  if (rgba) {
    const alpha = rgba[4] === undefined ? 1 : rgba[4].endsWith("%") ? Number.parseFloat(rgba[4]) / 100 : Number.parseFloat(rgba[4]);
    value = { colorSpace: "srgb", components: [rgba[1], rgba[2], rgba[3]].map((part) => Math.round((Number(part) / 255) * 10000) / 10000), alpha };
  } else if (/^#[0-9a-f]{6}$/i.test(colourMatch[0])) {
    value = color(colourMatch[0].toLowerCase());
  }
  if (!value) return null;
  const [offsetX, offsetY, blur = 0, spread = 0] = lengths;
  return { color: value, offsetX: dimension(offsetX), offsetY: dimension(offsetY), blur: dimension(blur), spread: dimension(spread), ...(inset ? { inset: true } : {}) };
}

/**
 * Writes a design system out as design tokens in the Design Tokens Community Group format.
 *
 * The interchange form: what a token pipeline, a design tool's importer or another model's tool
 * reads. Colours, lengths, families, weights, composite type styles and shadows use the format's
 * own types, so they arrive as tokens rather than as strings somebody has to parse again. Each
 * token carries, in an extension a consumer is free to ignore, the one thing the format has no
 * field for and this system is built around: where the value came from.
 *
 * @param {object} options
 * @param {object} options.system the effective system, pins applied
 * @param {string} options.host the site it was derived from
 * @returns {string} the tokens, as JSON
 */
export function renderDtcg({ system, host }) {
  const tokens = resolveTokens(system);
  const noted = (source, extra = {}) => ({ $extensions: { [EXTENSION]: { source, ...extra } } });
  const document = {
    $description: `Design tokens for ${host}, derived by Orbik from the site as rendered. Each token's source is observed, derived, proposed or pinned.`,
    color: Object.fromEntries(tokens.colors.map((entry) => [entry.name, { $type: "color", $value: color(entry.value), ...(entry.usage ? { $description: entry.usage } : {}), ...noted(entry.source) }])),
    font: {
      family: Object.fromEntries(tokens.fonts.map((font) => [font.role, { $type: "fontFamily", $value: [font.family, ...(system.typography.families[font.role].fallbacks ?? [])], ...noted(font.source) }])),
      weight: Object.fromEntries(
        [...new Set(tokens.fonts.flatMap((font) => font.weights))].sort((left, right) => left - right).map((weight) => [String(weight), { $type: "fontWeight", $value: weight }]),
      ),
    },
    typography: Object.fromEntries(tokens.type.map((step) => [
      step.name,
      {
        $type: "typography",
        $value: {
          fontFamily: `{font.family.${step.family}}`,
          fontSize: dimension(step.px),
          fontWeight: step.weight,
          letterSpacing: dimension(step.letterSpacing ?? 0, "em"),
          lineHeight: step.lineHeight,
        },
        ...(step.usedFor ? { $description: step.usedFor } : {}),
        ...noted(step.source),
      },
    ])),
    space: {
      ...(tokens.spacing.base !== null ? { unit: { $type: "dimension", $value: dimension(tokens.spacing.base), ...noted(system.spacing.base.source) } } : {}),
      ...Object.fromEntries(tokens.spacing.scale.map((step) => [String(step).replace(".", "_"), { $type: "dimension", $value: dimension(step) }])),
    },
    size: {
      ...(tokens.spacing.containerMaxWidth !== null ? { container: { $type: "dimension", $value: dimension(tokens.spacing.containerMaxWidth), ...noted(system.spacing.containerMaxWidth.source) } } : {}),
      ...(tokens.spacing.sectionPadding !== null ? { "section-padding": { $type: "dimension", $value: dimension(tokens.spacing.sectionPadding), ...noted(system.spacing.sectionPadding.source) } } : {}),
    },
    radius: Object.fromEntries(tokens.radius.map((radius) => [radius.token, { $type: "dimension", $value: dimension(radius.px), ...noted(radius.source) }])),
    border: tokens.borderWidth !== null ? { width: { $type: "dimension", $value: dimension(tokens.borderWidth), ...noted(system.shape.borderWidth.source) } } : {},
    shadow: {},
  };
  for (const shadow of tokens.shadows) {
    const layers = shadow.value.split(/,(?![^(]*\))/).map(shadowLayer);
    // A shadow that could not be read layer by layer is not turned into something approximate:
    // it is recorded as written, outside the token tree, for whoever needs it.
    if (layers.some((layer) => layer === null)) {
      document.$extensions = { [EXTENSION]: { ...(document.$extensions?.[EXTENSION] ?? {}), [`shadow.${shadow.token}`]: shadow.value } };
      continue;
    }
    document.shadow[shadow.token] = { $type: "shadow", $value: layers.length === 1 ? layers[0] : layers, ...noted(shadow.source, { css: shadow.value }) };
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}
