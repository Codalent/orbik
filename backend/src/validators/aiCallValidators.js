import { ObjectId } from "mongodb";

import { validationError } from "./shared.js";

/** How far back each period reaches, keyed by the value the query carries. */
export const AI_CALL_PERIODS = Object.freeze({
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
});

/** What a call was for, as a person filters by it. `chat` and `agent-run` split one purpose. */
const AI_CALL_SOURCES = Object.freeze(["agent-run", "chat", "embedding", "crawl-schedule"]);

const STATUSES = Object.freeze(["running", "succeeded", "failed"]);
const FILTERS = Object.freeze(["period", "source", "model", "status", "workspaceId", "q"]);
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;
const MAX_SEARCH_CHARACTERS = 200;

/**
 * Validates the list query: the filters, an optional page size, and an optional `before` cursor.
 *
 * The cursor is an instant rather than an opaque token because the list is ordered by start time
 * and a person may reasonably want to type "before yesterday". Unknown filters are rejected, as
 * everywhere else: a misspelled filter that is silently ignored returns the wrong rows.
 */
export function validateAiCallListQuery(req, _res, next) {
  const query = req.query ?? {};
  const fields = [];
  for (const key of Object.keys(query)) {
    if (!["limit", "before", ...FILTERS].includes(key)) fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This filter is not accepted." });
  }

  let limit = 50;
  if (query.limit !== undefined && query.limit !== "") {
    const value = Number(query.limit);
    if (!Number.isInteger(value) || value < 1 || value > 200) {
      fields.push({ field: "limit", code: "RANGE", message: "Enter a whole number from 1 to 200." });
    } else {
      limit = value;
    }
  }

  let before;
  if (query.before !== undefined && query.before !== "") {
    const value = new Date(String(query.before));
    if (Number.isNaN(value.getTime())) {
      fields.push({ field: "before", code: "FORMAT", message: "Enter an ISO 8601 date-time." });
    } else {
      before = value;
    }
  }

  const filters = readFilters(query, fields);
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, limit, before, filters };
  next();
}

/** Validates the summary query: the same filters as the list, and nothing that pages. */
export function validateAiCallSummaryQuery(req, _res, next) {
  const query = req.query ?? {};
  const fields = [];
  for (const key of Object.keys(query)) {
    if (!FILTERS.includes(key)) fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This filter is not accepted." });
  }
  const filters = readFilters(query, fields);
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, filters };
  next();
}

/** Rejects a call identifier that is not an ObjectId before it reaches the database. */
export function validateAiCallScope(req, _res, next) {
  if (!ObjectId.isValid(req.params.callId)) {
    return next(validationError([{ field: "callId", code: "FORMAT", message: "Call identifier is invalid." }]));
  }
  next();
}

/**
 * Reads the filters the list and the summary share, recording each one that is malformed.
 *
 * An empty value means "not filtered", so a form that submits every field — blank ones included —
 * asks for what it shows.
 */
function readFilters(query, fields) {
  const filters = {};
  const text = (key) => (typeof query[key] === "string" ? query[key].trim() : query[key] === undefined ? "" : null);

  const period = text("period");
  if (period === null || (period && !Object.hasOwn(AI_CALL_PERIODS, period))) {
    fields.push({ field: "period", code: "ENUM", message: `Choose one of ${Object.keys(AI_CALL_PERIODS).join(", ")}.` });
  } else if (period) {
    filters.period = period;
  }

  const source = text("source");
  if (source === null || (source && !AI_CALL_SOURCES.includes(source))) {
    fields.push({ field: "source", code: "ENUM", message: `Choose one of ${AI_CALL_SOURCES.join(", ")}.` });
  } else if (source) {
    filters.source = source;
  }

  const model = text("model");
  if (model === null || (model && !MODEL_PATTERN.test(model))) {
    fields.push({ field: "model", code: "FORMAT", message: "Enter a model identifier." });
  } else if (model) {
    filters.model = model;
  }

  const status = text("status");
  if (status === null || (status && !STATUSES.includes(status))) {
    fields.push({ field: "status", code: "ENUM", message: `Choose one of ${STATUSES.join(", ")}.` });
  } else if (status) {
    filters.status = status;
  }

  const workspaceId = text("workspaceId");
  if (workspaceId === null || (workspaceId && !/^[0-9a-f]{24}$/i.test(workspaceId))) {
    fields.push({ field: "workspaceId", code: "FORMAT", message: "Workspace identifier is invalid." });
  } else if (workspaceId) {
    filters.workspaceId = new ObjectId(workspaceId);
  }

  const q = text("q");
  if (q === null || (q && q.length > MAX_SEARCH_CHARACTERS)) {
    fields.push({ field: "q", code: "LENGTH", message: `Search for at most ${MAX_SEARCH_CHARACTERS} characters.` });
  } else if (q) {
    filters.q = q;
  }

  return filters;
}
