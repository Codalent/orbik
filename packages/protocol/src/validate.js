/**
 * Validation primitives shared by every parser in this package.
 *
 * Each primitive appends its failures to a caller-owned `errors` list rather than throwing, so a
 * parser can report everything wrong with an input at once. This mirrors the environment parsing
 * in `@orbik/core`, and exists for the same reason: fixing a malformed agent definition one
 * rejected field per attempt is a miserable way to learn what the shape is.
 *
 * Every primitive returns the canonical value it validated. When validation failed, the returned
 * value is meaningless and callers must not use it — which is safe, because a parser always ends
 * by calling {@link assertValid}, and that throws when anything was rejected.
 */

/**
 * Failure raised when input does not match a protocol shape.
 *
 * `errors` carries one message per rejected field. The messages are written to be safe to show a
 * user and safe to log: they name fields and expected shapes, never the rejected value, because
 * the rejected value may be exactly the credential that should not have been sent.
 */
export class ProtocolError extends Error {
  /**
   * @param {object} options failure detail
   * @param {string} options.code stable machine-readable code, e.g. `INVALID_AGENT_DEFINITION`
   * @param {string[]} options.errors one safe message per rejected field, at least one
   */
  constructor({ code, errors }) {
    super(`${code}: ${errors.join(" ")}`);
    this.name = "ProtocolError";
    this.code = code;
    this.errors = Object.freeze([...errors]);
  }
}

/**
 * Matches a tool name: a lowercase namespace and a camelCase member, as in `crawl.listPages`.
 *
 * Tool names are not agent names and deliberately do not share their pattern. A tool name is read
 * by a language model as part of its instructions, where `listPages` is the form every SDK and
 * every example uses, and an unfamiliar shape is one more thing for the model to get wrong. The
 * namespace stays lowercase because it maps to a module.
 */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9]*\.[a-z][A-Za-z0-9]*$/;

/**
 * Throws one aggregated failure when any field was rejected, and does nothing otherwise.
 *
 * @param {string} code stable code for the aggregated failure
 * @param {string[]} errors collected safe messages
 * @throws {ProtocolError} when `errors` is non-empty
 */
export function assertValid(code, errors) {
  if (errors.length) throw new ProtocolError({ code, errors });
}

/**
 * Applies a default only when a field was *omitted*.
 *
 * `??` would also swallow an explicit `null`, turning a caller's mistake into a silently valid
 * document. Distinguishing "absent" from "present but null" is what lets a parser reject the
 * second case instead of guessing what the caller meant.
 *
 * @param {unknown} value supplied value
 * @param {unknown} fallback value to use when `value` is `undefined`
 */
export function defaulted(value, fallback) {
  return value === undefined ? fallback : value;
}

/**
 * Validates a string, optionally against a length range and a pattern.
 *
 * @param {unknown} value supplied value
 * @param {string} field field name used in failure messages
 * @param {{min?: number, max?: number, pattern?: RegExp, patternDescription?: string}} rules
 * @param {string[]} errors caller-owned list that receives safe failure messages
 * @returns {string} the validated value
 */
export function requireString(value, field, rules, errors) {
  const { min = 1, max, pattern, patternDescription } = rules;
  if (typeof value !== "string") {
    errors.push(`${field} must be a string.`);
    return value;
  }
  if (value.length < min || (max !== undefined && value.length > max)) {
    errors.push(
      max === undefined
        ? `${field} must be at least ${min} characters.`
        : `${field} must be ${min}-${max} characters.`,
    );
    return value;
  }
  if (pattern && !pattern.test(value)) {
    errors.push(`${field} must be ${patternDescription ?? `of the form ${pattern.source}`}.`);
  }
  return value;
}

/**
 * Validates that a value is one of an enumerated set.
 *
 * The allowed values are listed in the failure message because they are a closed, non-sensitive
 * set: a caller who sent the wrong one can fix it without reading the source.
 *
 * @param {unknown} value supplied value
 * @param {string} field field name used in failure messages
 * @param {readonly string[]} allowed permitted values
 * @param {string[]} errors caller-owned list that receives safe failure messages
 * @returns {unknown} the validated value
 */
export function requireEnum(value, field, allowed, errors) {
  if (!allowed.includes(value)) {
    errors.push(`${field} must be one of ${allowed.join(", ")}.`);
  }
  return value;
}

/**
 * Validates an integer within an inclusive range.
 *
 * @param {unknown} value supplied value
 * @param {string} field field name used in failure messages
 * @param {{min?: number, max?: number}} rules inclusive bounds
 * @param {string[]} errors caller-owned list that receives safe failure messages
 * @returns {number} the validated value
 */
export function requireInteger(value, field, rules, errors) {
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = rules;
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${field} must be an integer from ${min} through ${max}.`);
  }
  return value;
}

/**
 * Validates a plain object: not null, not an array, not a class instance with surprises.
 *
 * @param {unknown} value supplied value
 * @param {string} field field name used in failure messages
 * @param {string[]} errors caller-owned list that receives safe failure messages
 * @returns {object} the validated value
 */
export function requirePlainObject(value, field, errors) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${field} must be an object.`);
  }
  return value;
}

/**
 * Validates an array of strings, each matching the same rules.
 *
 * @param {unknown} value supplied value
 * @param {string} field field name used in failure messages
 * @param {{max?: number, itemRules?: object, itemDescription?: string}} rules
 * @param {string[]} errors caller-owned list that receives safe failure messages
 * @returns {string[]} the validated value
 */
export function requireStringArray(value, field, rules, errors) {
  const { max = 100, itemRules = { max: 200 } } = rules;
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array.`);
    return value;
  }
  if (value.length > max) {
    errors.push(`${field} must contain at most ${max} entries.`);
    return value;
  }
  const itemErrors = [];
  value.forEach((item, index) => requireString(item, `${field}[${index}]`, itemRules, itemErrors));
  errors.push(...itemErrors);
  return value;
}

/**
 * Rejects any field the shape does not declare.
 *
 * Unknown fields are refused rather than ignored throughout this codebase — see the HTTP
 * validators, which do the same. Silently dropping a field a caller believed was meaningful is
 * how a typo becomes a support ticket.
 *
 * The offending names are echoed only when they look like ordinary identifiers. A key is
 * attacker-controlled input like any other value, and a failure message is a string that ends up
 * in logs — so a key that does not match the safe pattern is counted rather than quoted.
 *
 * @param {object} value already confirmed to be a plain object
 * @param {readonly string[]} allowed field names the shape declares
 * @param {string} field name of the containing object, used in failure messages
 * @param {string[]} errors caller-owned list that receives safe failure messages
 */
export function rejectUnknownKeys(value, allowed, field, errors) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (!unknown.length) return;

  const named = unknown.filter((key) => SAFE_KEY_PATTERN.test(key)).sort().slice(0, MAX_REPORTED_KEYS);
  const omitted = unknown.length - named.length;

  errors.push(
    `${field} has ${unknown.length} unsupported field(s)` +
      (named.length ? `: ${named.join(", ")}` : "") +
      (omitted ? `${named.length ? ", and" : ","} ${omitted} not shown` : "") +
      ".",
  );
}

/** Field names safe to quote back in a failure message. */
const SAFE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** How many offending field names one message will list before summarizing the rest. */
const MAX_REPORTED_KEYS = 10;
