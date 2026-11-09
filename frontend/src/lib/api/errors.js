/** Error returned by the Orbik API using its stable public envelope. */
class ApiError extends Error {
  constructor({ status, code, message, correlationId, fields = [], retryAfterSeconds }) {
    super(message || "Something went wrong. Please try again.");
    this.name = "ApiError";
    this.status = status;
    this.code = code || "INTERNAL_ERROR";
    this.correlationId = correlationId;
    this.fields = Array.isArray(fields) ? fields : [];
    this.retryAfterSeconds = retryAfterSeconds;
  }

  fieldMessage(field) {
    return this.fields.find((entry) => entry.field === field)?.message;
  }
}

/** Converts malformed or documented API failures to one safe client error shape. */
export function normalizeApiError(status, payload, retryAfterHeader) {
  const error = payload?.error ?? {};
  return new ApiError({
    status,
    code: error.code,
    message: error.message,
    correlationId: error.correlationId,
    fields: error.fields,
    retryAfterSeconds: error.retryAfterSeconds ?? (Number(retryAfterHeader) || undefined),
  });
}
