import { COLOR_ROLES, RADIUS_TOKENS, SHADOW_TOKENS } from "@orbik/protocol";

import { contrastGrade, contrastRatio, formatOklch, isHexColor, normalizeHex } from "./color.js";

/**
 * Reading a stored design system: what a recipe's token names resolve to, and the figures that
 * are worked out from a system rather than stored in a proposal.
 *
 * A component recipe says `background: "primary"` and `radius: "md"` rather than repeating a hex
 * and a number, which is what makes pinning the primary colour change every button at once. So
 * everything that turns a system into something concrete — a stylesheet, a sample on the Brand
 * page, a paragraph in the guide — resolves a recipe through these functions, and they agree
 * because there is one of each.
 */

/**
 * The colour a recipe names, as `#rrggbb`, `transparent`, or null when it names nothing usable.
 *
 * @param {object} system the effective system
 * @param {string|null} reference a role name, `transparent`, or a literal colour
 * @returns {string|null}
 */
export function resolveColor(system, reference) {
  if (!reference) return null;
  if (reference === "transparent") return "transparent";
  if (COLOR_ROLES.includes(reference)) return system?.colors?.[reference]?.value ?? null;
  return normalizeHex(reference);
}

/**
 * The radius a recipe names, in pixels.
 *
 * @param {object} system the effective system
 * @param {string} token `none`, `sm`, `md`, `lg` or `pill`
 * @returns {number}
 */
export function resolveRadius(system, token) {
  if (!RADIUS_TOKENS.includes(token)) return 0;
  return system?.shape?.radius?.[token]?.value ?? 0;
}

/**
 * The shadow a recipe names, as a CSS value, or null for none.
 *
 * @param {object} system the effective system
 * @param {string} token `none`, `sm`, `md` or `lg`
 * @returns {string|null}
 */
export function resolveShadow(system, token) {
  if (!SHADOW_TOKENS.includes(token)) return null;
  return system?.shape?.shadows?.[token]?.value ?? null;
}

/** How one colour reads on another: the ratio, and what WCAG says it is good for. */
function contrastOf(foreground, background) {
  if (!isHexColor(foreground) || !isHexColor(background)) return null;
  const ratio = contrastRatio(foreground, background);
  return { ratio, grade: contrastGrade(ratio) };
}

/**
 * Adds to a system the figures that follow from its values: each colour in OKLCH, and how it
 * reads against the background and the surface.
 *
 * Worked out here rather than asked of a model, and after the pins are applied rather than
 * before: a contrast ratio is arithmetic, and it has to be the contrast of the colours the
 * system actually has — including the one somebody just changed.
 *
 * @param {object|null} system the effective system, pins applied
 * @returns {object|null} the same system, annotated
 */
export function annotateSystem(system) {
  if (!system?.colors) return system;
  const background = system.colors.background?.value ?? null;
  const surface = system.colors.surface?.value ?? null;
  const text = system.colors.text?.value ?? null;
  for (const role of COLOR_ROLES) {
    const colour = system.colors[role];
    if (!colour?.value) continue;
    colour.oklch = formatOklch(colour.value);
    // A surface is judged by how text reads on it; everything else by how it reads on a surface.
    colour.contrastOn = role === "background" || role === "surface"
      ? { text: contrastOf(text, colour.value) }
      : { background: contrastOf(colour.value, background), surface: contrastOf(colour.value, surface) };
  }
  return system;
}

/**
 * The colour of text that reads on a given background: the system's text colour, or white.
 *
 * Used where a recipe leaves the question open — a sample button with no stated text colour —
 * and settled by contrast, not by a guess about whether the background is "dark".
 */
export function readableOn(system, background) {
  const text = system?.colors?.text?.value;
  if (!isHexColor(background)) return text ?? "#000000";
  const candidates = [text, "#ffffff", "#000000"].filter(isHexColor);
  return candidates.sort((left, right) => contrastRatio(right, background) - contrastRatio(left, background))[0] ?? "#000000";
}
