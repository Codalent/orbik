import { Router } from "express";

import { createAuthController } from "../controllers/authController.js";
import { ensureCsrfToken } from "../middleware/csrf.js";
import { createRateLimit } from "../middleware/rateLimits.js";
import { requireAuthentication } from "../middleware/auth.js";
import { validateChangePassword, validateLogin, validateSetup } from "../validators/authValidators.js";

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
  // Changing the password, signed in: the current one is checked, so it is limited per account as
  // login is per address, against a stolen session guessing it.
  const passwordChangeLimit = createRateLimit({
    collection: rateLimitCollection,
    keyPrefix: "password-change",
    points: 5,
    durationSeconds: 900,
    keyFromRequest: (req) => String(req.session?.userId ?? req.ip),
  });
  router.post("/v1/auth/password", requireAuthentication, csrfProtection, passwordChangeLimit, validateChangePassword, controller.changePassword);
  // The setup code is twelve characters from thirty-one; ten guesses per address per quarter hour
  // leaves it out of reach while a person who mistypes it can still try again.
  const setupLimit = createRateLimit({
    collection: rateLimitCollection,
    keyPrefix: "setup",
    points: 10,
    durationSeconds: 900,
    keyFromRequest: (req) => req.ip,
  });
  // Only while first-run setup is on (ORBIK_FIRST_RUN_SETUP); off, the API's 404 answers.
  if (setupService) router.post("/v1/setup", ensureCsrfToken, csrfProtection, setupLimit, validateSetup, controller.setup);
  return router;
}
