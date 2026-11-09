import { createAssetStore } from "@orbik/assets";
import { BRAND_ASSET_KINDS, BRAND_ASSET_ORIGINS, BRAND_IMAGERY_KINDS, COLLECTIONS } from "@orbik/core";
import { DesignSystemError, createBrandChangeLog, createDesignSystemStore, isPinnable, readPointer } from "@orbik/design-system";
import { ObjectId } from "mongodb";

import { rejectUnknown, requireString } from "./args.js";
import { toolAlias } from "./mcp.js";
import { ToolError, defineTool } from "./registry.js";
import { requireWorkspace } from "./scope.js";

/**
 * The brand chat's hands: the tools that look at what a person uploaded and change the brand.
 *
 * Only the chat on the Brand page is granted these, and it writes as the person who asked — the
 * run's `actor`, taken from the run document, never from anything typed. Every change goes through
 * the brand's change log, so each is listed under the answer with what it replaced and can be
 * undone; a value set here is a pin like one set on the page, kept over every later derivation.
 *
 * None of these is on the MCP surface: an outside AI reads the brand, and changing it is the
 * person's, through Orbik.
 */

/** The largest image handed to the model to look at, in bytes; a larger one is described instead. */
const VIEW_IMAGE_BYTES = 5 * 1024 * 1024;

/** The largest PDF handed to the model to read, in bytes. */
const VIEW_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** The most characters of an SVG's source or a token file handed over as text. */
const VIEW_TEXT_CHARACTERS = 120_000;

/** The kinds an image may be said to be. */
const IMAGE_KINDS = Object.freeze([BRAND_ASSET_KINDS.logo, ...BRAND_IMAGERY_KINDS]);

const named = (tool) => toolAlias(tool);

/** The person the run writes for, or a refusal: these tools change a brand on somebody's behalf. */
function requirePerson(scope) {
  const userId = scope.actor?.userId ?? null;
  if (!userId) {
    throw new ToolError({ code: "NO_PERSON", message: "This run does not say who asked, so it cannot change the brand for them." });
  }
  return userId;
}

/** The workspace's change log, over the stores everything else uses. */
function changeLogFor(database) {
  return createBrandChangeLog({ database, designSystemStore: createDesignSystemStore({ database }), assetStore: createAssetStore({ database }) });
}

/** The host of the workspace's site, for a brand started from uploads; null when there is none. */
async function hostOf(database, workspaceId) {
  const workspace = await database.collection(COLLECTIONS.workspaces).findOne({ _id: new ObjectId(String(workspaceId)) }, { projection: { websiteUrl: 1 } });
  try {
    return new URL(workspace?.websiteUrl).host;
  } catch {
    return null;
  }
}

/** Turns the design-system store's refusal into one the model reads. */
async function withStore(work) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DesignSystemError) throw new ToolError({ code: error.code, message: error.message });
    throw error;
  }
}

/** One uploaded file as the chat is told about it. */
function describeUpload(asset) {
  return {
    id: asset._id.toHexString(),
    kind: asset.kind,
    fileName: asset.fileName ?? null,
    mimeType: asset.mimeType,
    bytes: asset.bytes,
    width: asset.width ?? null,
    height: asset.height ?? null,
    ...(asset.kind === BRAND_ASSET_KINDS.logo ? { form: asset.variant ?? null, drawnFor: asset.tone ?? null } : {}),
    ...(asset.font ? { font: { family: asset.font.family, subfamily: asset.font.subfamily, weight: asset.font.weight, style: asset.font.style } } : {}),
    ...(asset.document ? { pages: asset.document.pages ?? null, title: asset.document.title ?? null } : {}),
    ...(asset.tokens ? { tokens: asset.tokens } : {}),
    caption: asset.caption ?? null,
    hidden: asset.hidden === true,
    uploadedAt: asset.uploadedAt ? asset.uploadedAt.toISOString() : null,
  };
}

/** One change as the chat is told about it, so it can say what it did. */
function describeChange(change) {
  // A pin's sides hold the value under `value`; an image's sides are the fields themselves.
  const side = (part) => (change.kind === "asset" ? part ?? null : part?.value ?? null);
  return { changeId: change._id.toHexString(), before: side(change.before), after: side(change.after) };
}

/** Validates where a value came from: an uploaded file of this workspace and, for a guide, a page. */
function sourceArgument(value, errors) {
  if (value === undefined || value === null) return null;
  const source = rejectUnknown(value, ["fileId", "page"], errors);
  const fileId = requireString(source.fileId, "source.fileId", { max: 24, pattern: /^[0-9a-f]{24}$/, patternDescription: "an uploaded file's id" }, errors);
  let page = null;
  if (source.page !== undefined && source.page !== null) {
    if (!Number.isInteger(source.page) || source.page < 1 || source.page > 10_000) errors.push("source.page must be a page number.");
    else page = source.page;
  }
  return { fileId, page };
}

/** Where a change came from, as the change log records it: the file and page, or the chat. */
async function viaFor(store, workspaceId, source) {
  if (!source) return { kind: "chat" };
  const file = await store.find({ workspaceId, assetId: source.fileId });
  if (!file || file.origin !== BRAND_ASSET_ORIGINS.upload) {
    throw new ToolError({ code: "SOURCE_INVALID", message: `That is not one of this brand's uploaded files. List them with ${named("brand.uploads")}.` });
  }
  return { kind: "upload", assetId: source.fileId, fileName: file.fileName ?? undefined, ...(source.page ? { page: source.page } : {}) };
}

/** The files a person uploaded to the brand. */
const brandUploads = defineTool({
  name: "brand.uploads",
  description:
    "List the files the person has uploaded to the brand — logos, images, brand guides (PDF), fonts and design-token " +
    "files — newest first, with what was read from each: an image's size, a font's family and weight, a guide's page " +
    "count. Look at one with brand.viewFile.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  parseInput(input, errors) {
    rejectUnknown(input, [], errors);
    return {};
  },
  async handler(_input, { database, scope }) {
    const workspaceId = requireWorkspace(scope);
    const all = await createAssetStore({ database }).list({ workspaceId });
    const uploads = all.filter((asset) => asset.origin === BRAND_ASSET_ORIGINS.upload).sort((left, right) => (right.uploadedAt ?? 0) - (left.uploadedAt ?? 0));
    return { total: uploads.length, uploads: uploads.map(describeUpload) };
  },
});

/** One uploaded file, to look at or read. */
const brandViewFile = defineTool({
  name: "brand.viewFile",
  description:
    "Look at one uploaded file. An image comes back as the picture, an SVG as its source, a brand guide as the PDF " +
    "itself to read page by page, a token file as its text; a font as what was read from it (family, style, weight), " +
    "since a font cannot be shown. Use an id from the message's attachments or from brand.uploads.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "The uploaded file's id." } },
    required: ["id"],
    additionalProperties: false,
  },
  parseInput(input, errors) {
    const source = rejectUnknown(input, ["id"], errors);
    return { id: requireString(source.id, "id", { max: 24, pattern: /^[0-9a-f]{24}$/, patternDescription: "an uploaded file's id" }, errors) };
  },
  async handler(input, { database, scope }) {
    const workspaceId = requireWorkspace(scope);
    const store = createAssetStore({ database });
    const asset = await store.find({ workspaceId, assetId: input.id });
    if (!asset) throw new ToolError({ code: "FILE_MISSING", message: `There is no file with that id. List the uploads with ${named("brand.uploads")}.` });
    const facts = describeUpload(asset);

    if (asset.mimeType === "image/svg+xml" || asset.kind === BRAND_ASSET_KINDS.tokens) {
      const text = (await store.read(asset)).toString("utf8");
      return { ...facts, text: text.slice(0, VIEW_TEXT_CHARACTERS), ...(text.length > VIEW_TEXT_CHARACTERS ? { truncated: true } : {}) };
    }
    if (asset.mimeType.startsWith("image/")) {
      if (asset.bytes > VIEW_IMAGE_BYTES) return { ...facts, note: "This image is too large to show; its size and type are above." };
      return { ...facts, inline: { type: "image", mimeType: asset.mimeType, data: (await store.read(asset)).toString("base64"), label: asset.fileName ?? null } };
    }
    if (asset.kind === BRAND_ASSET_KINDS.guide) {
      if (asset.bytes > VIEW_DOCUMENT_BYTES) {
        const pages = await store.guideText(asset);
        return { ...facts, note: "This PDF is too large to read whole; its text, page by page, is below.", text: pages ?? [] };
      }
      return { ...facts, inline: { type: "document", mimeType: "application/pdf", data: (await store.read(asset)).toString("base64"), label: asset.fileName ?? null } };
    }
    if (asset.kind === BRAND_ASSET_KINDS.font) {
      return { ...facts, note: "A font file cannot be shown. Its family, style and weight are above; the Brand page draws the specimen with it." };
    }
    return facts;
  },
});

/** Sets one value of the brand. */
const brandSet = defineTool({
  name: "brand.set",
  description:
    "Set one value of the brand, as the person: a colour, a font family, a type size, a rule list, the primary logo. " +
    "`pointer` says where, as a JSON pointer such as /colors/primary/value, /colors/secondary/value, " +
    "/typography/families/heading/family, /typography/scale/h1/letterSpacing, /rules, /typography/rules or /logos/primary " +
    "(a logo's file id). `source` names the uploaded file — and for a guide the page — the value was taken from, and is " +
    "shown beside it; leave it out when the person said it in the chat. The value replaces whatever the website or an " +
    "earlier change set, is kept over every later reading of the site, and can be undone by the person.",
  inputSchema: {
    type: "object",
    properties: {
      pointer: { type: "string", description: "Where in the brand, e.g. /colors/primary/value." },
      value: { description: "What to set there: a #rrggbb colour, a number, a string, a list of strings, or a logo's file id." },
      source: {
        type: "object",
        description: "The uploaded file the value came from, when it came from one.",
        properties: {
          fileId: { type: "string", description: "The uploaded file's id." },
          page: { type: "integer", description: "The page of a brand guide that says so." },
        },
        required: ["fileId"],
        additionalProperties: false,
      },
    },
    required: ["pointer", "value"],
    additionalProperties: false,
  },
  parseInput(input, errors) {
    const source = rejectUnknown(input, ["pointer", "value", "source"], errors);
    const pointer = requireString(source.pointer, "pointer", { max: 200 }, errors);
    if (pointer && !isPinnable(pointer)) errors.push(`${pointer} is not a place in the brand that can be set.`);
    if (!("value" in source)) errors.push("value is required.");
    return { pointer, value: source.value, source: sourceArgument(source.source, errors) };
  },
  async handler(input, { database, scope }) {
    const workspaceId = requireWorkspace(scope);
    const userId = requirePerson(scope);
    const store = createAssetStore({ database });
    if (input.pointer === "/logos/primary") {
      const logo = typeof input.value === "string" ? await store.find({ workspaceId, assetId: input.value }) : null;
      if (!logo || logo.kind !== BRAND_ASSET_KINDS.logo) {
        throw new ToolError({ code: "PIN_INVALID", message: `The primary logo must be a stored logo's id. Make an uploaded image a logo first with ${named("brand.setImage")}.` });
      }
    }
    const via = await viaFor(store, workspaceId, input.source);
    const { document, change } = await withStore(async () => changeLogFor(database).pin({
      workspaceId, pointer: input.pointer, value: input.value, userId, via, runId: scope.runId ?? null, host: await hostOf(database, workspaceId),
    }));
    return { changed: `set ${input.pointer}`, pointer: input.pointer, value: readPointer(document.system, input.pointer) ?? null, ...describeChange(change) };
  },
});

/** Hands one value back to the website. */
const brandUnset = defineTool({
  name: "brand.unset",
  description:
    "Hand one value of the brand back to what the website says, removing what a person or a file set there. Use it when " +
    "the person asks to go back to the site's value. `pointer` as for brand.set.",
  inputSchema: {
    type: "object",
    properties: { pointer: { type: "string", description: "Where in the brand, e.g. /colors/primary/value." } },
    required: ["pointer"],
    additionalProperties: false,
  },
  parseInput(input, errors) {
    const source = rejectUnknown(input, ["pointer"], errors);
    return { pointer: requireString(source.pointer, "pointer", { max: 200 }, errors) };
  },
  async handler(input, { database, scope }) {
    const workspaceId = requireWorkspace(scope);
    const userId = requirePerson(scope);
    const { change } = await withStore(() => changeLogFor(database).unpin({ workspaceId, pointer: input.pointer, userId, via: { kind: "chat" }, runId: scope.runId ?? null }));
    return { changed: `unset ${input.pointer}`, pointer: input.pointer, ...describeChange(change) };
  },
});

/** Changes what is recorded about one image. */
const brandSetImage = defineTool({
  name: "brand.setImage",
  description:
    "Change what is recorded about one stored image, uploaded or from the website: `kind` (logo, illustration, photo, " +
    "icon), `label` (its name, e.g. 'Acme wordmark'), `caption` (one sentence on what it shows), `variant` for a logo " +
    "(wordmark, symbol or lockup), `tone` for a logo (on-light: drawn for light backgrounds; on-dark: for dark ones), " +
    "`hidden` (true sets it aside: not shown to anyone's AI, e.g. the website's blurry copy of a logo an upload " +
    "replaces) and `isReference` (true marks an image as a style reference for image models).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The image's id." },
      kind: { type: "string", enum: [...IMAGE_KINDS] },
      label: { type: "string" },
      caption: { type: "string" },
      variant: { type: "string", enum: ["wordmark", "symbol", "lockup"] },
      tone: { type: "string", enum: ["on-light", "on-dark"] },
      hidden: { type: "boolean" },
      isReference: { type: "boolean" },
      source: {
        type: "object",
        description: "The uploaded file the decision came from, when it came from one (a guide's page about logos).",
        properties: { fileId: { type: "string" }, page: { type: "integer" } },
        required: ["fileId"],
        additionalProperties: false,
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  parseInput(input, errors) {
    const source = rejectUnknown(input, ["id", "kind", "label", "caption", "variant", "tone", "hidden", "isReference", "source"], errors);
    const id = requireString(source.id, "id", { max: 24, pattern: /^[0-9a-f]{24}$/, patternDescription: "an image id" }, errors);
    const fields = {};
    if (source.kind !== undefined) {
      if (!IMAGE_KINDS.includes(source.kind)) errors.push(`kind must be one of ${IMAGE_KINDS.join(", ")}.`);
      else fields.kind = source.kind;
    }
    for (const [field, max] of [["label", 80], ["caption", 300]]) {
      if (source[field] === undefined) continue;
      const value = requireString(source[field], field, { max }, errors);
      if (value) fields[field] = value.replace(/\s+/g, " ").trim();
    }
    if (source.variant !== undefined) {
      if (!["wordmark", "symbol", "lockup"].includes(source.variant)) errors.push("variant must be wordmark, symbol or lockup.");
      else fields.variant = source.variant;
    }
    if (source.tone !== undefined) {
      if (!["on-light", "on-dark"].includes(source.tone)) errors.push("tone must be on-light or on-dark.");
      else fields.tone = source.tone;
    }
    for (const field of ["hidden", "isReference"]) {
      if (source[field] === undefined) continue;
      if (typeof source[field] !== "boolean") errors.push(`${field} must be true or false.`);
      else fields[field] = source[field];
    }
    if (id && !Object.keys(fields).length) errors.push("Say what to change about the image.");
    return { id, fields, source: sourceArgument(source.source, errors) };
  },
  async handler(input, { database, scope }) {
    const workspaceId = requireWorkspace(scope);
    const userId = requirePerson(scope);
    const store = createAssetStore({ database });
    const image = await store.find({ workspaceId, assetId: input.id });
    if (!image || !image.mimeType.startsWith("image/")) {
      throw new ToolError({ code: "IMAGE_MISSING", message: `There is no image with that id. List uploads with ${named("brand.uploads")} or the brand's images with ${named("brand.assets")}.` });
    }
    // The primary logo cannot be set aside while it is the primary: an AI asking for the logo
    // would be handed nothing.
    if (input.fields.hidden === true) {
      const system = await createDesignSystemStore({ database }).find(workspaceId);
      if (system?.system?.logos?.primary === input.id) {
        throw new ToolError({ code: "PRIMARY_LOGO", message: `That is the primary logo. Make another logo primary with ${named("brand.set")} first.` });
      }
    }
    const via = await viaFor(store, workspaceId, input.source);
    const result = await changeLogFor(database).setAsset({ workspaceId, assetId: input.id, fields: input.fields, userId, via, runId: scope.runId ?? null });
    return { changed: `changed image ${input.id}`, id: input.id, fields: input.fields, changeId: result.change._id.toHexString() };
  },
});

/** Every tool the brand chat changes the brand with, keyed by name. */
export const BRAND_EDIT_TOOLS = Object.freeze({
  [brandUploads.name]: brandUploads,
  [brandViewFile.name]: brandViewFile,
  [brandSet.name]: brandSet,
  [brandUnset.name]: brandUnset,
  [brandSetImage.name]: brandSetImage,
});
