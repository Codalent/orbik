import { renderCss } from "./css.js";
import { renderDesignMd } from "./designMd.js";
import { renderDtcg } from "./dtcg.js";
import { renderImagePrompt } from "./imagePrompt.js";
import { renderTailwind } from "./tailwind.js";

/**
 * Every form a design system can be handed out in, and what each is as a file.
 *
 * One table, read by the API's download route and by the MCP tool alike, so the two cannot offer
 * different formats or call the same one by different names.
 */
export const BRAND_RENDER_FORMATS = Object.freeze({
  dtcg: Object.freeze({ label: "Design tokens (DTCG)", mimeType: "application/json", extension: "tokens.json" }),
  css: Object.freeze({ label: "CSS variables", mimeType: "text/css", extension: "css" }),
  tailwind: Object.freeze({ label: "Tailwind theme", mimeType: "text/css", extension: "tailwind.css" }),
  "design-md": Object.freeze({ label: "DESIGN.md", mimeType: "text/markdown", extension: "DESIGN.md" }),
  "image-prompt": Object.freeze({ label: "Image prompt", mimeType: "text/plain", extension: "image-prompt.txt" }),
});

/** Every format's name, as an array. */
export const BRAND_RENDER_FORMAT_VALUES = Object.freeze(Object.keys(BRAND_RENDER_FORMATS));

/**
 * Renders a design system in one of the forms it is handed out in.
 *
 * @param {string} format one of {@link BRAND_RENDER_FORMAT_VALUES}
 * @param {object} context
 * @param {object} context.system the effective system, pins applied
 * @param {string} context.host the site it was derived from
 * @param {string|null} [context.name] the workspace's name
 * @param {Date|string|null} [context.derivedAt] when it was derived
 * @param {object[]} [context.assets] the workspace's stored assets
 * @param {(asset: object) => string|null} [context.assetUrl] how an asset is linked
 * @param {string} [context.voiceNote] the line saying where voice and tone are kept
 * @returns {{text: string, mimeType: string, filename: string}}
 */
export function renderBrand(format, { system, host, name = null, derivedAt = null, assets = [], assetUrl = () => null, voiceNote = null }) {
  const spec = BRAND_RENDER_FORMATS[format];
  if (!spec) throw new Error(`Unknown brand format: ${format}.`);
  const text = {
    dtcg: () => renderDtcg({ system, host }),
    css: () => renderCss({ system, host }),
    tailwind: () => renderTailwind({ system, host }),
    "design-md": () => renderDesignMd({ system, host, name, derivedAt, assets, assetUrl, title: true, voiceNote }),
    "image-prompt": () => renderImagePrompt({ system, host, assets, assetUrl }),
  }[format]();
  // `DESIGN.md` is a name agents look for, so that one is not prefixed with the host.
  const filename = format === "design-md" ? spec.extension : `${String(host).replace(/[^a-z0-9.-]/gi, "-")}.${spec.extension}`;
  return { text, mimeType: spec.mimeType, filename };
}
