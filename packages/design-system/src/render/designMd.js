import { BUTTON_VARIANTS, COLOR_ROLES, FONT_ROLES, RADIUS_TOKENS, SHADOW_TOKENS, TYPE_TOKENS } from "@orbik/protocol";

import { resolveColor, resolveRadius, resolveShadow } from "../system.js";

/** How each colour role is named in prose. */
const ROLE_LABELS = Object.freeze({
  primary: "Primary", secondary: "Secondary", accent: "Accent", background: "Background", surface: "Surface", text: "Text",
  textMuted: "Muted text", border: "Border", link: "Link", success: "Success", warning: "Warning", error: "Error",
});

/** How each step of the type scale is named in prose. */
const TOKEN_LABELS = Object.freeze({
  display: "Display", h1: "Heading 1", h2: "Heading 2", h3: "Heading 3", h4: "Heading 4", bodyLarge: "Body large", body: "Body",
  small: "Small", caption: "Caption", button: "Button", label: "Label",
});

/** The attributes of a graphics language, in the order they are listed, with how each is named. */
const GRAPHICS_FIELDS = Object.freeze([
  ["subjects", "Subjects"], ["paletteUsage", "Colour"], ["strokeAndShading", "Line and shading"], ["perspective", "Perspective"],
  ["composition", "Composition"], ["peopleDepiction", "People"], ["texture", "Texture"], ["mood", "Mood"],
]);

/**
 * Writes a design system out as Markdown: the `DESIGN.md` an AI is handed, from the Brand page's
 * export, `brand_render` and the `orbik://brand` resource alike.
 *
 * What differs between those callers is passed in: whether the document carries its own title,
 * how an image is addressed, and how the one line about voice and tone points at the Library.
 *
 * Every value is written with where it came from, because that is the thing a reader most needs
 * and a table of hex codes least obviously says: which of these the site actually does, which are
 * a tidying of what it does, which are a suggestion, and which a person set.
 *
 * @param {object} options
 * @param {object} options.system the effective system, pins applied
 * @param {string} options.host the site it was derived from
 * @param {string|null} [options.name] the workspace's name, for the title
 * @param {Date|string|null} [options.derivedAt] when it was derived
 * @param {object[]} [options.assets] the workspace's stored assets, as the asset store lists them
 * @param {(asset: object) => string|null} [options.assetUrl] how an asset is addressed in this
 *   document; an asset it returns null for is named but not linked
 * @param {boolean} [options.title] whether to open with a top-level heading
 * @param {string} [options.voiceNote] the line saying where voice and tone are kept
 * @returns {string} the document
 */
export function renderDesignMd({ system, host, name = null, derivedAt = null, assets = [], assetUrl = () => null, title = true, voiceNote = null }) {
  const lines = [];
  const add = (...rows) => lines.push(...rows);
  const visible = assets.filter((asset) => asset.hidden !== true);

  if (title) add(`# ${name ?? host} design system`, "");
  add(
    `> Derived from ${host} as rendered in a browser${derivedAt ? ` on ${isoDay(derivedAt)}` : ""}. Every value says where it came from: ` +
    "**observed** (seen on the site as it is), **derived** (normalised from several observed values), **proposed** " +
    "(suggested to fill a gap the site leaves) or **pinned** (set by a person).",
    "",
  );
  if (system.personality?.summary) {
    const adjectives = system.personality.adjectives?.length ? ` *${system.personality.adjectives.join(", ")}.*` : "";
    add(`${system.personality.summary}${adjectives}`, "");
  }

  // ---- colours
  add("## Colours", "", "| Role | Value | Source | Use |", "| --- | --- | --- | --- |");
  for (const role of COLOR_ROLES) {
    const colour = system.colors?.[role];
    if (!colour) continue;
    add(`| ${ROLE_LABELS[role]} | \`${colour.value}\` | ${colour.source} | ${cell(colour.usage)} |`);
  }
  const contrast = contrastLines(system);
  if (contrast.length) add("", "Contrast (WCAG):", "", ...contrast);
  add("");

  // ---- typography
  add("## Typography", "", "| Role | Family | Weights | Fallbacks | Source |", "| --- | --- | --- | --- | --- |");
  for (const role of FONT_ROLES) {
    const family = system.typography?.families?.[role];
    if (!family) continue;
    add(`| ${capitalize(role)} | ${cell(family.family)} | ${family.weights.join(", ") || "—"} | ${cell(family.fallbacks.join(", ")) || "—"} | ${family.source} |`);
  }
  add("", "| Step | Size | Line height | Weight | Family | Used for | Source |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const token of TYPE_TOKENS) {
    const step = system.typography?.scale?.[token];
    if (!step) continue;
    const tracking = step.letterSpacing ? ` (tracking ${step.letterSpacing}em)` : "";
    add(`| ${TOKEN_LABELS[token]} | ${step.px}px | ${step.lineHeight} | ${step.weight}${tracking} | ${step.family} | ${cell(step.usedFor)} | ${step.source} |`);
  }
  if (system.typography?.rules?.length) add("", ...system.typography.rules.map((rule) => `- ${rule}`));
  add("");

  // ---- spacing and shape
  add("## Spacing and layout", "");
  const spacing = system.spacing ?? {};
  if (spacing.base) add(`- Base unit: ${spacing.base.value}px (${spacing.base.source})`);
  if (spacing.scale?.value?.length) add(`- Scale: ${spacing.scale.value.map((step) => `${step}px`).join(", ")} (${spacing.scale.source})`);
  if (typeof spacing.containerMaxWidth?.value === "number") add(`- Container max width: ${spacing.containerMaxWidth.value}px (${spacing.containerMaxWidth.source})`);
  if (typeof spacing.sectionPadding?.value === "number") add(`- Section padding, top and bottom: ${spacing.sectionPadding.value}px (${spacing.sectionPadding.source})`);
  add("", "## Shape", "");
  const shape = system.shape ?? {};
  // A brand started from uploads may have no radii yet, or only some of them.
  const radii = RADIUS_TOKENS.filter((token) => shape.radius?.[token]);
  if (radii.length) add(`- Radius: ${radii.map((token) => `${token} ${shape.radius[token].value}px (${shape.radius[token].source})`).join(", ")}`);
  if (shape.borderWidth) add(`- Border width: ${shape.borderWidth.value}px (${shape.borderWidth.source})`);
  for (const token of SHADOW_TOKENS) {
    const shadow = shape.shadows?.[token];
    if (shadow?.value) add(`- Shadow ${token}: \`${shadow.value}\` (${shadow.source})`);
  }
  add("");

  // ---- components
  const components = system.components ?? {};
  const recipes = [
    ...BUTTON_VARIANTS.map((variant) => [`Button, ${variant}`, components.button?.[variant], "button"]),
    ["Input", components.input, "input"],
    ["Card", components.card, "card"],
    ["Navigation bar", components.nav, "nav"],
    ["Footer", components.footer, "footer"],
  ].filter(([, recipe]) => recipe);
  if (recipes.length) {
    add("## Components", "");
    for (const [label, recipe, kind] of recipes) {
      add(`### ${label}`, "", describeRecipe(system, recipe, kind), "");
    }
  }

  // ---- logo
  const logos = visible.filter((asset) => asset.kind === "logo");
  if (logos.length || system.graphics?.logo) {
    add("## Logo", "");
    if (system.graphics?.logo?.description) add(system.graphics.logo.description, "");
    const primaryId = system.logos?.primary ?? null;
    const ordered = [...logos].sort((left, right) => Number(idOf(right) === primaryId) - Number(idOf(left) === primaryId));
    for (const logo of ordered) {
      const url = assetUrl(logo);
      const what = [idOf(logo) === primaryId ? "primary" : null, logo.variant, logo.tone ? logo.tone.replace("on-", "for ") + " backgrounds" : null, logo.width && logo.height ? `${logo.width}×${logo.height}` : null]
        .filter(Boolean).join(", ");
      add(url ? `![${cell(logo.label ?? logo.alt ?? "Logo")}](${url})` : `- ${logo.label ?? logo.alt ?? "Logo"}`, "", `*${capitalize(what) || "Logo"}.*`, "");
    }
    if (system.graphics?.logo?.usage?.length) add(...system.graphics.logo.usage.map((rule) => `- ${rule}`), "");
  }

  // ---- graphics
  const graphics = system.graphics;
  if (graphics) {
    add("## Graphics language", "", `**Medium:** ${graphics.medium}.`, "", graphics.description, "");
    for (const [field, label] of GRAPHICS_FIELDS) {
      if (graphics[field]) add(`- **${label}:** ${graphics[field]}`);
    }
    if (graphics.iconography) {
      const icon = graphics.iconography;
      add(`- **Icons:** ${[icon.style, icon.strokeWeight, icon.corner, icon.fill].filter(Boolean).join("; ")}`);
    }
    if (graphics.doNot?.length) add("", "Do not:", "", ...graphics.doNot.map((rule) => `- ${rule}`));
    add("");
    if (graphics.imagePrompt?.stylePrefix) {
      add("### Image prompt", "", "Put this before any image prompt so the result is in this style:", "", `> ${graphics.imagePrompt.stylePrefix}`, "");
      if (graphics.imagePrompt.negative) add(`Avoid: ${graphics.imagePrompt.negative}`, "");
    }
    const references = visible.filter((asset) => asset.isReference === true && asset.kind !== "logo").slice(0, 5);
    if (references.length) {
      add("Reference images, in the brand's own style:", "");
      for (const asset of references) {
        const url = assetUrl(asset);
        const caption = asset.caption ?? asset.alt ?? asset.kind;
        add(url ? `![${cell(caption)}](${url})` : `- ${caption}`, "");
      }
    }
  }

  // ---- rules, gaps, and where the words live
  if (system.rules?.length) add("## Rules", "", ...system.rules.map((rule) => `- ${rule}`), "");
  if (system.undetermined?.length) {
    add("## Not determined", "", "What could not be read from the site, and why. None of it was filled in with a guess.", "");
    add(...system.undetermined.map((entry) => `- \`${entry.field}\`: ${entry.reason}`), "");
  }
  if (voiceNote) add("---", "", voiceNote, "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** One component recipe as a sentence of concrete values, each token named and resolved. */
function describeRecipe(system, recipe, kind) {
  const colour = (reference) => {
    if (!reference) return null;
    const value = resolveColor(system, reference);
    return COLOR_ROLES.includes(reference) ? `${reference} (\`${value}\`)` : `\`${value}\``;
  };
  const parts = [];
  if (recipe.background) parts.push(`background ${colour(recipe.background)}`);
  if (recipe.color) parts.push(`text ${colour(recipe.color)}`);
  if (recipe.borderColor && recipe.borderWidth > 0) parts.push(`${recipe.borderWidth}px border ${colour(recipe.borderColor)}`);
  if (recipe.radius) parts.push(`radius ${recipe.radius}${recipe.radius === "none" ? "" : ` (${resolveRadius(system, recipe.radius)}px)`}`);
  if (typeof recipe.paddingY === "number") parts.push(`padding ${recipe.paddingY}px ${recipe.paddingX}px`);
  if (typeof recipe.padding === "number") parts.push(`padding ${recipe.padding}px`);
  if (typeof recipe.height === "number" && recipe.height) parts.push(`height ${recipe.height}px`);
  if (typeof recipe.fontSize === "number" && recipe.fontSize) parts.push(`${recipe.fontSize}px${recipe.fontWeight ? ` / ${recipe.fontWeight}` : ""} type`);
  if (recipe.textTransform && recipe.textTransform !== "none") parts.push(recipe.textTransform);
  if (recipe.shadow && recipe.shadow !== "none") parts.push(`shadow ${recipe.shadow}${resolveShadow(system, recipe.shadow) ? "" : " (not defined)"}`);
  if (recipe.hoverBackground) parts.push(`hover background ${colour(recipe.hoverBackground)}`);
  if (recipe.hoverColor) parts.push(`hover text ${colour(recipe.hoverColor)}`);
  if (kind === "footer" && recipe.columns) parts.push(`${recipe.columns} columns`);
  const sentence = `${capitalize(parts.join(", "))}. (${recipe.source})`;
  return [sentence, recipe.style, recipe.notes].filter(Boolean).join(" ");
}

/** The contrast figures worth stating: how the system's text and its actions read on its surfaces. */
function contrastLines(system) {
  const lines = [];
  for (const [role, label] of [["text", "Text"], ["textMuted", "Muted text"], ["link", "Link"], ["primary", "Primary"]]) {
    const on = system.colors?.[role]?.contrastOn;
    if (on?.background) lines.push(`- ${label} on background: ${on.background.ratio}:1 (${on.background.grade})`);
    if (on?.surface && system.colors.surface?.value !== system.colors.background?.value) lines.push(`- ${label} on surface: ${on.surface.ratio}:1 (${on.surface.grade})`);
  }
  return lines;
}

/** An asset's identifier as text, whether it is a stored row or already a summary. */
function idOf(asset) {
  return String(asset._id ?? asset.id);
}

/** Text made safe for a table cell and an image's alt text: one line, no pipes, no brackets. */
function cell(value) {
  return String(value ?? "").replace(/\s+/g, " ").replace(/[|[\]]/g, " ").trim();
}

/** A phrase with its first letter in upper case. */
function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/** A date as `YYYY-MM-DD`. */
function isoDay(value) {
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? "an unknown date" : at.toISOString().slice(0, 10);
}
