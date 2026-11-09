/** Creates HTTP adapters for a workspace's Members list and the invites issued from it. */
export function createMemberController({ memberService, inviteService }) {
  return {
    /** Lists the owner and every member. */
    async list(req, res, next) {
      try {
        res.json(await memberService.list({ userId: req.auth.userId, workspaceId: req.validated.workspaceId }));
      } catch (error) { next(error); }
    },

    /** Issues an invite and returns its link, once. */
    async createInvite(req, res, next) {
      try {
        res.status(201).json(await inviteService.create({
          userId: req.auth.userId,
          workspaceId: req.validated.workspaceId,
          email: req.validated.email,
          role: req.validated.role,
        }));
      } catch (error) { next(error); }
    },

    /** Lists the pending invites. */
    async listInvites(req, res, next) {
      try {
        res.json(await inviteService.listPending({ userId: req.auth.userId, workspaceId: req.validated.workspaceId }));
      } catch (error) { next(error); }
    },

    /** Revokes one pending invite. */
    async revokeInvite(req, res, next) {
      try {
        res.json(await inviteService.revoke({
          userId: req.auth.userId,
          workspaceId: req.validated.workspaceId,
          inviteId: req.validated.inviteId,
        }));
      } catch (error) { next(error); }
    },

    /** Gives a member another role. */
    async changeRole(req, res, next) {
      try {
        res.json(await memberService.changeRole({
          userId: req.auth.userId,
          workspaceId: req.validated.workspaceId,
          targetUserId: req.validated.targetUserId,
          role: req.validated.role,
        }));
      } catch (error) { next(error); }
    },

    /** Removes a member. */
    async remove(req, res, next) {
      try {
        res.json(await memberService.remove({
          userId: req.auth.userId,
          workspaceId: req.validated.workspaceId,
          targetUserId: req.validated.targetUserId,
        }));
      } catch (error) { next(error); }
    },

    /** Leaves the workspace. */
    async leave(req, res, next) {
      try {
        res.json(await memberService.leave({ userId: req.auth.userId, workspaceId: req.validated.workspaceId }));
      } catch (error) { next(error); }
    },
  };
}
