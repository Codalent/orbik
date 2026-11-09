import { plainObject, validationError } from "./shared.js";

/** The steps a person can skip, as the API names them. Mirrors `SKIPPABLE_STEPS` in the service. */
const STEP_PATTERN = /^[a-z][a-z-]{1,30}$/;

/**
 * Validates one change to a person's Home page: `skip` and `unskip`, lists of step identifiers,
 * and `hidden`, true or false. At least one of them; nothing else.
 *
 * Whether a named step can be skipped at all is the service's to say, from its own list, so the
 * two cannot disagree; here a step only has to look like an identifier.
 */
export function validateHomePreferences(req, _res, next) {
  const fields = [];
  const body = plainObject(req.body);
  for (const key of Object.keys(body)) {
    if (!["skip", "unskip", "hidden"].includes(key)) {
      fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
    }
  }
  const steps = (field) => {
    const value = body[field];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 10 || !value.every((step) => typeof step === "string" && STEP_PATTERN.test(step))) {
      fields.push({ field, code: "INVALID", message: "Name the steps as a list of step identifiers." });
      return [];
    }
    return [...new Set(value)];
  };
  const skip = steps("skip");
  const unskip = steps("unskip");
  if (body.hidden !== undefined && typeof body.hidden !== "boolean") {
    fields.push({ field: "hidden", code: "INVALID", message: "Say true or false." });
  }
  if (!fields.length && !skip.length && !unskip.length && body.hidden === undefined) {
    fields.push({ field: "body", code: "EMPTY", message: "Say what to change: skip, unskip or hidden." });
  }
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, skip, unskip, hidden: body.hidden };
  next();
}
