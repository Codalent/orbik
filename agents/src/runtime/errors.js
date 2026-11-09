import { ObjectId } from "mongodb";

/**
 * Failure raised by agent code, carrying the one decision the runtime cannot make for itself:
 * whether retrying the same job could plausibly succeed.
 *
 * The distinction matters because retries are not free. A timeout or a 503 from a crawled host
 * is worth another attempt after a delay; a malformed URL or an unparseable configuration will
 * fail identically forever, and retrying it five times only delays the operator's feedback and
 * wastes the host's bandwidth.
 */
export class AgentError extends Error {
  /**
   * @param {object} options failure detail
   * @param {string} options.code stable machine-readable code, e.g. `FETCH_TIMEOUT`
   * @param {string} [options.message] safe human-readable description; never include credentials
   * @param {boolean} [options.retryable=false] whether another attempt could succeed
   * @param {number} [options.retryAfterMs] explicit delay before the next attempt, honoured over
   *   the runtime's exponential backoff — used when a host sends `Retry-After`
   * @param {boolean} [options.consumesAttempt=true] false when the job was put off before it did
   *   what it exists to do — its host is inside a hold, so nothing was asked of it. Such a job
   *   goes back to the queue with its attempts as they were: being told to wait is not a failed
   *   try, and a queue of thousands of pages behind one hold must not run out of attempts by
   *   waiting. Only meaningful on a retryable failure
   * @param {unknown} [options.cause] underlying error, kept for logs only
   */
  constructor({ code, message, retryable = false, retryAfterMs, consumesAttempt = true, cause }) {
    super(message ?? code);
    this.name = "AgentError";
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.consumesAttempt = consumesAttempt;
    this.cause = cause;
  }
}

/**
 * Classifies any thrown value into the shape the queue records and acts on.
 *
 * Unknown failures — a `TypeError` from a parser, an assertion — are deliberately treated as
 * **not** retryable: they are bugs, and retrying a bug produces the same crash while hiding it
 * behind attempt counters. Only failures an agent has explicitly marked retryable are retried.
 *
 * @param {unknown} error thrown value
 * @returns {{code: string, message: string, retryable: boolean, retryAfterMs: number | undefined,
 *   consumesAttempt: boolean}}
 */
export function classifyFailure(error) {
  // Over the account's plan (`@orbik/extensions`): refused the same way until the plan changes,
  // and said in words a person can act on, so it is kept as it is rather than hidden as a bug.
  if (error?.name === "PlanLimitError") {
    return { code: error.code, message: error.message, retryable: false, retryAfterMs: undefined, consumesAttempt: true };
  }
  if (error instanceof AgentError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
      consumesAttempt: error.consumesAttempt !== false,
    };
  }
  return {
    code: "UNEXPECTED_ERROR",
    message: error instanceof Error ? error.message : "Unknown agent failure.",
    retryable: false,
    retryAfterMs: undefined,
    consumesAttempt: true,
  };
}

/**
 * Reads a required identifier from a job payload, failing permanently when it is not one.
 *
 * Not retryable: a payload with a malformed identifier will be malformed on every attempt.
 *
 * @param {unknown} value the payload's value
 * @param {string} field the identifier's name, e.g. `siteId`
 * @param {string} [what] the job, e.g. `An index job`, when the message should name it
 * @returns {ObjectId}
 * @throws {AgentError} `INVALID_JOB`
 */
export function requireObjectId(value, field, what) {
  if (value instanceof ObjectId) return value;
  if (typeof value === "string" && ObjectId.isValid(value)) return new ObjectId(value);
  throw new AgentError({
    code: "INVALID_JOB",
    message: what ? `${what} must name a valid ${field}.` : `${field} must be a MongoDB ObjectId.`,
    retryable: false,
  });
}
