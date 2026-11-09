/**
 * Validators for the arguments a language model produced.
 *
 * A tool call is a generated string that happened to parse as JSON. It is exactly as untrusted as
 * a request body, and these functions treat it that way: every value is checked against what the
 * tool declared, and anything the tool did not declare is a rejection rather than a silently
 * ignored key — a hallucinated `workspaceId` that vanished quietly would let a model believe it
 * had asked a question it had not.
 *
 * They collect problems into an array instead of throwing, so one malformed call comes back to the
 * model as a complete list of what was wrong with it and can be fixed in a single retry.
 */

/** Largest page of results any tool will return, so one call cannot fill a model's context. */
export const MAX_LIMIT = 200;

/** Default page size, chosen to be useful in one call without being wasteful. */
export const DEFAULT_LIMIT = 50;

/** Longest URL any tool accepts, matching what the crawler is willing to store. */
export const MAX_URL = 2048;

/** Validates an optional bounded integer. */
export function boundedInteger(value, field, { min, max, fallback }, errors) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${field} must be an integer from ${min} through ${max}.`);
    return fallback;
  }
  return value;
}

/** Validates an optional boolean. */
export function optionalBoolean(value, field, errors) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    errors.push(`${field} must be true or false.`);
    return undefined;
  }
  return value;
}

/** Validates a required boolean. */
export function requiredBoolean(value, field, errors) {
  if (typeof value !== "boolean") {
    errors.push(`${field} must be true or false.`);
    return false;
  }
  return value;
}

/**
 * Validates a string, trimming it and enforcing a length.
 *
 * @param {unknown} value the model's argument
 * @param {string} field name to use in a message
 * @param {{max: number, required?: boolean, pattern?: RegExp, patternDescription?: string}} rules
 * @param {string[]} errors collected problems
 */
export function requireString(value, field, { max, required = true, pattern, patternDescription }, errors) {
  if (value === undefined || value === null || value === "") {
    if (required) errors.push(`${field} is required.`);
    return required ? "" : null;
  }
  if (typeof value !== "string") {
    errors.push(`${field} must be a string.`);
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed && required) {
    errors.push(`${field} is required.`);
    return "";
  }
  if (trimmed.length > max) {
    errors.push(`${field} must be at most ${max} characters.`);
    return trimmed.slice(0, max);
  }
  if (pattern && trimmed && !pattern.test(trimmed)) {
    errors.push(`${field} must be ${patternDescription ?? "in the expected form"}.`);
  }
  return trimmed;
}

/**
 * Validates a list of strings, de-duplicating it.
 *
 * De-duplication is silent on purpose: a model listing the same page twice is not making a
 * mistake worth a failed call, and every caller here treats the list as a set.
 */
export function requireStringArray(value, field, { max, itemMax, required = true }, errors) {
  if (value === undefined || value === null) {
    if (required) errors.push(`${field} is required.`);
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array.`);
    return [];
  }
  if (required && !value.length) {
    errors.push(`${field} must name at least one item.`);
    return [];
  }
  if (value.length > max) {
    errors.push(`${field} must have at most ${max} items.`);
    return [];
  }
  const items = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      errors.push(`${field} must contain only non-empty strings.`);
      return [];
    }
    if (entry.length > itemMax) {
      errors.push(`${field} entries must be at most ${itemMax} characters.`);
      return [];
    }
    items.push(entry.trim());
  }
  return [...new Set(items)];
}

/** Rejects arguments the tool does not declare, so a hallucinated filter fails loudly. */
export function rejectUnknown(input, allowed, errors) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    errors.push("input must be an object.");
    return {};
  }
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) errors.push(`${key} is not an accepted argument.`);
  }
  return input;
}
