/**
 * The vocabulary of the agent that derives a workspace's design system from its website.
 *
 * It lives in `@orbik/core` for the reason the other agents' does: more than one process has to
 * agree on it. The agents worker publishes the definition under the slug and stores what Chrome
 * saw within these limits, the API serves the stored assets and refuses the same kinds, and the
 * MCP tools filter by them. A limit the worker stored at and the API validated at would be two
 * numbers that drift apart.
 */

/** The agent that derives the design system. */
export const DESIGN_SYSTEM_AGENT_SLUG = "design-system";

/**
 * What a stored brand asset is.
 *
 * A closed set because each kind is read by something different: logos and reference images are
 * handed to outside AIs, screenshots and clips are shown beside the proposal on the Brand page,
 * and the specimen and the two sheets are what the model is shown instead of font files and a
 * folder of pictures.
 */
export const BRAND_ASSET_KINDS = Object.freeze({
  logo: "logo",
  icon: "icon",
  illustration: "illustration",
  photo: "photo",
  /** A viewport or a full page, as Chrome rendered it. */
  screenshot: "screenshot",
  /** One component cut out of a page: a button, a card, the navigation bar. */
  clip: "clip",
  /** The site's own fonts set at its own sizes, as an image. Stands in for the font files. */
  specimen: "specimen",
  /** The observed palette as labelled chips, as an image. */
  swatches: "swatches",
  /** Every harvested image on one sheet, which is what the graphics-language call is shown. */
  contactSheet: "contact-sheet",
  /**
   * A font file a person uploaded. Used to draw the specimen in the real face, privately: it is
   * never listed or served to an outside AI, because a font's licence rarely allows passing it on.
   */
  font: "font",
  /** A brand guide a person uploaded, as a PDF: read by the brand chat, and readable over MCP. */
  guide: "guide",
  /** A design-token file a person uploaded: DTCG JSON, or CSS custom properties. */
  tokens: "tokens",
});

/** Every asset kind, as an array. */
export const BRAND_ASSET_KIND_VALUES = Object.freeze(Object.values(BRAND_ASSET_KINDS));

/**
 * The kinds only a person uploads. Never harvested, never removed by a run's clean-up.
 */
export const BRAND_DOCUMENT_KINDS = Object.freeze([
  BRAND_ASSET_KINDS.font,
  BRAND_ASSET_KINDS.guide,
  BRAND_ASSET_KINDS.tokens,
]);

/**
 * The kinds an outside AI may never be handed, by any door: listed nowhere, served by no link.
 */
export const BRAND_PRIVATE_KINDS = Object.freeze([BRAND_ASSET_KINDS.font]);

/** Where a stored asset came from: the website, through a run, or a person's upload. */
export const BRAND_ASSET_ORIGINS = Object.freeze({ site: "site", upload: "upload" });

/**
 * Bounds on what a person may upload to a workspace's brand.
 *
 * Apart from {@link BRAND_LIMITS}, which a derivation prunes against: an upload is never pruned
 * and does not take room from what the website gave.
 */
export const BRAND_UPLOAD_LIMITS = Object.freeze({
  /** Files one workspace may hold as uploads. */
  files: 40,
  /** Bytes one uploaded file may be. */
  fileBytes: 20 * 1024 * 1024,
  /** Bytes a workspace's uploads may add up to. */
  bytes: 200 * 1024 * 1024,
  /** Pages of a brand guide that are read; a longer PDF is refused. */
  guidePages: 100,
  /** Characters of a guide's text kept for outside AIs to read, all pages together. */
  guideCharacters: 400_000,
  /** Files one chat message may carry. */
  perMessage: 10,
});

/**
 * The kinds that are the site's own imagery, harvested from its pages.
 *
 * Told apart from the kinds Orbik made itself (screenshots, clips, sheets) because only these can
 * be a reference image for an image model, and only these are capped per kind by a run.
 */
export const BRAND_IMAGERY_KINDS = Object.freeze([
  BRAND_ASSET_KINDS.photo,
  BRAND_ASSET_KINDS.illustration,
  BRAND_ASSET_KINDS.icon,
]);

/**
 * Bounds on what one workspace's brand may hold, and on what one run may do.
 *
 * The page cap is the one that decides what a run costs: eight pages at two viewports is a few
 * minutes of Chrome and enough to see a navigation bar, a hero, body copy, a form, a card and a
 * footer. The asset caps bound storage rather than judgement — binary files are the one thing in
 * Orbik that is not a few kilobytes of JSON.
 */
export const BRAND_LIMITS = Object.freeze({
  /** Pages one derivation renders, the home page included. */
  pages: 8,
  /** Assets one workspace keeps, of every kind. */
  assets: 60,
  /** Bytes one workspace's assets may add up to. */
  bytes: 40 * 1024 * 1024,
  /** Bytes one asset may be. An image larger than this once resized is not kept. */
  assetBytes: 4 * 1024 * 1024,
  /** The longest edge a stored raster keeps, in pixels. */
  rasterEdge: 1600,
  /** Photographs and illustrations one run keeps: the largest unique ones. */
  images: 12,
  /** Icons and small illustrative SVGs one run keeps. */
  icons: 24,
  /** Logo variants one run keeps. */
  logos: 8,
  /** Full-page screenshots are cut at this height, in pixels. */
  fullPageHeight: 6000,
  /** Observation records kept per workspace, newest first. */
  observations: 5,
  /** Earlier versions of the system kept per workspace. */
  revisions: 10,
  /** The largest image handed to an outside AI inline; a larger one is given as a link instead. */
  inlineBytes: 1024 * 1024,
  /** How long a signed asset link works, in seconds. */
  urlTtlSeconds: 60 * 60,
});
