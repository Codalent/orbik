/**
 * The shape of a design system as the Design system agent proposes one.
 *
 * Two things are defined here, and they are two views of one contract. The **schemas** are what a
 * model is asked to answer in: strict JSON Schema, every property required and every optional one
 * nullable, because that is the form in which a provider will guarantee a reply's shape. The
 * **parsers** are what the worker runs on the reply before anything is stored: a schema can say
 * "a string" but not "a colour", and a stored system is read by the API, by people's own AIs and
 * by a stylesheet generator, none of which should have to wonder.
 *
 * The one rule that shapes all of it is **provenance**. Every value carries where it came from —
 * {@link VALUE_SOURCES} — because a system derived from a website is partly what the site does,
 * partly a tidying of what it does, and partly an invention to fill a gap, and a reader who cannot
 * tell which is which can trust none of it. What could not be determined is null and is listed
 * with its reason; it is never filled with a plausible default.
 *
 * Like the rest of this package it has no dependencies.
 */
import { ProtocolError } from "./validate.js";

/**
 * Where a value in a proposed system came from.
 *
 * A fourth value, `pinned`, exists on a *stored* system for a value a person set by hand. A model
 * is never offered it: it is not something an agent can claim.
 */
export const VALUE_SOURCES = Object.freeze({
  /** Seen on the site as it is. */
  observed: "observed",
  /** Normalised from several observed values: fourteen greys become four. */
  derived: "derived",
  /** Invented to fill a gap the site leaves, such as an error colour it never shows. */
  proposed: "proposed",
});

/** Every source a model may claim, as an array. */
export const VALUE_SOURCE_VALUES = Object.freeze(Object.values(VALUE_SOURCES));

/** The source of a value a person pinned. */
export const PINNED_SOURCE = "pinned";

/** The colour roles of a system, in the order they are listed. The first eight are always present. */
export const COLOR_ROLES = Object.freeze([
  "primary", "background", "surface", "text", "textMuted", "border", "link",
  "secondary", "accent", "success", "warning", "error",
]);

/** The colour roles a system must have: without them nothing can be styled at all. */
export const REQUIRED_COLOR_ROLES = Object.freeze(["primary", "background", "surface", "text", "textMuted", "border", "link"]);

/** The roles a typeface can play. */
export const FONT_ROLES = Object.freeze(["heading", "body", "mono"]);

/** The steps of a type scale, largest first. `h1`, `h2`, `h3` and `body` are always present. */
export const TYPE_TOKENS = Object.freeze(["display", "h1", "h2", "h3", "h4", "bodyLarge", "body", "small", "caption", "button", "label"]);

/** The steps a type scale must have. */
export const REQUIRED_TYPE_TOKENS = Object.freeze(["h1", "h2", "h3", "body"]);

/** The radius tokens, smallest first, and `none` and `pill` for the two ends. */
export const RADIUS_TOKENS = Object.freeze(["sm", "md", "lg", "pill"]);

/** What a component recipe may name as its radius. */
const RADIUS_CHOICES = Object.freeze(["none", ...RADIUS_TOKENS]);

/** The shadow tokens, smallest first. */
export const SHADOW_TOKENS = Object.freeze(["sm", "md", "lg"]);

/** What a component recipe may name as its shadow. */
const SHADOW_CHOICES = Object.freeze(["none", ...SHADOW_TOKENS]);

/** The button variants a system describes. */
export const BUTTON_VARIANTS = Object.freeze(["primary", "secondary", "ghost"]);

/** What a site's imagery is made of. */
export const GRAPHICS_MEDIA = Object.freeze(["flat-vector", "line", "isometric", "3d", "photography", "screenshots", "mixed", "none"]);

/** What one harvested image turns out to be, once somebody has looked at it. */
export const IMAGE_VERDICT_KINDS = Object.freeze(["photo", "illustration", "icon", "logo", "screenshot", "other"]);

/** Bounds applied to what a model wrote, so one runaway field cannot swell a stored system. */
const LIMITS = Object.freeze({ short: 120, usage: 240, sentence: 400, paragraph: 1200, rule: 240, rules: 12, adjectives: 8, list: 12, undetermined: 30 });

// -------------------------------------------------------------------------------------------------
// Schema building blocks. Strict structured output wants every property required and every object
// closed, so "optional" is spelled "or null" throughout.

const source = { type: "string", enum: [...VALUE_SOURCE_VALUES] };
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const closed = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const text = (description) => ({ type: "string", description });
const strings = (description) => ({ type: "array", items: { type: "string" }, description });
const colourRef =
  'A colour: one of the role names (primary, secondary, accent, background, surface, text, textMuted, border, link), "transparent", or a literal "#rrggbb".';

const DEFS = Object.freeze({
  color: closed({
    value: text('The colour as "#rrggbb".'),
    source,
    observedFrom: strings("The observed colours this was taken or normalised from, as #rrggbb. Empty for a proposed colour."),
    usage: text("One sentence: what this colour is for, and what it is not for."),
  }),
  family: closed({
    family: text("The typeface's name, exactly as observed."),
    fallbacks: strings("Fallback families, most similar first, ending in a generic such as sans-serif."),
    weights: { type: "array", items: { type: "integer" }, description: "The weights the system uses, e.g. 400, 500, 700." },
    source,
  }),
  step: closed({
    px: { type: "number", description: "Font size in pixels at desktop width." },
    lineHeight: { type: "number", description: "Unitless line height, e.g. 1.2." },
    weight: { type: "integer" },
    letterSpacing: { type: "number", description: "In em; 0 for none." },
    family: { type: "string", enum: [...FONT_ROLES], description: "Which family role sets it." },
    usedFor: text("What this step is used for."),
    source,
  }),
  number: closed({ value: { type: "number" }, source }),
  optionalNumber: closed({ value: nullable({ type: "number" }), source }),
  numbers: closed({ value: { type: "array", items: { type: "number" } }, source }),
  shadow: closed({ value: nullable(text("A CSS box-shadow value, or null when the system has no shadow at this size.")), source }),
  button: closed({
    background: text(colourRef),
    color: text(colourRef),
    borderColor: nullable(text(colourRef)),
    borderWidth: { type: "number" },
    radius: { type: "string", enum: [...RADIUS_CHOICES] },
    paddingX: { type: "number" },
    paddingY: { type: "number" },
    fontSize: { type: "number" },
    fontWeight: { type: "integer" },
    textTransform: { type: "string", enum: ["none", "uppercase", "capitalize"] },
    shadow: { type: "string", enum: [...SHADOW_CHOICES] },
    hoverBackground: nullable(text(colourRef)),
    hoverColor: nullable(text(colourRef)),
    source,
    notes: text("One sentence on when this variant is used."),
  }),
  input: closed({
    background: text(colourRef),
    color: text(colourRef),
    borderColor: nullable(text(colourRef)),
    borderWidth: { type: "number" },
    radius: { type: "string", enum: [...RADIUS_CHOICES] },
    paddingX: { type: "number" },
    paddingY: { type: "number" },
    fontSize: { type: "number" },
    source,
    notes: text("One sentence."),
  }),
  card: closed({
    background: text(colourRef),
    borderColor: nullable(text(colourRef)),
    borderWidth: { type: "number" },
    radius: { type: "string", enum: [...RADIUS_CHOICES] },
    padding: { type: "number" },
    shadow: { type: "string", enum: [...SHADOW_CHOICES] },
    source,
    notes: text("One sentence."),
  }),
  nav: closed({
    background: text(colourRef),
    color: text(colourRef),
    height: { type: "number" },
    radius: { type: "string", enum: [...RADIUS_CHOICES] },
    borderColor: nullable(text(colourRef)),
    shadow: { type: "string", enum: [...SHADOW_CHOICES] },
    style: text("How the bar behaves and sits: full-width or floating, sticky or static, solid or blurred."),
    source,
    notes: text("One sentence."),
  }),
  footer: closed({
    background: text(colourRef),
    color: text(colourRef),
    columns: nullable({ type: "integer" }),
    source,
    notes: text("One sentence."),
  }),
});

const ref = (name) => ({ $ref: `#/$defs/${name}` });
const optional = (name) => nullable(ref(name));

/**
 * The first answer: the visual system.
 *
 * Colours by role, typefaces and a scale, spacing, shape, and the components as recipes over those
 * tokens — each value with its source.
 */
export const VISUAL_SYSTEM_FORMAT = Object.freeze({
  name: "visual_system",
  schema: {
    ...closed({
      colors: closed(Object.fromEntries(COLOR_ROLES.map((role) => [role, REQUIRED_COLOR_ROLES.includes(role) ? ref("color") : optional("color")]))),
      typography: closed({
        families: closed({ heading: ref("family"), body: ref("family"), mono: optional("family") }),
        scale: closed(Object.fromEntries(TYPE_TOKENS.map((token) => [token, REQUIRED_TYPE_TOKENS.includes(token) ? ref("step") : optional("step")]))),
        rules: strings("Three to six rules for setting type in this system, each one sentence."),
      }),
      spacing: closed({
        base: ref("number"),
        scale: ref("numbers"),
        containerMaxWidth: ref("optionalNumber"),
        sectionPadding: ref("optionalNumber"),
      }),
      shape: closed({
        radius: closed(Object.fromEntries(RADIUS_TOKENS.map((token) => [token, ref("number")]))),
        borderWidth: ref("number"),
        shadows: closed(Object.fromEntries(SHADOW_TOKENS.map((token) => [token, ref("shadow")]))),
      }),
      components: closed({
        button: closed(Object.fromEntries(BUTTON_VARIANTS.map((variant) => [variant, optional("button")]))),
        input: optional("input"),
        card: optional("card"),
        nav: optional("nav"),
        footer: optional("footer"),
      }),
      personality: closed({
        summary: text("One sentence on how this brand looks and feels."),
        adjectives: strings("Three to six adjectives."),
      }),
      rules: strings("Five to ten rules for using the system, each one sentence a designer or a model can follow."),
      undetermined: {
        type: "array",
        description: "Everything you could not determine, each with why. Never fill such a field with a guess.",
        items: closed({ field: text('The field, e.g. "colors.error" or "components.input".'), reason: text("Why it could not be determined.") }),
      },
    }),
    $defs: DEFS,
  },
});

/**
 * The second answer: the graphics language.
 *
 * What the site's imagery is like, a verdict on each harvested image, and what to tell an image
 * model so that it draws in the same style.
 */
export const GRAPHICS_LANGUAGE_FORMAT = Object.freeze({
  name: "graphics_language",
  schema: closed({
    graphics: closed({
      medium: { type: "string", enum: [...GRAPHICS_MEDIA], description: "What the brand's own imagery is mostly made of." },
      description: text("Two to four sentences describing the visual language so a designer could continue it."),
      subjects: nullable(text("What the imagery depicts.")),
      paletteUsage: nullable(text("How colour is used in the imagery, naming the brand's colours.")),
      strokeAndShading: nullable(text("Line weight, outlines, fills, gradients, shadows.")),
      perspective: nullable(text("Flat, isometric, three-quarter, straight-on.")),
      composition: nullable(text("Framing, density, negative space, backgrounds.")),
      peopleDepiction: nullable(text("How people are shown, or that they are not.")),
      texture: nullable(text("Grain, noise, paper, or clean and flat.")),
      mood: nullable(text("The feeling the imagery gives.")),
      iconography: nullable(closed({
        style: text("Outline, solid, duotone; and the family it resembles if recognisable."),
        strokeWeight: nullable(text("e.g. 1.5px on a 24px grid.")),
        corner: nullable(text("Rounded or square joins and caps.")),
        fill: nullable(text("How fill and colour are used.")),
      })),
      logo: nullable(closed({
        description: text("What the logo is: its form, typeface if it is set in type, colour."),
        usage: strings("Up to four rules for using it."),
      })),
      doNot: strings("Up to six things that would be off-brand in an image."),
    }),
    images: {
      type: "array",
      description: "One entry per numbered image on the contact sheet.",
      items: closed({
        number: { type: "integer" },
        caption: text("One line saying what the image shows and how it is drawn."),
        belongs: { type: "boolean", description: "False when it is not this brand's own imagery: another company's logo, a stock badge, a person's avatar, a screenshot of somebody else's product." },
        kind: { type: "string", enum: [...IMAGE_VERDICT_KINDS] },
      }),
    },
    imagePrompt: closed({
      stylePrefix: text("A paragraph to put before any image prompt so the result is in this brand's style. Concrete: medium, line, colour by hex, composition, mood."),
      negative: text("What to tell the image model to avoid."),
      referenceImages: { type: "array", items: { type: "integer" }, description: "Three to five image numbers that best show the brand's own style, for use as reference images. Never one whose `belongs` is false." },
    }),
  }),
});

// -------------------------------------------------------------------------------------------------
// Parsers.

/** Fails a reply that cannot be made into a stored system. */
function invalid(message) {
  return new ProtocolError({ code: "INVALID_DESIGN_SYSTEM", errors: [message] });
}

/** A string, trimmed and clipped; empty when it was not one. */
function clip(value, max) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** A list of strings, each clipped, empties dropped. */
function clipList(value, max, each) {
  return (Array.isArray(value) ? value : []).map((entry) => clip(entry, each)).filter(Boolean).slice(0, max);
}

/** A source a model may claim; anything else is read as the weakest claim. */
function sourceOf(value) {
  return VALUE_SOURCE_VALUES.includes(value) ? value : VALUE_SOURCES.proposed;
}

/** A colour as `#rrggbb`, or null when it is not one. */
function hexOf(value) {
  if (typeof value !== "string") return null;
  const digits = value.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(digits)) return `#${[...digits].map((digit) => digit + digit).join("")}`;
  return /^[0-9a-f]{6}$/.test(digits) ? `#${digits}` : null;
}

/** A finite number inside bounds, or null. */
function numberIn(value, min, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? Math.round(value * 1000) / 1000 : null;
}

/** What a recipe names as a colour: a role, `transparent`, or a literal; null when it is none of those. */
function colourRefOf(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (name === "transparent" || COLOR_ROLES.includes(name)) return name;
  return hexOf(name);
}

/** One of a fixed set of choices, or the fallback. */
function choiceOf(value, choices, fallback) {
  return choices.includes(value) ? value : fallback;
}

/** A CSS shadow that is only a shadow: nothing that could close a declaration or load a resource. */
export function safeShadow(value) {
  if (typeof value !== "string") return null;
  const shadow = value.replace(/\s+/g, " ").trim().slice(0, 240);
  if (!shadow || shadow.toLowerCase() === "none") return null;
  return /^[\w\s.,%()#/+-]+$/.test(shadow) && !/url\s*\(|expression|var\s*\(/i.test(shadow) ? shadow : null;
}

/** One component recipe's fields, each read by its own kind. */
function recipeOf(value, fields) {
  if (!value || typeof value !== "object") return null;
  const recipe = {};
  for (const [field, kind] of Object.entries(fields)) {
    const raw = value[field];
    if (kind === "colour") recipe[field] = colourRefOf(raw);
    else if (kind === "px") recipe[field] = numberIn(raw, 0, 400) ?? 0;
    else if (kind === "weight") recipe[field] = numberIn(raw, 100, 900) ?? 400;
    else if (kind === "radius") recipe[field] = choiceOf(raw, RADIUS_CHOICES, "md");
    else if (kind === "shadow") recipe[field] = choiceOf(raw, SHADOW_CHOICES, "none");
    else if (kind === "transform") recipe[field] = choiceOf(raw, ["none", "uppercase", "capitalize"], "none");
    else if (kind === "columns") recipe[field] = numberIn(raw, 1, 12);
    else recipe[field] = clip(raw, LIMITS.usage);
  }
  // A recipe with nothing to paint with is not one; the component is reported undetermined instead.
  if ("background" in fields && recipe.background === null) return null;
  recipe.source = sourceOf(value.source);
  recipe.notes = clip(value.notes, LIMITS.usage);
  return recipe;
}

const BUTTON_FIELDS = Object.freeze({
  background: "colour", color: "colour", borderColor: "colour", borderWidth: "px", radius: "radius", paddingX: "px", paddingY: "px",
  fontSize: "px", fontWeight: "weight", textTransform: "transform", shadow: "shadow", hoverBackground: "colour", hoverColor: "colour",
});
const INPUT_FIELDS = Object.freeze({ background: "colour", color: "colour", borderColor: "colour", borderWidth: "px", radius: "radius", paddingX: "px", paddingY: "px", fontSize: "px" });
const CARD_FIELDS = Object.freeze({ background: "colour", borderColor: "colour", borderWidth: "px", radius: "radius", padding: "px", shadow: "shadow" });
const NAV_FIELDS = Object.freeze({ background: "colour", color: "colour", height: "px", radius: "radius", borderColor: "colour", shadow: "shadow", style: "text" });
const FOOTER_FIELDS = Object.freeze({ background: "colour", color: "colour", columns: "columns" });

/**
 * Checks a model's visual system and returns it in the one form a system is stored in.
 *
 * Repairs what can only have been meant one way — a three-digit hex, a string a little too long —
 * and refuses what cannot be stored honestly: a required colour that is not a colour, a type scale
 * without a body size. An optional value that does not hold up is dropped to null and added to
 * `undetermined`, which is the same thing the model was told to do with it.
 *
 * @param {unknown} input the model's reply, parsed from JSON
 * @returns {object} the canonical visual system
 * @throws {ProtocolError} `INVALID_DESIGN_SYSTEM`
 */
export function parseVisualSystem(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("The visual system must be an object.");
  const undetermined = (Array.isArray(input.undetermined) ? input.undetermined : [])
    .map((entry) => ({ field: clip(entry?.field, LIMITS.short), reason: clip(entry?.reason, LIMITS.sentence) }))
    .filter((entry) => entry.field && entry.reason)
    .slice(0, LIMITS.undetermined);
  const dropped = (field, reason) => {
    if (!undetermined.some((entry) => entry.field === field)) undetermined.push({ field, reason });
  };

  const colors = {};
  for (const role of COLOR_ROLES) {
    const raw = input.colors?.[role];
    const value = hexOf(raw?.value);
    if (!value) {
      if (REQUIRED_COLOR_ROLES.includes(role)) throw invalid(`colors.${role} must be a colour.`);
      colors[role] = null;
      if (raw) dropped(`colors.${role}`, "The proposed value was not a colour.");
      continue;
    }
    colors[role] = {
      value,
      source: sourceOf(raw.source),
      observedFrom: (Array.isArray(raw.observedFrom) ? raw.observedFrom : []).map(hexOf).filter(Boolean).slice(0, 8),
      usage: clip(raw.usage, LIMITS.usage),
    };
  }

  const families = {};
  for (const role of FONT_ROLES) {
    const raw = input.typography?.families?.[role];
    const family = clip(raw?.family, 80);
    if (!family) {
      if (role !== "mono") throw invalid(`typography.families.${role} must name a typeface.`);
      families[role] = null;
      continue;
    }
    families[role] = {
      family,
      fallbacks: clipList(raw.fallbacks, 6, 60),
      weights: [...new Set((Array.isArray(raw.weights) ? raw.weights : []).map((weight) => numberIn(weight, 100, 900)).filter(Boolean))].sort((left, right) => left - right).slice(0, 9),
      source: sourceOf(raw.source),
    };
  }

  const scale = {};
  for (const token of TYPE_TOKENS) {
    const raw = input.typography?.scale?.[token];
    const px = numberIn(raw?.px, 6, 400);
    if (px === null) {
      if (REQUIRED_TYPE_TOKENS.includes(token)) throw invalid(`typography.scale.${token} must have a size.`);
      scale[token] = null;
      continue;
    }
    scale[token] = {
      px,
      lineHeight: numberIn(raw.lineHeight, 0.8, 3) ?? 1.4,
      weight: numberIn(raw.weight, 100, 900) ?? 400,
      letterSpacing: numberIn(raw.letterSpacing, -0.2, 0.5) ?? 0,
      family: families[raw.family] ? raw.family : token === "body" || token === "bodyLarge" || token === "small" || token === "caption" ? "body" : "heading",
      usedFor: clip(raw.usedFor, LIMITS.usage),
      source: sourceOf(raw.source),
    };
  }

  const sized = (raw, min, max, fallback) => ({ value: numberIn(raw?.value, min, max) ?? fallback, source: sourceOf(raw?.source) });
  const spacing = {
    base: sized(input.spacing?.base, 1, 32, 8),
    scale: {
      value: [...new Set((Array.isArray(input.spacing?.scale?.value) ? input.spacing.scale.value : []).map((step) => numberIn(step, 0, 400)).filter((step) => step !== null))].sort((left, right) => left - right).slice(0, 16),
      source: sourceOf(input.spacing?.scale?.source),
    },
    containerMaxWidth: sized(input.spacing?.containerMaxWidth, 320, 2400, null),
    sectionPadding: sized(input.spacing?.sectionPadding, 0, 400, null),
  };

  const shape = {
    radius: Object.fromEntries(RADIUS_TOKENS.map((token) => [token, sized(input.shape?.radius?.[token], 0, 9999, token === "pill" ? 9999 : 0)])),
    borderWidth: sized(input.shape?.borderWidth, 0, 16, 1),
    shadows: Object.fromEntries(SHADOW_TOKENS.map((token) => [token, { value: safeShadow(input.shape?.shadows?.[token]?.value), source: sourceOf(input.shape?.shadows?.[token]?.source) }])),
  };

  const components = {
    button: Object.fromEntries(BUTTON_VARIANTS.map((variant) => [variant, recipeOf(input.components?.button?.[variant], BUTTON_FIELDS)])),
    input: recipeOf(input.components?.input, INPUT_FIELDS),
    card: recipeOf(input.components?.card, CARD_FIELDS),
    nav: recipeOf(input.components?.nav, NAV_FIELDS),
    footer: recipeOf(input.components?.footer, FOOTER_FIELDS),
  };

  return {
    colors,
    typography: { families, scale, rules: clipList(input.typography?.rules, LIMITS.rules, LIMITS.rule) },
    spacing,
    shape,
    components,
    personality: {
      summary: clip(input.personality?.summary, LIMITS.sentence),
      adjectives: clipList(input.personality?.adjectives, LIMITS.adjectives, 40),
    },
    rules: clipList(input.rules, LIMITS.rules, LIMITS.rule),
    undetermined,
  };
}

/**
 * Checks a model's graphics language and returns it in the form it is stored in.
 *
 * The verdicts on images are kept only for numbers that were actually on the sheet, and a
 * reference image is kept only when its own verdict says it belongs: the model is asked for both,
 * and a reply that named a customer's logo as a style reference would otherwise be served to an
 * image model as this brand's style.
 *
 * @param {unknown} input the model's reply, parsed from JSON
 * @param {readonly number[]} numbers the image numbers that were on the contact sheet
 * @returns {{graphics: object, images: object[], imagePrompt: object}}
 * @throws {ProtocolError} `INVALID_DESIGN_SYSTEM`
 */
export function parseGraphicsLanguage(input, numbers) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("The graphics language must be an object.");
  const raw = input.graphics ?? {};
  const description = clip(raw.description, LIMITS.paragraph);
  if (!description) throw invalid("graphics.description must describe the imagery.");
  const optionalText = (value) => clip(value, LIMITS.sentence) || null;

  const known = new Set(numbers);
  const seen = new Set();
  const images = [];
  for (const entry of Array.isArray(input.images) ? input.images : []) {
    if (!Number.isInteger(entry?.number) || !known.has(entry.number) || seen.has(entry.number)) continue;
    seen.add(entry.number);
    images.push({
      number: entry.number,
      caption: clip(entry.caption, LIMITS.usage),
      belongs: entry.belongs !== false,
      kind: choiceOf(entry.kind, IMAGE_VERDICT_KINDS, "other"),
    });
  }
  const belonging = new Set(images.filter((image) => image.belongs).map((image) => image.number));

  return {
    graphics: {
      medium: choiceOf(raw.medium, GRAPHICS_MEDIA, "mixed"),
      description,
      subjects: optionalText(raw.subjects),
      paletteUsage: optionalText(raw.paletteUsage),
      strokeAndShading: optionalText(raw.strokeAndShading),
      perspective: optionalText(raw.perspective),
      composition: optionalText(raw.composition),
      peopleDepiction: optionalText(raw.peopleDepiction),
      texture: optionalText(raw.texture),
      mood: optionalText(raw.mood),
      iconography: raw.iconography && clip(raw.iconography.style, LIMITS.usage)
        ? {
            style: clip(raw.iconography.style, LIMITS.usage),
            strokeWeight: optionalText(raw.iconography.strokeWeight),
            corner: optionalText(raw.iconography.corner),
            fill: optionalText(raw.iconography.fill),
          }
        : null,
      logo: raw.logo && clip(raw.logo.description, LIMITS.sentence)
        ? { description: clip(raw.logo.description, LIMITS.sentence), usage: clipList(raw.logo.usage, 4, LIMITS.rule) }
        : null,
      doNot: clipList(raw.doNot, 6, LIMITS.rule),
      source: VALUE_SOURCES.observed,
    },
    images,
    imagePrompt: {
      stylePrefix: clip(input.imagePrompt?.stylePrefix, LIMITS.paragraph),
      negative: clip(input.imagePrompt?.negative, LIMITS.sentence),
      referenceImages: [...new Set((Array.isArray(input.imagePrompt?.referenceImages) ? input.imagePrompt.referenceImages : []).filter((number) => belonging.has(number)))].slice(0, 5),
    },
  };
}
