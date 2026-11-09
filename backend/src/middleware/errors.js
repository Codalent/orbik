import { randomUUID } from "node:crypto";

import { AppError } from "../errors/appError.js";
import { log } from "@orbik/core";

const CORRELATION_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** Assigns a validated caller correlation ID or a generated UUID. */
export function correlationId(req, res, next) {
  const supplied = req.get("X-Correlation-ID");
  req.correlationId = supplied && CORRELATION_PATTERN.test(supplied) ? supplied : randomUUID();
  res.set("X-Correlation-ID", req.correlationId);
  next();
}

/** Produces the stable JSON 404 response after all known routes. */
export function notFound(req, res, next) {
  next(new AppError({ status: 404, code: "NOT_FOUND", message: "Resource not found." }));
}

/** Converts errors to the documented non-sensitive envelope. */
export function errorHandler(error, req, res, _next) {
  const appError = error?.type === "entity.too.large"
    ? new AppError({ status: 413, code: "REQUEST_TOO_LARGE", message: "Request body is too large." })
    : error?.type === "entity.parse.failed"
      ? new AppError({ status: 400, code: "VALIDATION_FAILED", message: "Request JSON is malformed." })
    : error instanceof AppError
    ? error
    // Over the account's plan (`@orbik/extensions`), thrown from code shared with the worker.
    : error?.name === "PlanLimitError"
    ? new AppError({ status: 403, code: error.code, message: error.message })
    : new AppError({ status: 500, code: "INTERNAL_ERROR", expose: false });
  if (appError.status >= 500) {
    log("error", "Request failed", {
      correlationId: req.correlationId,
      errorName: error.name,
      errorCode: appError.code,
    });
  }
  const body = {
    error: {
      code: appError.code,
      message: appError.expose ? appError.message : "An unexpected error occurred.",
      correlationId: req.correlationId ?? randomUUID(),
    },
  };
  if (appError.fields?.length) body.error.fields = appError.fields;
  if (appError.retryAfterSeconds) body.error.retryAfterSeconds = appError.retryAfterSeconds;
  res.status(appError.status).json(body);
}
