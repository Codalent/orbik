import { BUTTON_VARIANTS } from "@orbik/protocol";

import { resolveTokens } from "./tokens.js";

/**
 * Writes a design system out as CSS custom properties, with the components as classes over them.
 *
 * The variables are the system. The classes underneath are the component recipes resolved against
 * those variables wherever a recipe names a role, so that changing `--color-primary` changes the
 * button, which is the reason to have tokens at all. A recipe's literal colour stays a literal.
 *
 * Fonts are named and never embedded: the site's font files are its own to license, and a
 * stylesheet that silently fell back to a system font would be a stylesheet that looked right in
 * a comment and wrong on a page — so the header says which families have to be loaded.
 *
 * @param {object} options
 * @param {object} options.system the effective system, pins applied
 * @param {string} options.host the site it was derived from
 * @returns {string} a stylesheet
 */
export function renderCss({ system, host }) {
  const tokens = resolveTokens(system);
  const lines = [
    "/*",
    ` * Design tokens for ${host}, derived by Orbik from the site as rendered.`,
    ...(tokens.fonts.length ? [` * Fonts are not included. Load: ${tokens.fonts.map((font) => `${font.family} (${font.weights.join(", ") || "400"})`).join("; ")}.`] : []),
    " */",
    ":root {",
  ];
  const declare = (name, value, note) => lines.push(`  --${name}: ${value};${note ? ` /* ${note} */` : ""}`);

  for (const colour of tokens.colors) declare(`color-${colour.name}`, colour.value, colour.source);
  lines.push("");
  for (const font of tokens.fonts) declare(`font-${font.role}`, font.stack, font.source);
  lines.push("");
  for (const step of tokens.type) {
    declare(`text-${step.name}-size`, `${step.px}px`, step.source);
    declare(`text-${step.name}-line`, step.lineHeight);
    declare(`text-${step.name}-weight`, step.weight);
    if (step.letterSpacing) declare(`text-${step.name}-tracking`, `${step.letterSpacing}em`);
  }
  lines.push("");
  if (tokens.spacing.base !== null) declare("space-unit", `${tokens.spacing.base}px`);
  for (const step of tokens.spacing.scale) declare(`space-${String(step).replace(".", "_")}`, `${step}px`);
  if (tokens.spacing.containerMaxWidth !== null) declare("container-max", `${tokens.spacing.containerMaxWidth}px`);
  if (tokens.spacing.sectionPadding !== null) declare("section-padding", `${tokens.spacing.sectionPadding}px`);
  lines.push("");
  for (const radius of tokens.radius) declare(`radius-${radius.token}`, `${radius.px}px`, radius.source);
  if (tokens.borderWidth !== null) declare("border-width", `${tokens.borderWidth}px`);
  for (const shadow of tokens.shadows) declare(`shadow-${shadow.token}`, shadow.value, shadow.source);
  lines.push("}", "");

  // A colour as the variable it came from when the recipe named a role, and as itself otherwise.
  const colourOf = (reference, resolved) => {
    if (!resolved) return null;
    const named = tokens.colors.find((colour) => colour.role === reference);
    return named ? `var(--color-${named.name})` : resolved;
  };
  const radiusOf = (token) => (token === "none" ? "0" : `var(--radius-${token})`);
  const shadowOf = (token) => (token === "none" || !tokens.shadows.some((shadow) => shadow.token === token) ? "none" : `var(--shadow-${token})`);
  const rule = (selector, declarations) => {
    const body = declarations.filter(([, value]) => value !== null && value !== undefined && value !== "");
    if (body.length) lines.push(`${selector} {`, ...body.map(([property, value]) => `  ${property}: ${value};`), "}", "");
  };

  lines.push("/* Components, as recipes over the tokens above. */");
  rule("body", [
    ["font-family", tokens.fonts.find((font) => font.role === "body") ? "var(--font-body)" : null],
    ["font-size", tokens.type.some((step) => step.token === "body") ? "var(--text-body-size)" : null],
    ["line-height", tokens.type.some((step) => step.token === "body") ? "var(--text-body-line)" : null],
    ["color", "var(--color-text)"],
    ["background", "var(--color-background)"],
  ]);
  for (const token of ["h1", "h2", "h3", "h4"]) {
    const step = tokens.type.find((entry) => entry.token === token);
    if (!step) continue;
    rule(token, [
      ["font-family", tokens.fonts.some((font) => font.role === step.family) ? `var(--font-${step.family})` : null],
      ["font-size", `var(--text-${token}-size)`],
      ["line-height", `var(--text-${token}-line)`],
      ["font-weight", `var(--text-${token}-weight)`],
      ["letter-spacing", step.letterSpacing ? `var(--text-${token}-tracking)` : null],
    ]);
  }
  rule("a", [["color", "var(--color-link)"]]);

  const buttons = system.components?.button ?? {};
  for (const variant of BUTTON_VARIANTS) {
    const raw = buttons[variant];
    const resolved = tokens.components.button[variant];
    if (!raw || !resolved) continue;
    rule(`.button-${variant}`, [
      ["display", "inline-flex"],
      ["align-items", "center"],
      ["justify-content", "center"],
      ["background", colourOf(raw.background, resolved.background)],
      ["color", colourOf(raw.color, resolved.color)],
      ["border", raw.borderColor && raw.borderWidth > 0 ? `${raw.borderWidth}px solid ${colourOf(raw.borderColor, resolved.borderColor)}` : "0"],
      ["border-radius", radiusOf(raw.radius)],
      // A recipe read from a fixed-height button has no vertical padding to give; a minimum
      // height keeps the label from touching the edges.
      ["padding", `${raw.paddingY}px ${raw.paddingX}px`],
      ["min-height", raw.paddingY === 0 ? `${Math.round(raw.fontSize * 2.4)}px` : null],
      ["font-size", `${raw.fontSize}px`],
      ["font-weight", raw.fontWeight],
      ["text-transform", raw.textTransform === "none" ? null : raw.textTransform],
      ["box-shadow", shadowOf(raw.shadow)],
      ["text-decoration", "none"],
      ["cursor", "pointer"],
    ]);
    rule(`.button-${variant}:hover`, [
      ["background", colourOf(raw.hoverBackground, resolved.hoverBackground)],
      ["color", colourOf(raw.hoverColor, resolved.hoverColor)],
    ]);
  }
  const input = system.components?.input;
  if (input && tokens.components.input) {
    rule(".input", [
      ["background", colourOf(input.background, tokens.components.input.background)],
      ["color", colourOf(input.color, tokens.components.input.color)],
      ["border", input.borderColor && input.borderWidth > 0 ? `${input.borderWidth}px solid ${colourOf(input.borderColor, tokens.components.input.borderColor)}` : "0"],
      ["border-radius", radiusOf(input.radius)],
      ["padding", `${input.paddingY}px ${input.paddingX}px`],
      ["font-size", `${input.fontSize}px`],
    ]);
  }
  const card = system.components?.card;
  if (card && tokens.components.card) {
    rule(".card", [
      ["background", colourOf(card.background, tokens.components.card.background)],
      ["border", card.borderColor && card.borderWidth > 0 ? `${card.borderWidth}px solid ${colourOf(card.borderColor, tokens.components.card.borderColor)}` : "0"],
      ["border-radius", radiusOf(card.radius)],
      ["padding", `${card.padding}px`],
      ["box-shadow", shadowOf(card.shadow)],
    ]);
  }
  if (tokens.spacing.containerMaxWidth !== null) {
    rule(".container", [["max-width", "var(--container-max)"], ["margin-inline", "auto"]]);
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
