import { Router } from "express";

import { createMemberController } from "../controllers/memberController.js";
import { requireAuthentication } from "../middleware/auth.js";
import { createRateLimit } from "../middleware/rateLimits.js";
import {
  validateInviteCreation,
  validateInviteId,
  validateMemberId,
  validateRoleChange,
} from "../validators/memberValidators.js";
import { validateWorkspaceScope } from "../validators/shared.js";

/**
 * Builds the routes behind a workspace's Members list: who belongs and as what, the invites
 * issued to add people, and leaving.
 *
 * Session-authenticated and CSRF-protected where they write, like everything a person does in the
 * app. The minimum role for each is the service's to enforce — reading the list is open to every
 * member, managing it to admins and the owner — so an outsider gets the workspace's 404 from all of
 * them alike. `me` is registered before `:userId`, so leaving is never read as removing a member
 * whose identifier is "me".
 *
 * Issuing invites is limited per person — 30 an hour across every workspace — because each link
 * can create an account: a ceiling on how fast one account can hand them out.
 */
export function createMemberRouter({ memberService, inviteService, csrfProtection, rateLimitCollection }) {
  const router = Router();
  const controller = createMemberController({ memberService, inviteService });
  const inviteLimit = createRateLimit({
    collection: rateLimitCollection,
    keyPrefix: "invite-create",
    points: 30,
    durationSeconds: 3600,
    keyFromRequest: (req) => req.auth.userId.toHexString(),
  });
  const base = "/v1/workspaces/:workspaceId/members";

  router.get(base, requireAuthentication, validateWorkspaceScope, controller.list);
  router.post(`${base}/invites`, requireAuthentication, csrfProtection, inviteLimit, validateWorkspaceScope, validateInviteCreation, controller.createInvite);
  router.get(`${base}/invites`, requireAuthentication, validateWorkspaceScope, controller.listInvites);
  router.delete(`${base}/invites/:inviteId`, requireAuthentication, csrfProtection, validateWorkspaceScope, validateInviteId, controller.revokeInvite);
  router.delete(`${base}/me`, requireAuthentication, csrfProtection, validateWorkspaceScope, controller.leave);
  router.patch(`${base}/:userId`, requireAuthentication, csrfProtection, validateWorkspaceScope, validateMemberId, validateRoleChange, controller.changeRole);
  router.delete(`${base}/:userId`, requireAuthentication, csrfProtection, validateWorkspaceScope, validateMemberId, controller.remove);

  return router;
}
