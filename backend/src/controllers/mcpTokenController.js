/** Creates HTTP adapters for the "Connect your AI" card: pasted tokens and approved apps. */
export function createMcpTokenController({ mcpTokenService, oauthService, mcpUsageService }) {
  return {
    /** What the AIs connected to the workspace asked, and what came back empty. */
    async usage(req, res, next) {
      try {
        res.json(await mcpUsageService.report({
          userId: req.auth.userId,
          workspaceId: req.validated.workspaceId,
          days: req.validated.days,
        }));
      } catch (error) { next(error); }
    },

    /** Mints a token and returns its secret, once. */
    async createToken(req, res, next) {
      try {
        const issued = await mcpTokenService.createToken({
          userId: req.auth.userId,
          workspaceId: req.validated.workspaceId,
          name: req.validated.name,
          workspaces: req.validated.workspaces,
          write: req.validated.write,
          createdFromIp: req.ip ?? null,
        });
        res.status(201).json(issued);
      } catch (error) { next(error); }
    },

    /** Lists the tokens that read the workspace, revoked ones included. */
    async listTokens(req, res, next) {
      try {
        res.json(await mcpTokenService.listTokens({ userId: req.auth.userId, workspaceId: req.validated.workspaceId }));
      } catch (error) { next(error); }
    },

    /** Retires one token. */
    async revokeToken(req, res, next) {
      try {
        res.json(await mcpTokenService.revokeToken({
          userId: req.auth.userId,
          workspaceId: req.validated.workspaceId,
          tokenId: req.validated.tokenId,
        }));
      } catch (error) { next(error); }
    },

    /** Lists the apps approved through the consent screen that read the workspace. */
    async listGrants(req, res, next) {
      try {
        res.json(await oauthService.listGrants({ userId: req.auth.userId, workspaceId: req.validated.workspaceId }));
      } catch (error) { next(error); }
    },

    /** Disconnects one app. */
    async revokeGrant(req, res, next) {
      try {
        res.json(await oauthService.revokeGrant({
          userId: req.auth.userId,
          workspaceId: req.validated.workspaceId,
          grantId: req.validated.grantId,
        }));
      } catch (error) { next(error); }
    },
  };
}
