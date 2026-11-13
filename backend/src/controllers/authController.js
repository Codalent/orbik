/** Creates HTTP adapters for authentication use cases. */
export function createAuthController(authService, cookieName, setupService = null) {
  return {
    /** Returns the current safe session representation and CSRF token. */
    async session(req, res, next) {
      try {
        const result = await authService.getSession(req);
        res.json({ ...result, csrfToken: req.session?.csrfToken ?? "" });
      } catch (error) { next(error); }
    },

    /** Authenticates one exact validated credential payload. */
    async login(req, res, next) {
      try {
        const result = await authService.login({ ...req.validated, request: req });
        res.json({ ...result, csrfToken: req.session.csrfToken });
      } catch (error) { next(error); }
    },

    /** Destroys the server session and expires the browser cookie. */
    async logout(req, res, next) {
      try {
        await authService.logout(req.session);
        res.clearCookie(cookieName, { path: "/" }).status(204).end();
      } catch (error) { next(error); }
    },

    /**
     * Creates an account when signup is open; refused as `SIGNUP_DISABLED` otherwise. With
     * `ORBIK_SIGNUP_VERIFY_EMAIL` on it makes none yet: it answers 202 with `verificationSent`, and
     * the emailed link makes it.
     */
    async signup(req, res, next) {
      try {
        const { email, password, extensions } = req.validated;
        const result = await authService.signup({ email, password, fields: extensions ?? {}, request: req });
        res.status(result.verificationSent ? 202 : 201).json({ ...result, csrfToken: req.session.csrfToken });
      } catch (error) { next(error); }
    },

    /** What a signup confirmation link is for: the address, and until when it works. */
    async describeSignupVerification(req, res, next) {
      try {
        res.json(await authService.describeSignupVerification(req.params.token));
      } catch (error) { next(error); }
    },

    /** Confirms a signup's address: makes the account and signs this browser in. */
    async confirmSignup(req, res, next) {
      try {
        const result = await authService.confirmSignup({ token: req.params.token, request: req });
        res.status(201).json({ ...result, csrfToken: req.session.csrfToken });
      } catch (error) { next(error); }
    },

    /** Claims a new install with its setup code, creating and signing in its first account. */
    async setup(req, res, next) {
      try {
        await setupService.claim({ ...req.validated, request: req });
        const result = await authService.getSession(req);
        res.status(201).json({ ...result, csrfToken: req.session.csrfToken });
      } catch (error) { next(error); }
    },
  };
}
