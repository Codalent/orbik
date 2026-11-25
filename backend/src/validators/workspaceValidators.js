import { WORKSPACE_ICON_CHOICES, WORKSPACE_ICON_ORIGINS } from "@orbik/assets";
import { classifyAddress } from "@orbik/core";

import { isCanonicalObjectId, plainObject, validationError } from "./shared.js";

/** Canonicalizes and validates a workspace name at the API boundary. */
function canonicalizeWorkspaceName(value) {
  if (typeof value !== "string") throw new Error("Workspace name must be text.");
  const name = value.trim().normalize("NFC");
  const characterCount = [...name].length;
  if (characterCount < 1 || characterCount > 80) throw new Error("Workspace name must be 1 to 80 characters.");
  if ([...name].some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || (code >= 127 && code <= 159);
  })) throw new Error("Workspace name contains unsupported control characters.");
  return name;
}

/** Parses a website URL and rejects local/private targets without performing a network request. */
export function canonicalizePublicUrl(value) {
  if (typeof value !== "string") throw new Error("Website URL must be text.");
  const input = value.trim();
  if (input.length < 1 || input.length > 2048) throw new Error("Website URL must be 1 to 2048 characters.");
  let url;
  try { url = new URL(input); } catch { throw new Error("Enter a complete website URL."); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Website URL must use HTTP or HTTPS.");
  if (url.username || url.password) throw new Error("Website URL cannot contain credentials.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const address = classifyAddress(hostname);
  const isIpLiteral = address.range !== null;
  if (!hostname || hostname === "localhost" || /\.(?:localhost|local|internal|home|lan)$/iu.test(hostname) || (!hostname.includes(".") && !isIpLiteral)) {
    throw new Error("Website URL must use a public hostname.");
  }
  if (isIpLiteral && !address.isPublic) {
    throw new Error("Website URL must not use a private or reserved address.");
  }
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  const canonical = url.toString();
  if (canonical.length > 2048) throw new Error("Website URL must not exceed 2048 characters.");
  return canonical;
}

/**
 * A workspace's website as people type it: a bare host (`example.com`, `www.example.com`) means
 * `https://` there. Input that names a scheme is left as it is, and anything that is not a public
 * host still fails `canonicalizePublicUrl`. A workspace's website and the crawl's start address
 * are read this way; sitemaps are full URLs.
 */
export function withAssumedScheme(value) {
  if (typeof value !== "string") return value;
  const input = value.trim();
  if (!input || /^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input;
  return `https://${input.replace(/^\/\//, "")}`;
}

/** Validates the exact workspace creation body and idempotency header. */
export function validateWorkspaceCreate(req, _res, next) {
  const fields = [];
  const keys = Object.keys(plainObject(req.body));
  if (keys.length !== 2 || !keys.includes("name") || !keys.includes("websiteUrl")) {
    fields.push({ field: "request", code: "UNKNOWN_FIELD", message: "Only name and websiteUrl are allowed." });
  }
  let name;
  let websiteUrl;
  try { name = canonicalizeWorkspaceName(req.body?.name); } catch (error) {
    fields.push({ field: "name", code: "INVALID", message: error.message });
  }
  try { websiteUrl = canonicalizePublicUrl(withAssumedScheme(req.body?.websiteUrl)); } catch (error) {
    fields.push({ field: "websiteUrl", code: "INVALID", message: error.message });
  }
  const idempotencyKey = req.get("Idempotency-Key")?.trim();
  if (!idempotencyKey || !/^[A-Za-z0-9._:-]{16,128}$/u.test(idempotencyKey)) {
    fields.push({ field: "idempotencyKey", code: "FORMAT", message: "Idempotency-Key must contain 16 to 128 safe characters." });
  }
  if (fields.length) return next(validationError(fields));
  req.validated = { name, websiteUrl, idempotencyKey };
  next();
}

/** Validates one canonical MongoDB workspace route identifier. */
export function validateWorkspaceSelection(req, _res, next) {
  const { workspaceId } = req.params;
  if (!isCanonicalObjectId(workspaceId)) {
    return next(validationError([{ field: "workspaceId", code: "FORMAT", message: "Workspace identifier is invalid." }]));
  }
  req.validated = { workspaceId: workspaceId.toLowerCase() };
  next();
}

/**
 * Validates a change to a workspace's details: `name`, `websiteUrl`, or both, by the same rules a
 * new workspace's are held to, and `confirmSiteChange`, the person's yes to a website on another
 * hostname (see `workspaceService.update`). At least one of the two details is required.
 */
export function validateWorkspaceUpdate(req, _res, next) {
  const fields = [];
  const { workspaceId } = req.params;
  if (!isCanonicalObjectId(workspaceId)) {
    fields.push({ field: "workspaceId", code: "FORMAT", message: "Workspace identifier is invalid." });
  }
  const body = plainObject(req.body);
  const keys = Object.keys(body);
  const allowed = new Set(["name", "websiteUrl", "confirmSiteChange"]);
  if (keys.some((key) => !allowed.has(key))) {
    fields.push({ field: "request", code: "UNKNOWN_FIELD", message: "Only name, websiteUrl and confirmSiteChange are allowed." });
  }
  if (body.name === undefined && body.websiteUrl === undefined) {
    fields.push({ field: "request", code: "REQUIRED", message: "Send a new name, a new website, or both." });
  }
  const changes = {};
  if (body.name !== undefined) {
    try { changes.name = canonicalizeWorkspaceName(body.name); } catch (error) {
      fields.push({ field: "name", code: "INVALID", message: error.message });
    }
  }
  if (body.websiteUrl !== undefined) {
    try { changes.websiteUrl = canonicalizePublicUrl(withAssumedScheme(body.websiteUrl)); } catch (error) {
      fields.push({ field: "websiteUrl", code: "INVALID", message: error.message });
    }
  }
  if (body.confirmSiteChange !== undefined && typeof body.confirmSiteChange !== "boolean") {
    fields.push({ field: "confirmSiteChange", code: "INVALID", message: "confirmSiteChange must be true or false." });
  }
  if (fields.length) return next(validationError(fields));
  req.validated = { workspaceId: workspaceId.toLowerCase(), changes, confirmSiteChange: body.confirmSiteChange === true };
  next();
}

/**
 * Validates a deletion: the route's workspace, and `confirmName`, the workspace's name typed out
 * again. Whether it matches is the service's to say, since only it has read the workspace; here it
 * only has to be text of a name's length.
 */
export function validateWorkspaceDelete(req, _res, next) {
  const fields = [];
  const { workspaceId } = req.params;
  if (!isCanonicalObjectId(workspaceId)) {
    fields.push({ field: "workspaceId", code: "FORMAT", message: "Workspace identifier is invalid." });
  }
  const body = plainObject(req.body);
  if (Object.keys(body).some((key) => key !== "confirmName")) {
    fields.push({ field: "request", code: "UNKNOWN_FIELD", message: "Only confirmName is allowed." });
  }
  if (typeof body.confirmName !== "string" || body.confirmName.length < 1 || body.confirmName.length > 400) {
    fields.push({ field: "confirmName", code: "REQUIRED", message: "Type the workspace's name to confirm." });
  }
  if (fields.length) return next(validationError(fields));
  req.validated = { workspaceId: workspaceId.toLowerCase(), confirmName: body.confirmName };
  next();
}

/**
 * Validates the read of an icon: `origin`, the website's (`site`) or the uploaded one (`upload`)
 * by name, or none for the one the workspace is shown with; and `v`, the version its address
 * carries so that a new picture is a new address, which is not otherwise read.
 */
export function validateIconQuery(req, _res, next) {
  const fields = [];
  for (const key of Object.keys(req.query ?? {})) {
    if (key !== "origin" && key !== "v") fields.push({ field: key, code: "UNKNOWN_FIELD", message: "Only origin and v are accepted." });
  }
  const origin = req.query?.origin;
  if (origin !== undefined && !Object.values(WORKSPACE_ICON_ORIGINS).includes(origin)) {
    fields.push({ field: "origin", code: "INVALID", message: "origin must be site or upload." });
  }
  if (req.query?.v !== undefined && !/^[0-9a-f]{1,64}$/.test(String(req.query.v))) {
    fields.push({ field: "v", code: "FORMAT", message: "v must be a version as the workspace list gives it." });
  }
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, origin: origin ?? null };
  next();
}

/** Validates an icon upload: the file as the body, and `name`, the name it came with. */
export function validateIconUpload(req, _res, next) {
  const fields = [];
  for (const key of Object.keys(req.query ?? {})) {
    if (key !== "name") fields.push({ field: key, code: "UNKNOWN_FIELD", message: "Only name is accepted." });
  }
  const name = typeof req.query?.name === "string" ? req.query.name.trim() : "";
  if (name.length > 200) fields.push({ field: "name", code: "RANGE", message: "That file name is too long." });
  if (!Buffer.isBuffer(req.body) || !req.body.length) fields.push({ field: "body", code: "REQUIRED", message: "Send the picture as the request body." });
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, bytes: req.body, fileName: name || null };
  next();
}

/** Validates the choice of what a workspace is shown with: `{"choice": "site"|"upload"|"none"}`. */
export function validateIconChoice(req, _res, next) {
  const body = plainObject(req.body);
  const fields = [];
  if (Object.keys(body).some((key) => key !== "choice")) {
    fields.push({ field: "request", code: "UNKNOWN_FIELD", message: "Only choice is allowed." });
  }
  if (!WORKSPACE_ICON_CHOICES.includes(body.choice)) {
    fields.push({ field: "choice", code: "INVALID", message: `choice must be one of: ${WORKSPACE_ICON_CHOICES.join(", ")}.` });
  }
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, choice: body.choice };
  next();
}
