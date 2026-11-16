import { Router } from "express";

import { createRateCounter } from "../middleware/rateLimits.js";
import { GOOGLE_CALLBACK_PATH, GoogleSignInRefusal } from "../services/googleSignInService.js";

/**
 * Signing in with Google: two browser navigations, not API calls. `start` sends the browser to
 * Google; Google sends it back to the callback, which signs it in and sends it on to the web app.
 * Both answer with redirects, a failure included — to the sign-in page with `?google=<reason>` —
 * because there is no page of the API's own for a person to read an error on.
 *
 * Mounted only when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set.
 */
export function createGoogleSignInRouter({ config, googleSignIn, rateLimitCollection, logger = () => {} }) {
  const router = Router();
  const webApp = config.frontendOrigins[0];
  // A person signs in a few times an hour at most; this stops a script from spending the
  // install's Google quota or filling sessions, per address.
  const starts = createRateCounter({ collection: rateLimitCollection, keyPrefix: "google-start", points: 20, durationSeconds: 900 });
  const callbacks = createRateCounter({ collection: rateLimitCollection, keyPrefix: "google-callback", points: 20, durationSeconds: 900 });

  const toLogin = (reason, next) => {
    const query = new URLSearchParams({ google: reason, ...(next ? { next } : {}) });
    return `${webApp}/login?${query}`;
  };

  router.get("/v1/auth/google/start", async (req, res, next) => {
    try {
      const returnPath = safeReturnPath(req.query.next);
      if (!(await starts.take(req.ip)).allowed) return res.redirect(303, toLogin("busy", returnPath));
      res.set("Cache-Control", "no-store");
      res.redirect(303, googleSignIn.start(req, returnPath));
    } catch (error) { next(error); }
  });

  router.get(GOOGLE_CALLBACK_PATH, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const pendingNext = req.session?.googleSignIn?.next ?? null;
    try {
      if (!(await callbacks.take(req.ip)).allowed) {
        delete req.session.googleSignIn;
        return res.redirect(303, toLogin("busy", pendingNext));
      }
      const { next } = await googleSignIn.finish(req, {
        code: typeof req.query.code === "string" ? req.query.code : null,
        state: typeof req.query.state === "string" ? req.query.state : null,
        error: typeof req.query.error === "string" ? req.query.error : null,
      });
      res.redirect(303, `${webApp}${next ?? "/"}`);
    } catch (error) {
      const refusal = error instanceof GoogleSignInRefusal ? error : null;
      logger(refusal && refusal.reason !== "failed" ? "info" : "warn", "auth.google_sign_in_refused", {
        reason: refusal?.reason ?? "error",
        detail: refusal?.detail ?? error?.message ?? "unknown",
      });
      res.redirect(303, toLogin(refusal?.reason ?? "failed", pendingNext));
    }
  });

  return router;
}

/**
 * Keeps a return path only if it is a path in the web app: one leading slash, no backslash or
 * control character, and not the sign-in page again. Anything else is dropped, never corrected:
 * a sign-in that forwards wherever its query says is an open redirector.
 */
function safeReturnPath(raw) {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  if ([...raw].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) return null;
  if (raw.startsWith("/login")) return null;
  return raw;
}
