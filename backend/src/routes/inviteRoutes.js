import { Router } from "express";

import { createInviteController } from "../controllers/inviteController.js";
import { ensureCsrfToken } from "../middleware/csrf.js";
import { createRateLimit } from "../middleware/rateLimits.js";
import { hashInviteToken } from "../services/inviteService.js";
import { validateInviteAcceptance } from "../validators/memberValidators.js";

/**
 * Builds the routes an invite link's page calls: what the invite is, and accepting it.
 *
 * Public, because the person opening a link may have no account yet. Describing an invite is
 * limited per address so that a link cannot be guessed by asking; accepting is limited like login
 * — five tries per quarter hour per address and link — because it can create an account and sign
 * it in, and is CSRF-protected the way login is: a page that has not first fetched the session's
 * token cannot accept for somebody. The limiter's key carries a hash of the token, never the token.
 */
export function createInviteRouter({ inviteService, csrfProtection, rateLimitCollection }) {
  const router = Router();
  const controller = createInviteController({ inviteService });
  const describeLimit = createRateLimit({
    collection: rateLimitCollection,
    keyPrefix: "invite-describe",
    points: 30,
    durationSeconds: 300,
  });
  const acceptLimit = createRateLimit({
    collection: rateLimitCollection,
    keyPrefix: "invite-accept",
    points: 5,
    durationSeconds: 900,
    keyFromRequest: (req) => `${req.ip}:${hashInviteToken(String(req.params.token ?? "")).slice(0, 32)}`,
  });

  router.get("/v1/invites/:token", describeLimit, controller.describe);
  router.post("/v1/invites/:token/accept", ensureCsrfToken, csrfProtection, acceptLimit, validateInviteAcceptance, controller.accept);

  return router;
}
