/** Creates HTTP adapters for an invite link opened in the browser. */
export function createInviteController({ inviteService }) {
  return {
    /** Describes the invite a link names, for anyone holding it. */
    async describe(req, res, next) {
      try {
        res.json(await inviteService.describe({ token: req.params.token }));
      } catch (error) { next(error); }
    },

    /**
     * Accepts it. The CSRF token is returned as login returns it, because creating the account
     * regenerates the session and the token with it.
     */
    async accept(req, res, next) {
      try {
        const result = await inviteService.accept({
          token: req.params.token,
          password: req.validated.password,
          request: req,
        });
        res.json({ ...result, csrfToken: req.session.csrfToken });
      } catch (error) { next(error); }
    },
  };
}
