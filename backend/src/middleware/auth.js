import { ObjectId } from "mongodb";

import { AppError } from "../errors/appError.js";

/** Requires a valid session user identifier and exposes it as an ObjectId. */
export function requireAuthentication(req, _res, next) {
  const userId = req.session?.userId;
  if (!ObjectId.isValid(userId)) {
    return next(
      new AppError({
        status: 401,
        code: "AUTHENTICATION_REQUIRED",
        message: "Authentication is required.",
      }),
    );
  }
  req.auth = { userId: new ObjectId(userId) };
  next();
}
