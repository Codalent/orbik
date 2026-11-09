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
  try { websiteUrl = canonicalizePublicUrl(req.body?.websiteUrl); } catch (error) {
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
    try { changes.websiteUrl = canonicalizePublicUrl(body.websiteUrl); } catch (error) {
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
