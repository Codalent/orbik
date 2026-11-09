import { matchedData, validationResult } from "express-validator";

import { AppError } from "../errors/appError.js";

/** Converts express-validator results to the stable field-error envelope. */
export function validateRequest(req, _res, next) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    const fields = result.array({ onlyFirstError: true }).slice(0, 10).map((error) => ({
      field: error.path === "_error" ? "request" : error.path,
      code: error.msg.code ?? "INVALID",
      message: error.msg.message ?? "This value is invalid.",
    }));
    return next(new AppError({
      status: 400,
      code: "VALIDATION_FAILED",
      message: "Request validation failed.",
      fields,
    }));
  }
  req.validated = matchedData(req, { includeOptionals: true });
  next();
}
