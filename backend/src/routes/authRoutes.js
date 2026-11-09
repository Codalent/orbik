import { Router } from "express";

import { createAuthController } from "../controllers/authController.js";
import { ensureCsrfToken } from "../middleware/csrf.js";
import { createRateLimit } from "../middleware/rateLimits.js";
import { requireAuthentication } from "../middleware/auth.js";
import { validateLogin, validateSetup, validateSignup } from "../validators/authValidators.js";

/** Builds authentication routes with security middleware in explicit order. */
export function createAuthRouter({ config, authService, setupService, csrfProtection, rateLimitCollection }) {
  const router = Router();
  const controller = createAuthController(authService, config.cookieName, setupService);
  const loginLimit = createRateLimit({
    collection: rateLimitCollection,
    keyPrefix: "login",
    points: 5,
    durationSeconds: 900,
    keyFromRequest: (req) => `${req.ip}:${String(req.body?.email ?? "").trim().toLowerCase()}`,
  });
  router.get("/v1/auth/session", ensureCsrfToken, controller.session);
  router.post("/v1/auth/login", ensureCsrfToken, csrfProtection, loginLimit, validateLogin, controller.login);
  router.post("/v1/auth/logout", requireAuthentication, csrfProtection, controller.logout);
  // Per address, as many accounts an hour as a household or an office would make, and no more:
  // the ceiling is what stops a script filling an open install with accounts.
  const signupLimit = createRateLimit({
    collection: rateLimitCollection,
    keyPrefix: "signup",
    points: 5,
    durationSeconds: 3600,
    keyFromRequest: (req) => req.ip,
  });
  router.post("/v1/auth/signup", ensureCsrfToken, csrfProtection, signupLimit, validateSignup, controller.signup);
  // The setup code is twelve characters from thirty-one; ten guesses per address per quarter hour
  // leaves it out of reach while a person who mistypes it can still try again.
  const setupLimit = createRateLimit({
    collection: rateLimitCollection,
    keyPrefix: "setup",
    points: 10,
    durationSeconds: 900,
    keyFromRequest: (req) => req.ip,
  });
  router.post("/v1/setup", ensureCsrfToken, csrfProtection, setupLimit, validateSetup, controller.setup);
  return router;
}
