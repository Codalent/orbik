import { createAssetStore } from "@orbik/assets";
import { BRAND_ASSET_KINDS, BRAND_ASSET_KIND_VALUES, BRAND_IMAGERY_KINDS, BRAND_LIMITS, BRAND_PRIVATE_KINDS, COLLECTIONS } from "@orbik/core";
import { BRAND_RENDER_FORMATS, BRAND_RENDER_FORMAT_VALUES, createDesignSystemStore, renderBrand, resolveTokens } from "@orbik/design-system";
import { createLibraryStore } from "@orbik/library";

import { rejectUnknown, requireString } from "./args.js";
import { toolAlias } from "./mcp.js";
import { ToolError, defineTool } from "./registry.js";
import { requireWorkspace } from "./scope.js";

/**
 * The brand: a workspace's design system, read by whatever is about to make something for it.
 *
 * These are the tools the design system exists for. Everything upstream — rendering the site,
 * measuring it, proposing a system, a person pinning what they know better — ends in one question
 * from somebody's own AI: "what does this company look like?" `brand.get` answers it in one call,
 * small enough to sit in a context for a whole conversation, and the other four are for the cases
 * where one call is not enough: the tokens as tokens, the system in a format, the images, one
 * image.
 *
 * Three decisions are worth knowing before changing any of them.
 *
 * **What is served is the system a person corrected**, never the agent's raw proposal. Pins are
 * already applied, and each value says whether it was observed on the site, derived, proposed, or
 * pinned by a person — so a reader can weigh a proposed error colour differently from an observed
 * primary.
 *
 * **Images leave as links that expire, or inline.** An outside AI has no Orbik session, and an
 * image model can only be handed a URL, so an asset is given as a signed link good for an hour.
 * `brand.asset` returns the picture itself for a client that can look at one. Assets a person —
 * or the agent — set aside as not the brand's own are never listed and never served.
 *
 * **A workspace with no system says so.** `BRAND_NOT_DERIVED` is a refusal, not an empty object:
 * a model handed `{}` would conclude the brand has no colours and invent some.
 */

/** The kinds a listing answers with when none is named: the brand's own marks and imagery. */
const DEFAULT_KINDS = Object.freeze([BRAND_ASSET_KINDS.logo, ...BRAND_IMAGERY_KINDS]);

/**
 * The kinds an outside AI may ask for: every kind but the private ones. A font a person uploaded
 * is used to draw the brand in its real face and is never handed out — its licence is theirs.
 */
const LISTABLE_KINDS = Object.freeze(BRAND_ASSET_KIND_VALUES.filter((kind) => !BRAND_PRIVATE_KINDS.includes(kind)));

/** The most characters of a brand guide's text `brand.asset` returns in one answer. */
const GUIDE_CHARACTERS = 120_000;

/** How many reference images `brand.get` carries. Enough to show a style, few enough to stay small. */
const REFERENCES_IN_SUMMARY = 3;

/** The longest reason `brand.get` gives for something it could not determine. DESIGN.md has it whole. */
const SUMMARY_REASON = 140;

/**
 * A tool's name as the model reading a result knows it.
 *
 * A result is read by a model that was shown these tools under their aliases — over MCP, and
 * inside an agent run too, since a function name cannot carry a dot — so a result that points at
 * another tool names it the way it can actually be called.
 */
const named = (tool) => toolAlias(tool);

/** How the system is to be used, said once in the one call most agents make. */
const HOW_TO_USE =
  "This is the company's own design system, derived from its website as rendered and corrected by a person. Use these values exactly: " +
  "do not round, substitute or 'improve' them. `source` says how much weight each carries: observed and pinned are facts about the brand; " +
  "derived is a tidying of observed values; proposed fills a gap the site leaves and may be changed if it does not fit. " +
  "Use the logo file as it is and never redraw it. For an image, put graphics.imagePrompt.stylePrefix before your subject and pass the " +
  "reference images to the image model. Fonts are named, not supplied: load them, or use the listed fallbacks. " +
  `For the same system as tokens or a stylesheet, call ${named("brand.tokens")} or ${named("brand.render")}.`;

/** Reads a workspace's design system, or refuses saying there is none. */
async function requireSystem(database, scope) {
  const workspaceId = requireWorkspace(scope);
  const document = await createDesignSystemStore({ database }).find(workspaceId);
  if (!document?.system) {
    throw new ToolError({
      code: "BRAND_NOT_DERIVED",
      message:
        "No design system has been derived for this workspace yet. A person derives one on the Brand page in Orbik. " +
        "Say so rather than inventing colours or fonts for this company.",
    });
  }
  return { workspaceId, document };
}

/** The workspace's name, for a title; null when it cannot be read. */
async function workspaceName(database, workspaceId) {
  const workspace = await database.collection(COLLECTIONS.workspaces).findOne({ _id: workspaceId }, { projection: { name: 1 } });
  return workspace?.name ?? null;
}

/**
 * Builds the function that turns an asset into a link, and says whether links are available.
 *
 * The signer is a collaborator handed in through the tools' context, as the retrieval index is:
 * it holds a secret, and only the API has one. Without it an asset is still listed, with no link
 * and a reason, so a model can fall back to reading the image inline.
 */
function linker(assetUrls, workspaceId) {
  if (!assetUrls) {
    return {
      available: false,
      link: () => null,
      note: `Image links are not configured on this deployment (ASSET_LINKS_NOT_CONFIGURED). Read an image inline with ${named("brand.asset")} instead.`,
    };
  }
  return {
    available: true,
    link: (asset) => assetUrls.sign({ assetId: asset._id.toHexString(), workspaceId: String(workspaceId) }),
    note: `Image links work for ${Math.round(assetUrls.ttlSeconds / 60)} minutes and need no credential. Call again for fresh ones.`,
  };
}

/**
 * One asset as a listing shows it.
 *
 * `brief` is the form `brand.get` uses: the same asset without its byte count and without the
 * moment its link expires, which that answer says once for all of them.
 */
function describeAsset(asset, links, { brief = false } = {}) {
  const signed = links.link(asset);
  return {
    id: asset._id.toHexString(),
    kind: asset.kind,
    caption: asset.caption ?? asset.label ?? asset.alt ?? null,
    mimeType: asset.mimeType,
    width: asset.width ?? null,
    height: asset.height ?? null,
    ...(brief ? {} : { bytes: asset.bytes }),
    ...(asset.kind === BRAND_ASSET_KINDS.logo ? { form: asset.variant ?? null, drawnFor: asset.tone ?? null } : {}),
    ...(asset.isReference && !brief ? { isReference: true } : {}),
    url: signed?.url ?? null,
    ...(brief ? {} : { expiresAt: signed?.expiresAt ?? null }),
  };
}

/**
 * A component recipe without the fields that say nothing: no border, no shadow, no transform.
 *
 * `brand.get` is read in full by a model every time it is called, so a field whose value is
 * "none" is a line spent telling it nothing.
 */
function leanRecipe(recipe) {
  if (!recipe) return null;
  return Object.fromEntries(Object.entries(recipe).filter(([field, value]) => {
    if (value === null || value === undefined || value === "" || value === "none") return false;
    if (field === "borderWidth" && (value === 0 || !recipe.borderColor)) return false;
    return true;
  }));
}

/** The whole system in one small answer. */
const brandGet = defineTool({
  name: "brand.get",
  description:
    "Get this company's design system: its colours by role, typefaces and type scale, spacing, radii and shadows, " +
    "component recipes, the rules for using them, a summary of its graphics language with an image prompt, and its logo " +
    "and reference images as links. Call this first, before producing anything that has to look like this company — a " +
    "page, a component, a slide, a graphic, an image. One call is usually enough. Every value says whether it was " +
    "observed on the site, derived, proposed, or pinned by a person. For the same system as design tokens call " +
    "brand.tokens; as CSS, a Tailwind theme, a DESIGN.md or an image prompt call brand.render; for more of the " +
    "company's own images call brand.assets.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  parseInput(input, errors) {
    rejectUnknown(input, [], errors);
    return {};
  },
  async handler(_input, { database, scope, assetUrls = null }) {
    const { workspaceId, document } = await requireSystem(database, scope);
    const system = document.system;
    const tokens = resolveTokens(system);
    const links = linker(assetUrls, workspaceId);
    const assets = await createAssetStore({ database }).list({ workspaceId, kinds: [...DEFAULT_KINDS], includeHidden: false });
    const logos = assets.filter((asset) => asset.kind === BRAND_ASSET_KINDS.logo);
    const primary = logos.find((asset) => asset._id.toHexString() === system.logos?.primary) ?? logos[0] ?? null;
    const references = assets.filter((asset) => asset.isReference === true && asset.kind !== BRAND_ASSET_KINDS.logo).slice(0, REFERENCES_IN_SUMMARY);
    const guides = await createAssetStore({ database }).list({ workspaceId, kinds: [BRAND_ASSET_KINDS.guide], includeHidden: false });
    const contrast = (colour) => (colour?.contrastOn?.background ? `${colour.contrastOn.background.ratio}:1 on background (${colour.contrastOn.background.grade})` : undefined);

    return {
      site: document.host,
      derivedAt: document.derivedAt ? document.derivedAt.toISOString() : null,
      howToUse: HOW_TO_USE,
      personality: system.personality ?? null,
      colors: Object.fromEntries(tokens.colors.map((colour) => [
        colour.role,
        { value: colour.value, source: colour.source, usage: colour.usage || undefined, contrast: contrast(system.colors[colour.role]) },
      ])),
      typography: {
        families: Object.fromEntries(tokens.fonts.map((font) => [
          font.role,
          { family: font.family, fallbacks: system.typography.families[font.role].fallbacks, weights: font.weights, source: font.source },
        ])),
        // What each step is used for is in DESIGN.md; here a step is its numbers, and its source
        // only when that is not the ordinary one.
        scale: Object.fromEntries(tokens.type.map((step) => [
          step.token,
          { px: step.px, lineHeight: step.lineHeight, weight: step.weight, letterSpacingEm: step.letterSpacing || undefined, family: step.family, source: step.source === "observed" ? undefined : step.source },
        ])),
        rules: system.typography?.rules ?? [],
      },
      spacing: tokens.spacing,
      shape: {
        radius: Object.fromEntries(tokens.radius.map((radius) => [radius.token, radius.px])),
        borderWidth: tokens.borderWidth,
        shadows: Object.fromEntries(tokens.shadows.map((shadow) => [shadow.token, shadow.value])),
      },
      // Recipes with their tokens already resolved: a button's background is a colour here, not
      // the name of one, because the reader is about to write it down.
      components: {
        button: Object.fromEntries(Object.entries(tokens.components.button).filter(([, recipe]) => recipe).map(([variant, recipe]) => [variant, leanRecipe(recipe)])),
        ...Object.fromEntries(["input", "card", "nav", "footer"].filter((kind) => tokens.components[kind]).map((kind) => [kind, leanRecipe(tokens.components[kind])])),
      },
      rules: system.rules ?? [],
      graphics: system.graphics
        ? {
            medium: system.graphics.medium,
            description: system.graphics.description,
            iconography: system.graphics.iconography?.style ?? null,
            doNot: system.graphics.doNot ?? [],
            imagePrompt: system.graphics.imagePrompt ?? null,
          }
        : null,
      logo: primary ? { ...describeAsset(primary, links, { brief: true }), description: system.graphics?.logo?.description ?? null, usage: system.graphics?.logo?.usage ?? [] } : null,
      referenceImages: references.map((asset) => describeAsset(asset, links, { brief: true })),
      // The brand guides the company uploaded: the source many of these values were taken from,
      // to read in full when a question needs more than the system says.
      ...(guides.length
        ? {
            guides: guides.map((guide) => ({
              id: guide._id.toHexString(),
              fileName: guide.fileName ?? null,
              title: guide.document?.title ?? null,
              pages: guide.document?.pages ?? null,
              url: links.link(guide)?.url ?? null,
              read: `Read its text, page by page, with ${named("brand.asset")} and this id.`,
            })),
          }
        : {}),
      undetermined: (system.undetermined ?? []).map((entry) => ({
        field: entry.field,
        reason: entry.reason.length > SUMMARY_REASON ? `${entry.reason.slice(0, SUMMARY_REASON - 1).trimEnd()}…` : entry.reason,
      })),
      // The words are not here on purpose: how the company sounds is the Library's to say, and
      // repeating it would be a second home for the same facts.
      voice: `Voice and tone are not part of the design system. Read the Library's overview, ${(await createLibraryStore({ database }).roles({ scope })).overview}, with ${named("library.read")} for what the company says and how it says it.`,
      assetLinks: links.note,
    };
  },
});

/** The system as design tokens. */
const brandTokens = defineTool({
  name: "brand.tokens",
  description:
    "Get this company's design system as design tokens in the Design Tokens Community Group format: colours, font " +
    "families and weights, composite typography styles, spacing, sizes, radii, borders and shadows, each typed, with " +
    "where it came from in an extension. Use it when you are feeding a token pipeline, a design tool or a theme " +
    "generator; for reading the system yourself, brand.get is smaller and says more.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  parseInput(input, errors) {
    rejectUnknown(input, [], errors);
    return {};
  },
  async handler(_input, { database, scope }) {
    const { document } = await requireSystem(database, scope);
    const rendered = renderBrand("dtcg", { system: document.system, host: document.host });
    return { site: document.host, format: "dtcg", tokens: JSON.parse(rendered.text) };
  },
});

/** The system in one of the forms it is written out in. */
const brandRender = defineTool({
  name: "brand.render",
  description:
    "Get this company's design system written out in one format, as text ready to save or paste: `css` (custom " +
    "properties, with the components as classes over them), `tailwind` (a Tailwind 4 @theme block, with the Tailwind 3 " +
    "config beneath), `design-md` (the whole system as one Markdown file, for a coding agent's context or a repository), " +
    "`image-prompt` (the style paragraph, what to avoid, the palette and the reference images, for an image model), or " +
    "`dtcg` (design tokens as JSON). The pinned values are already in it.",
  inputSchema: {
    type: "object",
    properties: {
      format: { type: "string", enum: [...BRAND_RENDER_FORMAT_VALUES], description: "Which form to write the system in." },
    },
    required: ["format"],
    additionalProperties: false,
  },
  parseInput(input, errors) {
    const source = rejectUnknown(input, ["format"], errors);
    const format = requireString(source.format, "format", { max: 40 }, errors);
    if (format && !BRAND_RENDER_FORMAT_VALUES.includes(format)) errors.push(`format must be one of ${BRAND_RENDER_FORMAT_VALUES.join(", ")}.`);
    return { format };
  },
  async handler(input, { database, scope, assetUrls = null }) {
    const { workspaceId, document } = await requireSystem(database, scope);
    const links = linker(assetUrls, workspaceId);
    const assets = await createAssetStore({ database }).list({ workspaceId, includeHidden: false });
    const rendered = renderBrand(input.format, {
      system: document.system,
      host: document.host,
      name: await workspaceName(database, workspaceId),
      derivedAt: document.derivedAt,
      assets,
      assetUrl: (asset) => links.link(asset)?.url ?? null,
      voiceNote: `Voice and tone are not part of this file: they are in the Orbik Library's overview, ${(await createLibraryStore({ database }).roles({ scope })).overview}.`,
    });
    return { site: document.host, format: input.format, label: BRAND_RENDER_FORMATS[input.format].label, filename: rendered.filename, mimeType: rendered.mimeType, text: rendered.text };
  },
});

/** The brand's stored images. */
const brandAssets = defineTool({
  name: "brand.assets",
  description:
    "List the company's own stored images, each with a caption, its size and a link: its logos, illustrations, " +
    "photographs and icons, as collected from its website. Pass `kind` for one kind only — `logo`, `illustration`, " +
    "`photo`, `icon`, or `screenshot`, `clip`, `specimen`, `swatches`, `contact-sheet` for the pictures Orbik took of the " +
    "site itself, or `guide` for the brand guidelines the company uploaded and `tokens` for its design-token files. " +
    "Images marked `isReference` are the ones that best show the brand's style. Links work for an hour " +
    "without a credential, so they can be handed to an image model; to look at one yourself, call brand.asset with its id.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...LISTABLE_KINDS], description: "Only this kind. Omit for logos and the brand's own imagery." },
    },
    additionalProperties: false,
  },
  parseInput(input, errors) {
    const source = rejectUnknown(input, ["kind"], errors);
    const kind = requireString(source.kind, "kind", { max: 40, required: false }, errors) || null;
    if (kind && !LISTABLE_KINDS.includes(kind)) errors.push(`kind must be one of ${LISTABLE_KINDS.join(", ")}.`);
    return { kind };
  },
  async handler(input, { database, scope, assetUrls = null }) {
    const workspaceId = requireWorkspace(scope);
    const links = linker(assetUrls, workspaceId);
    const assets = await createAssetStore({ database }).list({ workspaceId, kinds: input.kind ? [input.kind] : [...DEFAULT_KINDS], includeHidden: false });
    return {
      total: assets.length,
      assets: assets.map((asset) => describeAsset(asset, links)),
      assetLinks: links.note,
      ...(assets.length ? {} : { note: "No images of that kind are stored. They are collected when the design system is derived on the Brand page in Orbik." }),
    };
  },
});

/** One image, to look at. */
const brandAsset = defineTool({
  name: "brand.asset",
  description:
    "Get one of the company's stored images by its id, to look at it: a raster image comes back as an image, and an " +
    "SVG as its source, which you can read, restyle and reuse. Use an id from brand.get or brand.assets. An image too " +
    "large to return inline comes back as a link instead. A brand guide comes back as its text, page by page, and a " +
    "token file as its text.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "The image's id, from brand.get or brand.assets." } },
    required: ["id"],
    additionalProperties: false,
  },
  parseInput(input, errors) {
    const source = rejectUnknown(input, ["id"], errors);
    return { id: requireString(source.id, "id", { max: 24, pattern: /^[0-9a-f]{24}$/, patternDescription: "an image id from brand.assets" }, errors) };
  },
  async handler(input, { database, scope, assetUrls = null }) {
    const workspaceId = requireWorkspace(scope);
    const store = createAssetStore({ database });
    const asset = await store.find({ workspaceId, assetId: input.id });
    // An image set aside as not the brand's own is not served by any door, and is answered the
    // same way as one that does not exist.
    if (!asset || asset.hidden === true || BRAND_PRIVATE_KINDS.includes(asset.kind)) {
      throw new ToolError({ code: "ASSET_MISSING", message: `There is no stored image with that id. List the ones there are with ${named("brand.assets")}.` });
    }
    const links = linker(assetUrls, workspaceId);
    const described = describeAsset(asset, links);
    // A brand guide is read as its text, page by page, with a link to the PDF itself.
    if (asset.kind === BRAND_ASSET_KINDS.guide) {
      const pages = (await store.guideText(asset)) ?? [];
      let text = pages.map((page, index) => `--- Page ${index + 1} ---\n${page}`).join("\n\n");
      const truncated = text.length > GUIDE_CHARACTERS || asset.document?.truncated === true;
      if (text.length > GUIDE_CHARACTERS) text = `${text.slice(0, GUIDE_CHARACTERS)}…`;
      return {
        ...described,
        fileName: asset.fileName ?? null,
        pages: asset.document?.pages ?? pages.length,
        ...(truncated ? { note: "The guide's text is cut short here. The PDF at the link has all of it." } : {}),
        // In the answer itself rather than as an inline block: a client that reads a tool's
        // structured result would otherwise never see the words.
        text: text || "No text could be read from this PDF; it may be made of pictures. Open it from its link.",
      };
    }
    if (asset.kind === BRAND_ASSET_KINDS.tokens) {
      const text = (await store.read(asset)).toString("utf8");
      return { ...described, fileName: asset.fileName ?? null, text: text.slice(0, GUIDE_CHARACTERS) };
    }
    if (asset.bytes > BRAND_LIMITS.inlineBytes) {
      return { ...described, inline: null, note: described.url ? "This image is too large to return inline; fetch it from its link." : "This image is too large to return inline, and image links are not configured on this deployment." };
    }
    const bytes = await store.read(asset);
    // An SVG is handed over as text: it is the one image format a model can read as well as see,
    // and most clients will not take it as an image at all.
    const inline = asset.mimeType === "image/svg+xml"
      ? { type: "text", mimeType: asset.mimeType, text: bytes.toString("utf8") }
      : { type: "image", mimeType: asset.mimeType, data: bytes.toString("base64") };
    return { ...described, inline };
  },
});

/** Every brand tool, keyed by name. */
export const BRAND_TOOLS = Object.freeze({
  [brandGet.name]: brandGet,
  [brandTokens.name]: brandTokens,
  [brandRender.name]: brandRender,
  [brandAssets.name]: brandAssets,
  [brandAsset.name]: brandAsset,
});
