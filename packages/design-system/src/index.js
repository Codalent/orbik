/**
 * Public surface of `@orbik/design-system`.
 *
 * A workspace's design system, as the rules more than one process has to share: how colours are
 * compared and judged for contrast, what a person may pin and how pins are laid over what the
 * agent proposed, the one store the worker and the API both write through, and the renderings of
 * a system that the API and the MCP tools both hand out. The agents worker clusters what Chrome
 * sampled and stores a proposal; the API pins values and serves the result; neither has its own
 * idea of what the system is.
 *
 * A name is exported only when something outside this package imports it.
 */
export {
  clusterColors,
  colorDistance,
  contrastGrade,
  contrastRatio,
  formatOklch,
  hexToOklch,
  isHexColor,
  normalizeHex,
  relativeLuminance,
} from "./color.js";
export { applyPins, isPinnable, readPointer, validatePin } from "./pins.js";
export { DesignSystemError, cleanVia, createDesignSystemStore, emptyProposal } from "./store.js";
export { createBrandChangeLog } from "./changes.js";
export { annotateSystem, readableOn, resolveColor, resolveRadius, resolveShadow } from "./system.js";
export { BRAND_RENDER_FORMATS, BRAND_RENDER_FORMAT_VALUES, renderBrand } from "./render/index.js";
export { resolveTokens } from "./render/tokens.js";
