import { Router } from "express";

import { createOauthConsentController } from "../controllers/oauthConsentController.js";
import { requireAuthentication } from "../middleware/auth.js";
import { validateApproval, validateRequestId } from "../validators/oauthConsentValidators.js";

/**
 * Builds the API behind the consent screen.
 *
 * Separate from `/oauth/*` on purpose, and the separation is the design rather than tidiness. The
 * OAuth endpoints are spoken by somebody else's software and carry no session; this is spoken by
 * Orbik's own web app and carries nothing else. Keeping them apart is what lets the consent screen
 * be an ordinary signed-in page — session cookie, CSRF token, the same `apiFetch` as everything
 * else — instead of an HTML template rendered by an API that renders nothing else.
 *
 * What a person decides here is which workspaces — every one they can read, or the ones they tick —
 * and whether the app may also write to their Libraries, and those are the only things they
 * decide: the client was fixed when the request was validated, a consent screen cannot name a
 * workspace the person cannot read, and writing is granted only by the box ticked here, never by
 * what the client asked for — and only when the person is a member or above in every workspace
 * chosen (`403 ROLE_INSUFFICIENT` otherwise). The approval returns a URL rather than redirecting, because the browser
 * is on the web app's origin at that point and the redirect belongs to the page, not to this API.
 */
export function createOauthConsentRouter({ oauthService, csrfProtection }) {
  const router = Router();
  const controller = createOauthConsentController(oauthService);
  const base = "/v1/oauth/requests/:requestId";

  router.get(base, requireAuthentication, validateRequestId, controller.describeRequest);
  router.post(`${base}/approve`, requireAuthentication, csrfProtection, validateRequestId, validateApproval, controller.approveRequest);
  router.post(`${base}/deny`, requireAuthentication, csrfProtection, validateRequestId, controller.denyRequest);

  return router;
}
