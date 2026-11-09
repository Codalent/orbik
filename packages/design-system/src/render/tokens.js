import { BUTTON_VARIANTS, COLOR_ROLES, FONT_ROLES, RADIUS_TOKENS, SHADOW_TOKENS, TYPE_TOKENS } from "@orbik/protocol";

import { resolveColor, resolveRadius, resolveShadow } from "../system.js";

/**
 * A design system flattened into the plain values every stylesheet-like rendering needs.
 *
 * The CSS, the Tailwind theme and the sample on the Brand page each used to want the same thing
 * from a system — "what is the primary colour, what is the heading stack, what does a primary
 * button look like once its tokens are resolved" — and three ways of working that out would be
 * three places for a pinned colour to fail to arrive. So it is worked out once, here, and each
 * rendering only decides how to spell it.
 */

/** Names in kebab case, as a stylesheet spells them: `textMuted` is `text-muted`. */
export function kebab(name) {
  return String(name).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** A family stack as a `font-family` value: names with spaces quoted, generics bare. */
export function fontStack(family) {
  if (!family) return null;
  const generic = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded"]);
  return [family.family, ...family.fallbacks]
    .filter(Boolean)
    .map((name) => (generic.has(name.toLowerCase()) || /^[a-z-]+$/i.test(name) ? name : `"${name.replace(/["\\]/g, "")}"`))
    .join(", ");
}

/**
 * The values of a system, resolved and named.
 *
 * @param {object} system the effective system, pins applied
 * @returns {{colors: Array<{role: string, name: string, value: string, source: string, usage: string}>,
 *   fonts: Array<{role: string, stack: string, family: string, weights: number[], source: string}>,
 *   type: Array<{token: string, name: string, px: number, lineHeight: number, weight: number, letterSpacing: number, family: string, usedFor: string, source: string}>,
 *   spacing: {base: number|null, scale: number[], containerMaxWidth: number|null, sectionPadding: number|null},
 *   radius: Array<{token: string, px: number, source: string}>, borderWidth: number|null,
 *   shadows: Array<{token: string, value: string, source: string}>, components: object}}
 */
export function resolveTokens(system) {
  const colors = COLOR_ROLES.filter((role) => system.colors?.[role]?.value).map((role) => ({
    role,
    name: kebab(role),
    value: system.colors[role].value,
    source: system.colors[role].source,
    usage: system.colors[role].usage ?? "",
  }));
  const fonts = FONT_ROLES.filter((role) => system.typography?.families?.[role]?.family).map((role) => ({
    role,
    stack: fontStack(system.typography.families[role]),
    family: system.typography.families[role].family,
    weights: system.typography.families[role].weights ?? [],
    source: system.typography.families[role].source,
  }));
  const type = TYPE_TOKENS.filter((token) => system.typography?.scale?.[token]).map((token) => ({ token, name: kebab(token), ...system.typography.scale[token] }));

  const colour = (reference) => resolveColor(system, reference);
  const recipe = (source, fields) => {
    if (!source) return null;
    const resolved = { source: source.source, notes: source.notes ?? "" };
    for (const field of fields) {
      if (!(field in source)) continue;
      if (["background", "color", "borderColor", "hoverBackground", "hoverColor"].includes(field)) resolved[field] = colour(source[field]);
      else if (field === "radius") resolved.radius = source.radius === "none" ? 0 : resolveRadius(system, source.radius);
      else if (field === "shadow") resolved.shadow = source.shadow === "none" ? null : resolveShadow(system, source.shadow);
      else resolved[field] = source[field];
    }
    return resolved;
  };
  const buttonFields = ["background", "color", "borderColor", "borderWidth", "radius", "paddingX", "paddingY", "fontSize", "fontWeight", "textTransform", "shadow", "hoverBackground", "hoverColor"];

  return {
    colors,
    fonts,
    type,
    spacing: {
      base: system.spacing?.base?.value ?? null,
      scale: system.spacing?.scale?.value ?? [],
      containerMaxWidth: system.spacing?.containerMaxWidth?.value ?? null,
      sectionPadding: system.spacing?.sectionPadding?.value ?? null,
    },
    radius: RADIUS_TOKENS.filter((token) => system.shape?.radius?.[token]).map((token) => ({ token, px: system.shape.radius[token].value, source: system.shape.radius[token].source })),
    borderWidth: system.shape?.borderWidth?.value ?? null,
    shadows: SHADOW_TOKENS.filter((token) => system.shape?.shadows?.[token]?.value).map((token) => ({ token, value: system.shape.shadows[token].value, source: system.shape.shadows[token].source })),
    components: {
      button: Object.fromEntries(BUTTON_VARIANTS.map((variant) => [variant, recipe(system.components?.button?.[variant], buttonFields)])),
      input: recipe(system.components?.input, ["background", "color", "borderColor", "borderWidth", "radius", "paddingX", "paddingY", "fontSize"]),
      card: recipe(system.components?.card, ["background", "borderColor", "borderWidth", "radius", "padding", "shadow"]),
      nav: recipe(system.components?.nav, ["background", "color", "height", "radius", "borderColor", "shadow", "style"]),
      footer: recipe(system.components?.footer, ["background", "color", "columns"]),
    },
  };
}
