import {
  SOURCE_KNOWLEDGE_USE,
  SOURCE_LIMITS,
  SOURCE_MODE,
  SOURCE_PURPOSE_IDS,
  SOURCE_RELATION,
  WEBSITE_SOURCE,
  normalizeSection,
} from "@orbik/core";

import { isCanonicalObjectId, plainObject, validationError } from "./shared.js";
import { canonicalizePublicUrl, withAssumedScheme } from "./workspaceValidators.js";

/** How often a source's pages may be read: daily, weekly, monthly, or only when asked (null). */
const PAGE_INTERVALS = Object.freeze([24, 168, 720]);

/** A folder under `/sources`: a short slug, the Library's segment rules. */
const FOLDER = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Validates `:sourceId`: a source's id, or `website` for the workspace's website. */
export function validateSourceScope(req, _res, next) {
  const { sourceId } = req.params;
  if (sourceId !== WEBSITE_SOURCE && !isCanonicalObjectId(sourceId)) {
    return next(validationError([{ field: "sourceId", code: "FORMAT", message: "Source identifier is invalid." }]));
  }
  req.validated = { ...req.validated, sourceId: sourceId === WEBSITE_SOURCE ? WEBSITE_SOURCE : sourceId.toLowerCase() };
  next();
}

/** Validates the body of "what is this address": `{ url }`. */
export function validateSourceCheck(req, _res, next) {
  const fields = [];
  const body = plainObject(req.body);
  rejectUnknown(body, ["url"], fields);
  const url = readUrl(body.url, "url", fields);
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, url };
  next();
}

/** Validates the body that adds a source. */
export function validateSourceCreate(req, _res, next) {
  const fields = [];
  const body = plainObject(req.body);
  rejectUnknown(body, ["url", "relation", "name", "purpose", "knowledgeUse", "pageIntervalHours", "followPagination"], fields);
  const url = readUrl(body.url, "url", fields);
  const relation = readChoice(body.relation, Object.values(SOURCE_RELATION), "relation", fields, { required: true });
  const source = {
    url,
    relation,
    name: readName(body.name, fields, { required: true }),
    purpose: readChoice(body.purpose, SOURCE_PURPOSE_IDS, "purpose", fields, { required: true }),
    knowledgeUse: readChoice(body.knowledgeUse, Object.values(SOURCE_KNOWLEDGE_USE), "knowledgeUse", fields) ?? SOURCE_KNOWLEDGE_USE.use,
    pageIntervalHours: readInterval(body.pageIntervalHours, fields) ?? 168,
    followPagination: readBoolean(body.followPagination, "followPagination", fields) ?? true,
  };
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, source };
  next();
}

/**
 * Validates a change to a source's settings. Only the fields sent change; the service decides
 * which a kind of source may have (a list of pages has no section, the website no other name).
 */
export function validateSourceUpdate(req, _res, next) {
  const fields = [];
  const body = plainObject(req.body);
  rejectUnknown(body, [
    "name", "purpose", "knowledgeUse", "pageIntervalHours", "mode", "section", "seedUrl",
    "pageUrls", "followPagination", "excludePatterns", "sitemapUrls",
  ], fields);
  const changes = {};
  if (body.name !== undefined) changes.name = readName(body.name, fields, { required: true });
  if (body.purpose !== undefined) changes.purpose = readChoice(body.purpose, SOURCE_PURPOSE_IDS, "purpose", fields, { required: true });
  if (body.knowledgeUse !== undefined) {
    changes.knowledgeUse = readChoice(body.knowledgeUse, Object.values(SOURCE_KNOWLEDGE_USE), "knowledgeUse", fields, { required: true });
  }
  if (body.pageIntervalHours !== undefined) changes.pageIntervalHours = readInterval(body.pageIntervalHours, fields);
  if (body.mode !== undefined) changes.mode = readChoice(body.mode, Object.values(SOURCE_MODE), "mode", fields, { required: true });
  if (body.section !== undefined) {
    changes.section = normalizeSection(body.section);
    if (!changes.section) fields.push({ field: "section", code: "INVALID", message: "Enter a path such as /guides/." });
  }
  if (body.seedUrl !== undefined) changes.seedUrl = readUrl(body.seedUrl, "seedUrl", fields);
  if (body.pageUrls !== undefined) changes.pageUrls = readUrls(body.pageUrls, "pageUrls", SOURCE_LIMITS.pages, fields, { min: 1 });
  if (body.followPagination !== undefined) changes.followPagination = readBoolean(body.followPagination, "followPagination", fields);
  if (body.excludePatterns !== undefined) changes.excludePatterns = readPatterns(body.excludePatterns, fields);
  if (body.sitemapUrls !== undefined) changes.sitemapUrls = readUrls(body.sitemapUrls, "sitemapUrls", 20, fields);
  if (!Object.keys(body).length) fields.push({ field: "request", code: "INVALID", message: "Send at least one setting to change." });
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, changes };
  next();
}

/** Validates dismissing a suggested source: `{ url }`, as it was suggested. */
export function validateSuggestionDismiss(req, _res, next) {
  const fields = [];
  const body = plainObject(req.body);
  rejectUnknown(body, ["url"], fields);
  const url = readUrl(body.url, "url", fields);
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, url };
  next();
}

function rejectUnknown(body, allowed, fields) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
  }
}

/** An address as a person typed it: a bare host (`docs.example.com`) means https://. */
function readUrl(value, field, fields) {
  try {
    return canonicalizePublicUrl(withAssumedScheme(value));
  } catch (error) {
    fields.push({ field, code: "INVALID", message: error.message.replace(/^Website URL/, "The address") });
    return null;
  }
}

function readUrls(value, field, max, fields, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fields.push({ field, code: "RANGE", message: min ? `List from ${min} to ${max} addresses.` : `List at most ${max} addresses.` });
    return [];
  }
  const canonical = [];
  for (const entry of value) {
    const url = readUrl(entry, field, fields);
    if (url) canonical.push(url);
  }
  return [...new Set(canonical)];
}

function readName(value, fields, { required = false } = {}) {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!name) {
    if (required) fields.push({ field: "name", code: "REQUIRED", message: "Give the source a name." });
    return null;
  }
  if (name.length > SOURCE_LIMITS.nameLength) {
    fields.push({ field: "name", code: "RANGE", message: `Keep the name to ${SOURCE_LIMITS.nameLength} characters.` });
    return null;
  }
  return name;
}

function readChoice(value, choices, field, fields, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fields.push({ field, code: "REQUIRED", message: `Choose one of: ${choices.join(", ")}.` });
    return null;
  }
  if (!choices.includes(value)) {
    fields.push({ field, code: "INVALID", message: `Choose one of: ${choices.join(", ")}.` });
    return null;
  }
  return value;
}

function readInterval(value, fields) {
  if (value === undefined) return undefined;
  if (value === null || PAGE_INTERVALS.includes(value)) return value;
  fields.push({ field: "pageIntervalHours", code: "INVALID", message: "Choose daily (24), weekly (168), monthly (720) or only when asked (null)." });
  return undefined;
}

function readBoolean(value, field, fields) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    fields.push({ field, code: "INVALID", message: "Send true or false." });
    return undefined;
  }
  return value;
}

/**
 * "Leave out" rules: one address prefix per line, `*` for anything. A rule is a path (`/v1/*`);
 * one without a `*` leaves out everything that starts with it.
 */
function readPatterns(value, fields) {
  if (!Array.isArray(value) || value.length > SOURCE_LIMITS.excludePatterns) {
    fields.push({ field: "excludePatterns", code: "RANGE", message: `List at most ${SOURCE_LIMITS.excludePatterns} rules.` });
    return [];
  }
  const rules = [];
  for (const entry of value) {
    const rule = typeof entry === "string" ? entry.trim() : "";
    if (!rule) continue;
    if (!rule.startsWith("/") || rule.length > 500 || /\s/.test(rule)) {
      fields.push({ field: "excludePatterns", code: "INVALID", message: `${rule || "A rule"} is not a path such as /v1/*.` });
      continue;
    }
    rules.push(rule.includes("*") ? rule : `${rule}*`);
  }
  return [...new Set(rules)];
}

export { FOLDER as SOURCE_FOLDER_PATTERN };
