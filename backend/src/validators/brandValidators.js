import { BRAND_ASSET_KINDS, BRAND_ASSET_KIND_VALUES, BRAND_IMAGERY_KINDS } from "@orbik/core";
import { BRAND_RENDER_FORMAT_VALUES, validatePin } from "@orbik/design-system";

import { UPLOAD_HINTS } from "../services/brandUploads.js";
import { isCanonicalObjectId, plainObject, validationError } from "./shared.js";

/** The kinds a person may say an image is: the site's imagery, or a logo. */
const ASSIGNABLE_KINDS = Object.freeze([...BRAND_IMAGERY_KINDS, BRAND_ASSET_KINDS.logo]);

/** The longest caption a person may write for an image. */
const MAX_CAPTION = 300;

/** Validates one canonical asset identifier in a route. */
export function validateAssetScope(req, _res, next) {
  const { assetId } = req.params;
  if (!isCanonicalObjectId(assetId)) {
    return next(validationError([{ field: "assetId", code: "FORMAT", message: "Image identifier is invalid." }]));
  }
  req.validated = { ...req.validated, assetId: String(assetId).toLowerCase() };
  next();
}

/**
 * Validates the optional kinds an asset listing is narrowed to, as `kind=logo,icon`.
 *
 * A kind that is not one is rejected rather than ignored, so a mistyped filter fails visibly
 * instead of quietly listing everything.
 */
export function validateAssetListQuery(req, _res, next) {
  const fields = [];
  for (const key of Object.keys(req.query ?? {})) {
    if (key !== "kind") fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This filter is not accepted." });
  }
  let kinds = null;
  const raw = req.query?.kind;
  if (raw !== undefined && raw !== "") {
    kinds = typeof raw === "string" ? raw.split(",").map((kind) => kind.trim()).filter(Boolean) : [];
    if (!kinds.length || kinds.some((kind) => !BRAND_ASSET_KIND_VALUES.includes(kind))) {
      fields.push({ field: "kind", code: "INVALID", message: `Ask for one or more of: ${BRAND_ASSET_KIND_VALUES.join(", ")}.` });
    }
  }
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, kinds };
  next();
}

/**
 * Validates a pin: where in the system, and what to set there.
 *
 * The rule for what may be pinned and what each place accepts is `validatePin` in
 * `@orbik/design-system`, which the store applies again on the write, so this boundary and the
 * store cannot disagree. This function only turns its finding into the field-level failure the
 * interface shows beside the value.
 */
export function validatePinBody(req, _res, next) {
  const body = plainObject(req.body);
  const fields = [];
  for (const key of Object.keys(body)) {
    if (key !== "pointer" && key !== "value" && key !== "source") fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
  }
  if (!("value" in body)) fields.push({ field: "value", code: "REQUIRED", message: "Say what to set." });
  const checked = validatePin(body.pointer, body.value);
  if (!checked.ok && "value" in body) fields.push({ field: "value", code: "INVALID", message: checked.message });
  const source = sourceOf(body.source, fields);
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, pointer: checked.pointer, value: checked.value, source };
  next();
}

/**
 * Validates the optional uploaded file a value was taken from — `{assetId, page}` — for a value a
 * person accepts from a brand guide ("Add it"). Whether the file is the workspace's is checked by
 * the service; this is its shape.
 */
function sourceOf(value, fields) {
  if (value === undefined || value === null) return null;
  const source = plainObject(value);
  for (const key of Object.keys(source)) {
    if (key !== "assetId" && key !== "page") fields.push({ field: `source.${key}`, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
  }
  if (!isCanonicalObjectId(source.assetId)) fields.push({ field: "source.assetId", code: "FORMAT", message: "Name the uploaded file." });
  if (source.page !== undefined && source.page !== null && (!Number.isInteger(source.page) || source.page < 1 || source.page > 10_000)) {
    fields.push({ field: "source.page", code: "FORMAT", message: "A page is a whole number." });
  }
  return { assetId: String(source.assetId).toLowerCase(), page: Number.isInteger(source.page) ? source.page : null };
}

/** Validates the change to undo, in a route. */
export function validateChangeScope(req, _res, next) {
  const { changeId } = req.params;
  if (!isCanonicalObjectId(changeId)) {
    return next(validationError([{ field: "changeId", code: "FORMAT", message: "Change identifier is invalid." }]));
  }
  req.validated = { ...req.validated, changeId: String(changeId).toLowerCase() };
  next();
}

/**
 * Validates an upload's query: the file's name on the person's machine and where it was dropped.
 * The bytes are the body, read raw by the route; what they are is decided from the bytes.
 */
export function validateUploadQuery(req, _res, next) {
  const fields = [];
  for (const key of Object.keys(req.query ?? {})) {
    if (key !== "name" && key !== "for") fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
  }
  const name = typeof req.query?.name === "string" ? req.query.name.trim() : "";
  if (name.length > 200) fields.push({ field: "name", code: "RANGE", message: "That file name is too long." });
  const hint = typeof req.query?.for === "string" && req.query.for ? req.query.for : null;
  if (hint && !UPLOAD_HINTS.includes(hint)) fields.push({ field: "for", code: "INVALID", message: `Say one of: ${UPLOAD_HINTS.join(", ")}.` });
  if (!Buffer.isBuffer(req.body)) fields.push({ field: "body", code: "REQUIRED", message: "Send the file as the request body." });
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, fileName: name || null, hint, bytes: req.body };
  next();
}

/** Validates the pointer of a pin to remove. */
export function validateUnpinBody(req, _res, next) {
  const body = plainObject(req.body);
  const fields = [];
  for (const key of Object.keys(body)) {
    if (key !== "pointer") fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
  }
  if (typeof body.pointer !== "string" || !body.pointer.startsWith("/") || body.pointer.length > 200) {
    fields.push({ field: "pointer", code: "INVALID", message: "Say which value to unpin." });
  }
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, pointer: body.pointer };
  next();
}

/** Validates which form the system is asked for in. */
export function validateRenderQuery(req, _res, next) {
  const fields = [];
  for (const key of Object.keys(req.query ?? {})) {
    if (key !== "format") fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This filter is not accepted." });
  }
  const format = req.query?.format;
  if (typeof format !== "string" || !BRAND_RENDER_FORMAT_VALUES.includes(format)) {
    fields.push({ field: "format", code: "INVALID", message: `Ask for one of: ${BRAND_RENDER_FORMAT_VALUES.join(", ")}.` });
  }
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, format };
  next();
}

/** Validates the number of a kept version in a route. */
export function validateRevisionScope(req, _res, next) {
  const revision = Number(req.params.revision);
  if (!Number.isInteger(revision) || revision < 1 || revision > 1_000_000) {
    return next(validationError([{ field: "revision", code: "FORMAT", message: "Version number is invalid." }]));
  }
  req.validated = { ...req.validated, revision };
  next();
}

/**
 * Validates what a person decided about one image.
 *
 * Any of four things, each optional and at least one present. `null` hands a field back to the
 * agent, which is how "let the agent decide again" is said.
 */
export function validateAssetBody(req, _res, next) {
  const body = plainObject(req.body);
  const fields = [];
  const changes = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "isReference" || key === "hidden") {
      if (value !== null && typeof value !== "boolean") fields.push({ field: key, code: "INVALID", message: "Say yes or no." });
      else changes[key] = value;
    } else if (key === "kind") {
      if (value !== null && !ASSIGNABLE_KINDS.includes(value)) fields.push({ field: key, code: "INVALID", message: `Choose one of: ${ASSIGNABLE_KINDS.join(", ")}.` });
      else changes.kind = value;
    } else if (key === "tone") {
      if (value !== null && value !== "on-light" && value !== "on-dark") fields.push({ field: key, code: "INVALID", message: "Say on-light or on-dark." });
      else changes.tone = value;
    } else if (key === "caption") {
      if (value !== null && (typeof value !== "string" || !value.trim() || value.length > MAX_CAPTION)) {
        fields.push({ field: key, code: "INVALID", message: `Write a caption of up to ${MAX_CAPTION} characters.` });
      } else {
        changes.caption = value === null ? null : value.replace(/\s+/g, " ").trim();
      }
    } else {
      fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
    }
  }
  if (!fields.length && !Object.keys(changes).length) fields.push({ field: "body", code: "REQUIRED", message: "Say what to change." });
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, changes };
  next();
}

/**
 * Reads what a signed link carries: the asset, when the link ends, and the signature.
 *
 * Shape only. Whether the signature matches is the service's to say, with one answer for every
 * way a link can be wrong; a malformed link gets that same answer rather than a validation error
 * that would describe what a well-formed one looks like.
 */
export function readSignedAssetLink(req, _res, next) {
  req.validated = {
    assetId: isCanonicalObjectId(req.params.assetId) ? String(req.params.assetId).toLowerCase() : "",
    exp: typeof req.query?.exp === "string" ? req.query.exp : "",
    sig: typeof req.query?.sig === "string" ? req.query.sig : "",
  };
  next();
}
