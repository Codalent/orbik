import { BRAND_UPLOAD_LIMITS } from "@orbik/core";

import { MAX_QUESTION } from "../services/conversationService.js";
import { isCanonicalObjectId, plainObject, validationError } from "./shared.js";

/**
 * Validating what a person sends to the chat.
 *
 * There is very little of it, and that is the point: a caller supplies a question and, optionally,
 * where in the app it was asked from. Which workspace it is answered from — and who any change it
 * makes is recorded as — comes from the route and the session, the agent
 * and its version come from the catalog. A body
 * that carried an agent slug or a model name would be a body that let a caller redirect the
 * question somewhere it should not go, so those fields are not merely ignored — an unknown field
 * is a rejection, the same rule the tool arguments follow, for the same reason.
 */

/** Listing bound, kept small enough that one response stays renderable. */
const LIST_LIMIT = Object.freeze({ min: 1, max: 100, fallback: 50 });

/** Validates the conversation identifier in a route. */
export function validateConversationScope(req, _res, next) {
  const { conversationId } = req.params;
  if (!isCanonicalObjectId(conversationId)) {
    return next(validationError([{ field: "conversationId", code: "FORMAT", message: "Conversation identifier is invalid." }]));
  }
  req.validated = { ...req.validated, conversationId: String(conversationId).toLowerCase() };
  next();
}

/** Bounds on where in the app a question was asked from. */
const CONTEXT_LIMITS = Object.freeze({ page: 80, route: 300, libraryPath: 512, section: 20 });

/** Where on the Brand page files may be dropped. */
const SECTIONS = Object.freeze(["logos", "colours", "type", "images", "chat"]);

/** A Library path, in the grammar the store accepts. */
const LIBRARY_PATH = /^(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

/**
 * Validates where in the app the question was asked from: the page's name, its address, and the
 * Library file on screen, if any. It is what lets "save this here" or "move this file" mean
 * something, and it is only ever a hint: the agent is told it is where the person is, and every
 * path in it still goes through the Library's own rules.
 */
function contextOf(value, fields) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    fields.push({ field: "context", code: "FORMAT", message: "context must be an object." });
    return null;
  }
  const context = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!Object.hasOwn(CONTEXT_LIMITS, key)) {
      fields.push({ field: `context.${key}`, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
      continue;
    }
    if (entry === null || entry === undefined || entry === "") continue;
    if (typeof entry !== "string" || entry.length > CONTEXT_LIMITS[key]) {
      fields.push({ field: `context.${key}`, code: "FORMAT", message: `context.${key} must be a short string.` });
      continue;
    }
    if (key === "libraryPath" && !LIBRARY_PATH.test(entry)) {
      fields.push({ field: "context.libraryPath", code: "FORMAT", message: "That Library path is invalid." });
      continue;
    }
    if (key === "section" && !SECTIONS.includes(entry)) {
      fields.push({ field: "context.section", code: "FORMAT", message: `context.section must be one of ${SECTIONS.join(", ")}.` });
      continue;
    }
    if (key === "route" && !entry.startsWith("/")) {
      fields.push({ field: "context.route", code: "FORMAT", message: "context.route must be a path in the app." });
      continue;
    }
    context[key] = entry;
  }
  return Object.keys(context).length ? context : null;
}

/** Validates the question a person asked, and where they asked it from. */
export function validateQuestionBody(req, _res, next) {
  const fields = [];
  const body = plainObject(req.body);
  for (const key of Object.keys(body)) {
    if (key !== "question" && key !== "context" && key !== "attachments") {
      fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
    }
  }
  const context = contextOf(body.context, fields);
  const attachments = attachmentsOf(body.attachments, fields);

  // Files sent with nothing typed are a message too: "here are these".
  const question = typeof body.question === "string" && body.question.trim()
    ? body.question.trim()
    : attachments.length ? (attachments.length === 1 ? "Add this to the brand." : "Add these to the brand.") : "";
  if (!question) {
    fields.push({ field: "question", code: "REQUIRED", message: "Ask a question." });
  } else if (question.length > MAX_QUESTION) {
    fields.push({
      field: "question",
      code: "RANGE",
      message: `A question may be at most ${MAX_QUESTION.toLocaleString("en-US")} characters.`,
    });
  }

  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, question, context, attachments };
  next();
}

/**
 * Validates the files sent with a message: identifiers of uploads already stored, at most a
 * handful. Whether each is this workspace's is the service's to check.
 */
function attachmentsOf(value, fields) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((id) => !isCanonicalObjectId(id))) {
    fields.push({ field: "attachments", code: "FORMAT", message: "attachments must be a list of uploaded files' identifiers." });
    return [];
  }
  if (value.length > BRAND_UPLOAD_LIMITS.perMessage) {
    fields.push({ field: "attachments", code: "RANGE", message: `Send at most ${BRAND_UPLOAD_LIMITS.perMessage} files with one message.` });
    return [];
  }
  return [...new Set(value.map((id) => String(id).toLowerCase()))];
}

/** Validates the optional `limit` of a conversation listing. */
export function validateConversationListQuery(req, _res, next) {
  const fields = [];
  const query = req.query ?? {};
  for (const key of Object.keys(query)) {
    if (key !== "limit") fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This filter is not accepted." });
  }
  let limit = LIST_LIMIT.fallback;
  if (query.limit !== undefined) {
    const parsed = Number(query.limit);
    if (!Number.isInteger(parsed) || parsed < LIST_LIMIT.min || parsed > LIST_LIMIT.max) {
      fields.push({
        field: "limit",
        code: "RANGE",
        message: `limit must be a whole number from ${LIST_LIMIT.min} to ${LIST_LIMIT.max}.`,
      });
    } else {
      limit = parsed;
    }
  }
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, limit };
  next();
}
