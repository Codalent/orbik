import { randomBytes, timingSafeEqual } from "node:crypto";

import { AppError } from "../errors/appError.js";

/** Ensures the current session has a high-entropy synchronizer CSRF token. */
export function ensureCsrfToken(req, _res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = randomBytes(32).toString("base64url");
  next();
}

/** Validates exact Origin and a timing-safe session-bound CSRF token. */
export function createCsrfProtection(config) {
  return function csrfProtection(req, _res, next) {
    const origin = req.get("Origin");
    const provided = req.get("X-CSRF-Token") ?? "";
    const expected = req.session?.csrfToken ?? "";
    if (
      !origin ||
      !config.frontendOrigins.includes(origin) ||
      !safeEqual(provided, expected)
    ) {
      return next(
        new AppError({
          status: 403,
          code: "CSRF_INVALID",
          message: "Request verification failed.",
        }),
      );
    }
    next();
  };
}

/** Compares variable-length caller data without invoking timingSafeEqual unsafely. */
function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length > 0 &&
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer);
}
