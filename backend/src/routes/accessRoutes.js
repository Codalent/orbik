import { Router } from "express";

import { ensureCsrfToken } from "../middleware/csrf.js";
import { createRateLimit } from "../middleware/rateLimits.js";
import { requireAuthentication } from "../middleware/auth.js";
import { hashToken } from "../services/oneTimeLink.js";
import { validateEmailOnly, validateNewPassword } from "../validators/authValidators.js";

/**
 * The routes for getting in without self-service signup, and back in without a password:
 *
 * - `POST /v1/access-requests` — public: ask to join an invite-only install.
 * - `GET /v1/access-links/:token`, `POST …/accept` — public: an approved request's one-time link.
 * - `POST /v1/auth/password-resets` — public: email a reset link, when this install sends email.
 * - `GET /v1/auth/password-resets/:token`, `POST …/complete` — public: a reset link.
 * - `/v1/admin/…` — the install's admins: the access requests, and a reset link for someone.
 *
 * Every public write is CSRF-protected as login is and limited per address; a limiter keyed on a
 * link carries a hash of it, never the token.
 */
export function createAccessRouter({ accessRequestService, passwordResetService, admins, authService, csrfProtection, rateLimitCollection }) {
  const router = Router();
  const limit = (keyPrefix, points, durationSeconds, keyFromRequest) => createRateLimit({
    collection: rateLimitCollection, keyPrefix, points, durationSeconds, ...(keyFromRequest ? { keyFromRequest } : {}),
  });
  const byLink = (req) => `${req.ip}:${hashToken(String(req.params.token ?? "")).slice(0, 32)}`;
  const byAddress = (req) => `${req.ip}:${String(req.body?.email ?? "").trim().toLowerCase()}`;

  const session = async (req, res, status = 200) => {
    const result = await authService.getSession(req);
    res.status(status).json({ ...result, csrfToken: req.session.csrfToken });
  };
  const handle = (fn) => async (req, res, next) => {
    try { await fn(req, res); } catch (error) { next(error); }
  };

  // Asking for access: a few per address an hour, and the same answer whoever asks.
  router.post(
    "/v1/access-requests",
    ensureCsrfToken, csrfProtection,
    limit("access-request", 10, 3600), limit("access-request-address", 3, 3600, byAddress),
    validateEmailOnly,
    handle(async (req, res) => {
      await accessRequestService.request(req.validated);
      res.status(202).json({ status: "received" });
    }),
  );
  router.get("/v1/access-links/:token", limit("access-link-describe", 30, 300), handle(async (req, res) => {
    res.json(await accessRequestService.describeLink(req.params.token));
  }));
  router.post(
    "/v1/access-links/:token/accept",
    ensureCsrfToken, csrfProtection, limit("access-link-accept", 5, 900, byLink), validateNewPassword,
    handle(async (req, res) => {
      await accessRequestService.acceptLink({ token: req.params.token, password: req.validated.password, request: req });
      await session(req, res, 201);
    }),
  );

  // Forgot password.
  router.post(
    "/v1/auth/password-resets",
    ensureCsrfToken, csrfProtection,
    limit("password-reset", 10, 3600), limit("password-reset-address", 3, 3600, byAddress),
    validateEmailOnly,
    handle(async (req, res) => {
      await passwordResetService.request(req.validated);
      res.status(202).json({ status: "received" });
    }),
  );
  router.get("/v1/auth/password-resets/:token", limit("password-reset-describe", 30, 300), handle(async (req, res) => {
    res.json(await passwordResetService.describe(req.params.token));
  }));
  router.post(
    "/v1/auth/password-resets/:token/complete",
    ensureCsrfToken, csrfProtection, limit("password-reset-complete", 5, 900, byLink), validateNewPassword,
    handle(async (req, res) => {
      await passwordResetService.complete({ token: req.params.token, password: req.validated.password, request: req });
      await session(req, res);
    }),
  );

  // The Admin page.
  const admin = [requireAuthentication, admins.requireInstallAdmin];
  router.get("/v1/admin/access-requests", ...admin, handle(async (req, res) => {
    res.json(await accessRequestService.list({ status: typeof req.query.status === "string" ? req.query.status : undefined }));
  }));
  router.post("/v1/admin/access-requests/:id/approve", ...admin, csrfProtection, handle(async (req, res) => {
    res.json(await accessRequestService.approve({ id: req.params.id, admin: req.admin }));
  }));
  router.post("/v1/admin/access-requests/:id/dismiss", ...admin, csrfProtection, handle(async (req, res) => {
    res.json(await accessRequestService.dismiss({ id: req.params.id, admin: req.admin }));
  }));
  router.post("/v1/admin/password-resets", ...admin, csrfProtection, validateEmailOnly, handle(async (req, res) => {
    res.status(201).json(await passwordResetService.issueFor({ email: req.validated.email, admin: req.admin }));
  }));

  return router;
}
