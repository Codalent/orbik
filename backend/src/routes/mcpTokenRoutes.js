import { Router } from "express";

import { createMcpTokenController } from "../controllers/mcpTokenController.js";
import { requireAuthentication } from "../middleware/auth.js";
import { validateGrantId, validateTokenCreation, validateTokenId, validateUsageQuery } from "../validators/mcpTokenValidators.js";
import { validateWorkspaceScope } from "../validators/shared.js";

/**
 * Builds the routes behind "Connect your AI": everything that may read one workspace, and how to
 * stop it.
 *
 * A credential may read several workspaces, so it is listed on the card of every workspace it
 * reads, and revoking it from any of those cards stops it everywhere. The routes stay addressed
 * under a workspace because that is where the person is standing; the check is that they can open
 * the workspace, in any role, and that the credential is theirs and covers it. Every person sees
 * only their own credentials, so a workspace's owner never sees, or revokes, a member's.
 *
 * Two kinds of credential, one card, because a person does not think of them as two things. A
 * **token** is one they pasted into an editor; a **grant** is one they approved when an app asked.
 * They are listed and revoked side by side here for that reason, even though they are issued by
 * completely different routes — the pasted one by `POST` below, the approved one by the OAuth
 * consent flow.
 *
 * Session-authenticated and CSRF-protected like every other thing a person does in the app. The
 * credentials these routes manage never meet the routes themselves: a session cannot call `/mcp`,
 * and neither a token nor an access token can call anything here.
 *
 * Revoking is a POST rather than a DELETE because nothing is deleted: the row is kept and marked
 * revoked, so the card can still show what was connected and when it was last used.
 *
 * `mcp-usage` is what everybody's connected AIs did here — the calls, the clients, the questions
 * and which of them came back empty — read from the MCP call log. Admins and the owner only (the
 * service checks), and read-only.
 */
export function createMcpTokenRouter({ mcpTokenService, oauthService, mcpUsageService, csrfProtection }) {
  const router = Router();
  const controller = createMcpTokenController({ mcpTokenService, oauthService, mcpUsageService });
  const base = "/v1/workspaces/:workspaceId/mcp-tokens";
  const grants = "/v1/workspaces/:workspaceId/mcp-grants";

  router.post(base, requireAuthentication, csrfProtection, validateWorkspaceScope, validateTokenCreation, controller.createToken);
  router.get(base, requireAuthentication, validateWorkspaceScope, controller.listTokens);
  router.post(`${base}/:tokenId/revoke`, requireAuthentication, csrfProtection, validateWorkspaceScope, validateTokenId, controller.revokeToken);
  router.get(grants, requireAuthentication, validateWorkspaceScope, controller.listGrants);
  router.post(`${grants}/:grantId/revoke`, requireAuthentication, csrfProtection, validateWorkspaceScope, validateGrantId, controller.revokeGrant);
  router.get("/v1/workspaces/:workspaceId/mcp-usage", requireAuthentication, validateWorkspaceScope, validateUsageQuery, controller.usage);

  return router;
}
