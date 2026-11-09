import { resolveTokens } from "./tokens.js";

/**
 * Writes a design system out as a Tailwind theme.
 *
 * Tailwind 4 takes its theme from CSS, so the first block is an `@theme` to paste into the
 * stylesheet that imports Tailwind: it gives `bg-primary`, `text-text-muted`, `font-heading`,
 * `text-h1`, `rounded-md`, `shadow-sm`. Underneath, as a comment, is the same theme as the
 * `theme.extend` object a Tailwind 3 project keeps in `tailwind.config.js` — the two are generated
 * from one list, so they cannot name a colour differently.
 *
 * @param {object} options
 * @param {object} options.system the effective system, pins applied
 * @param {string} options.host the site it was derived from
 * @returns {string} the theme
 */
export function renderTailwind({ system, host }) {
  const tokens = resolveTokens(system);
  const lines = [
    `/* Tailwind theme for ${host}, derived by Orbik from the site as rendered. */`,
    "/* Tailwind 4: paste into the stylesheet that has `@import \"tailwindcss\";`. */",
    "@theme {",
  ];
  for (const colour of tokens.colors) lines.push(`  --color-${colour.name}: ${colour.value};`);
  for (const font of tokens.fonts) lines.push(`  --font-${font.role}: ${font.stack};`);
  for (const step of tokens.type) {
    lines.push(`  --text-${step.name}: ${step.px}px;`, `  --text-${step.name}--line-height: ${step.lineHeight};`, `  --text-${step.name}--font-weight: ${step.weight};`);
    if (step.letterSpacing) lines.push(`  --text-${step.name}--letter-spacing: ${step.letterSpacing}em;`);
  }
  for (const radius of tokens.radius) lines.push(`  --radius-${radius.token === "pill" ? "full" : radius.token}: ${radius.px}px;`);
  for (const shadow of tokens.shadows) lines.push(`  --shadow-${shadow.token}: ${shadow.value};`);
  if (tokens.spacing.containerMaxWidth !== null) lines.push(`  --container-site: ${tokens.spacing.containerMaxWidth}px;`);
  lines.push("}", "");

  const extend = {
    colors: Object.fromEntries(tokens.colors.map((colour) => [colour.name, colour.value])),
    fontFamily: Object.fromEntries(tokens.fonts.map((font) => [font.role, [font.family, ...(system.typography.families[font.role].fallbacks ?? [])]])),
    fontSize: Object.fromEntries(tokens.type.map((step) => [
      step.name,
      [`${step.px}px`, { lineHeight: String(step.lineHeight), fontWeight: String(step.weight), ...(step.letterSpacing ? { letterSpacing: `${step.letterSpacing}em` } : {}) }],
    ])),
    borderRadius: Object.fromEntries(tokens.radius.map((radius) => [radius.token === "pill" ? "full" : radius.token, `${radius.px}px`])),
    boxShadow: Object.fromEntries(tokens.shadows.map((shadow) => [shadow.token, shadow.value])),
    ...(tokens.spacing.containerMaxWidth !== null ? { maxWidth: { site: `${tokens.spacing.containerMaxWidth}px` } } : {}),
  };
  lines.push(
    "/*",
    " * Tailwind 3: tailwind.config.js",
    " *",
    ...`module.exports = ${JSON.stringify({ theme: { extend } }, null, 2)};`.split("\n").map((line) => ` * ${line}`),
    " */",
  );
  return `${lines.join("\n")}\n`;
}
