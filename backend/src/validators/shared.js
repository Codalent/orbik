import { ObjectId } from "mongodb";

import { AppError } from "../errors/appError.js";

/** Builds one consistent validation failure from already-safe field descriptions. */
export function validationError(fields) {
  return new AppError({ status: 400, code: "VALIDATION_FAILED", message: "Request validation failed.", fields });
}

/** Whether a value is a MongoDB identifier in its canonical 24-character hex form, in either case. */
export function isCanonicalObjectId(value) {
  return ObjectId.isValid(value) && new ObjectId(value).toHexString() === String(value).toLowerCase();
}

/** Returns the value when it is a plain object, and an empty one otherwise. */
export function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Parses one optional bounded integer from a query string.
 *
 * A present but unparseable value is rejected rather than replaced by the default, so a mistyped
 * filter fails visibly instead of silently returning a different result set than the caller asked
 * for. A blank value counts as absent unless `blankIsZero` is set, in which case it is read as 0,
 * the way `Number` reads it, and checked against the bounds like any other value.
 *
 * @param {unknown} raw the query value
 * @param {{ min: number, max: number, fallback: number }} bound
 * @param {string} field the name a failure is reported under
 * @param {object[]} fields the failures collected so far, appended to on a bad value
 * @param {{ blankIsZero?: boolean }} [options]
 */
export function parseBounded(raw, bound, field, fields, { blankIsZero = false } = {}) {
  if (raw === undefined || (raw === "" && !blankIsZero)) return bound.fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < bound.min || value > bound.max) {
    fields.push({ field, code: "RANGE", message: `Enter a whole number from ${bound.min} to ${bound.max}.` });
    return bound.fallback;
  }
  return value;
}

/**
 * Parses one optional choice from a query string, such as `format=csv`.
 *
 * Like {@link parseBounded}, a value that is present and not one of the choices is rejected rather
 * than replaced by the default: a mistyped `format` should fail, not quietly answer in another
 * format than the caller asked for.
 *
 * @param {unknown} raw the query value
 * @param {{ allowed: readonly string[], fallback: string }} choice
 * @param {string} field the name a failure is reported under
 * @param {object[]} fields the failures collected so far, appended to on a bad value
 */
export function parseChoice(raw, choice, field, fields) {
  if (raw === undefined || raw === "") return choice.fallback;
  if (typeof raw !== "string" || !choice.allowed.includes(raw)) {
    fields.push({ field, code: "INVALID", message: `Ask for ${choice.allowed.join(" or ")}.` });
    return choice.fallback;
  }
  return raw;
}

/** Validates one canonical MongoDB workspace route identifier. */
export function validateWorkspaceScope(req, _res, next) {
  const { workspaceId } = req.params;
  if (!isCanonicalObjectId(workspaceId)) {
    return next(validationError([{ field: "workspaceId", code: "FORMAT", message: "Workspace identifier is invalid." }]));
  }
  req.validated = { ...req.validated, workspaceId: workspaceId.toLowerCase() };
  next();
}
