/**
 * The status each OAuth error code answers with.
 *
 * From RFC 6749 §5.2 and RFC 7591 §3.2.2. `invalid_client` is `401` because it is an
 * authentication failure about the client itself; everything else the client could have got right
 * is a `400`, and only `server_error` is ours.
 */
const STATUSES = Object.freeze({
  invalid_request: 400,
  invalid_client: 401,
  invalid_grant: 400,
  unauthorized_client: 400,
  unsupported_grant_type: 400,
  unsupported_response_type: 400,
  invalid_scope: 400,
  access_denied: 400,
  invalid_redirect_uri: 400,
  invalid_client_metadata: 400,
  server_error: 500,
});

/**
 * A failure in the OAuth surface, which answers in OAuth's own envelope rather than Orbik's.
 *
 * It is a separate error type from `AppError` because the two have different readers. `AppError`
 * is read by Orbik's own web app, which knows `{error: {code, message, correlationId}}`. An OAuth
 * error is read by somebody else's client, which knows `{error, error_description}` and nothing
 * about Orbik — a client that received Orbik's envelope would report the server as broken rather
 * than tell the person what to fix.
 *
 * `description` is written for the developer integrating a client, never for an end user, and never
 * repeats anything it was given: an error that echoed a `redirect_uri` back into a page would be a
 * reflection a client could aim somewhere.
 */
export class OAuthError extends Error {
  /**
   * @param {object} failure
   * @param {string} failure.code an RFC 6749 or RFC 7591 error code
   * @param {string} failure.message what a developer should do about it
   */
  constructor({ code, message }) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
    this.status = STATUSES[code] ?? 400;
  }

  /** The body this error answers with, in the shape every OAuth client parses. */
  toResponse() {
    return { error: this.code, error_description: this.message };
  }
}

/**
 * Writes one OAuth failure to a response.
 *
 * `Cache-Control: no-store` on every one, because an intermediary that cached a `400` for a token
 * request would make a client's next, correct attempt fail too.
 */
export function sendOAuthError(res, error, logger) {
  const failure =
    error instanceof OAuthError
      ? error
      : new OAuthError({ code: "server_error", message: "Something went wrong handling that request." });

  if (failure.status >= 500) {
    logger("error", "oauth.failed", { message: error?.message ?? "unknown" });
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.status(failure.status).json(failure.toResponse());
}
