import { Router } from "express";

import { AppError } from "../errors/appError.js";

/** Creates the readiness route without exposing dependency details. */
export function createHealthRouter(readiness) {
  const router = Router();
  router.get("/health", async (_req, res, next) => {
    try {
      if (!(await readiness())) {
        throw new AppError({
          status: 503,
          code: "SERVICE_UNAVAILABLE",
          message: "Service is temporarily unavailable.",
        });
      }
      res.json({ status: "ok" });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
