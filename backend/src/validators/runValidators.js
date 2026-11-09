import { RUN_STATUS_VALUES } from "@orbik/protocol";

import { isCanonicalObjectId, parseBounded, plainObject, validationError } from "./shared.js";

/** Largest agent input accepted, well under the 32 KiB body limit the API already enforces. */
const MAX_INPUT_BYTES = 16 * 1024;

/** Listing bounds, kept small enough that one response stays renderable. */
const RUN_LIMIT = Object.freeze({ min: 1, max: 100, fallback: 20 });
const EVENT_LIMIT = Object.freeze({ min: 1, max: 500, fallback: 200 });

/** Matches an agent slug, the same shape the protocol enforces on a definition. */
const SLUG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Validates one canonical MongoDB run route identifier. */
export function validateRunScope(req, _res, next) {
  const { runId } = req.params;
  if (!isCanonicalObjectId(runId)) {
    return next(validationError([{ field: "runId", code: "FORMAT", message: "Run identifier is invalid." }]));
  }
  req.validated = { ...req.validated, runId: String(runId).toLowerCase() };
  next();
}

/**
 * Validates a request to start an agent run.
 *
 * Nothing resembling a model, a provider, or an API key is an accepted field. A body carrying
 * `apiKey` is rejected by the unknown-field check, which is deliberate — silently ignoring it
 * would let a user believe Orbik was using a key it never received.
 */
export function validateCreateRun(req, _res, next) {
  const fields = [];
  const body = plainObject(req.body);
  const allowed = new Set(["agentSlug", "input"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
    }
  }

  if (typeof body.agentSlug !== "string" || !SLUG_PATTERN.test(body.agentSlug) || body.agentSlug.length > 64) {
    fields.push({ field: "agentSlug", code: "INVALID", message: "Choose an agent to run." });
  }

  // The agent's own input is checked for shape and size here and against the definition's schema
  // in the service, once the definition is known. This half is what keeps an unbounded blob from
  // reaching a database write at all.
  let input = {};
  if (body.input !== undefined) {
    if (body.input === null || typeof body.input !== "object" || Array.isArray(body.input)) {
      fields.push({ field: "input", code: "INVALID", message: "Input must be an object." });
    } else if (Buffer.byteLength(safeStringify(body.input, fields)) > MAX_INPUT_BYTES) {
      fields.push({ field: "input", code: "RANGE", message: "Input is too large." });
    } else {
      input = body.input;
    }
  }

  if (fields.length) return next(validationError(fields));
  req.validated = {
    ...req.validated,
    agentSlug: body.agentSlug,
    input,
  };
  next();
}

/**
 * Requires the `Idempotency-Key` header that makes starting a run safe to retry.
 *
 * Required rather than optional because the consequence of a duplicate is running the same work
 * twice. Workspace creation already uses the same header for the same reason.
 */
export function validateRunIdempotencyKey(req, _res, next) {
  const key = req.get("Idempotency-Key");
  if (typeof key !== "string" || key.length < 8 || key.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    return next(
      validationError([
        {
          field: "Idempotency-Key",
          code: "INVALID",
          message: "Idempotency-Key must be 8-200 characters of letters, digits, dot, colon, dash, or underscore.",
        },
      ]),
    );
  }
  req.validated = { ...req.validated, requestKey: key };
  next();
}

/** Validates the optional filters and size of a run listing. */
export function validateRunListQuery(req, _res, next) {
  const fields = [];
  const query = req.query ?? {};
  const allowed = new Set(["agent", "status", "limit"]);
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) {
      fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This filter is not accepted." });
    }
  }

  let agentSlug;
  if (query.agent !== undefined) {
    if (typeof query.agent !== "string" || !SLUG_PATTERN.test(query.agent) || query.agent.length > 64) {
      fields.push({ field: "agent", code: "FORMAT", message: "Agent identifier is invalid." });
    } else {
      agentSlug = query.agent;
    }
  }

  let status;
  if (query.status !== undefined) {
    if (!RUN_STATUS_VALUES.includes(query.status)) {
      fields.push({ field: "status", code: "INVALID", message: `Choose one of: ${RUN_STATUS_VALUES.join(", ")}.` });
    } else {
      status = query.status;
    }
  }

  const limit = parseBounded(query.limit, RUN_LIMIT, "limit", fields);
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, agentSlug, status, limit };
  next();
}

/** Validates the cursor and size of an event listing. */
export function validateEventQuery(req, _res, next) {
  const fields = [];
  const query = req.query ?? {};
  for (const key of Object.keys(query)) {
    if (key !== "after" && key !== "limit") {
      fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This filter is not accepted." });
    }
  }

  const after = parseBounded(query.after, { min: 0, max: 1_000_000, fallback: 0 }, "after", fields);
  const limit = parseBounded(query.limit, EVENT_LIMIT, "limit", fields);
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, after, limit };
  next();
}

/** Measures a value's serialized size, reporting one that could not be stored at all. */
function safeStringify(value, fields) {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    fields.push({ field: "input", code: "INVALID", message: "Input must be JSON-serializable." });
    return "";
  }
}
