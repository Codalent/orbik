import { randomBytes } from "node:crypto";

import argon2 from "argon2";

import { AppError } from "../errors/appError.js";

const dummyHashPromise = argon2.hash("not-a-real-account-password", { type: argon2.argon2id });

/**
 * Creates authentication orchestration independent of HTTP and database details.
 *
 * @param {object} dependencies
 * @param {object} dependencies.userRepository
 * @param {object} dependencies.workspaceRepository
 * @param {object} [dependencies.signup] self-service signup: `open` (from `ORBIK_SIGNUP`), the
 *   extensions' `check` that may refuse an address, and `events`, told `account.created`
 * @param {{isAdmin: (user: object) => Promise<boolean>}} [dependencies.admins] whether an account
 *   administers the install, which the session reports so the web app can show the Admin page
 */
export function createAuthService({
  userRepository,
  workspaceRepository,
  signup = { open: false, check: async () => {}, events: { emit: async () => {} } },
  admins = { isAdmin: async () => false },
}) {
  /**
   * Resolves and repairs the user's safe post-authentication destination: the selected workspace
   * while they can still open it (owned, or as a member), otherwise the first they can.
   */
  async function resolveAuthenticated(user) {
    const selected = user.selectedWorkspaceId
      ? await workspaceRepository.findAccessibleById(user._id, user.selectedWorkspaceId)
      : null;
    let workspace = selected;
    if (!workspace) {
      const [fallback] = await workspaceRepository.listAccessible(user._id);
      workspace = fallback ?? null;
      const desired = workspace?._id ?? null;
      if (String(user.selectedWorkspaceId ?? "") !== String(desired ?? "")) {
        await userRepository.setSelectedWorkspace(user._id, desired);
      }
    }
    return {
      authenticated: true,
      user: { id: user._id.toHexString(), email: user.email, isAdmin: await admins.isAdmin(user) },
      destination: workspace ? "workspace-home" : "workspace-onboarding",
      selectedWorkspaceId: workspace?._id.toHexString() ?? null,
    };
  }

  return {
    /** Returns anonymous state or a revocation-aware authenticated state. */
    async getSession(request) {
      const { session } = request;
      const user = session.userId ? await userRepository.findActiveById(session.userId) : null;
      if (!user) {
        if (session.userId) {
          await regenerateSession(session);
          request.session.csrfToken = randomBytes(32).toString("base64url");
        }
        return { authenticated: false, user: null, destination: "login", selectedWorkspaceId: null };
      }
      return resolveAuthenticated(user);
    },

    /** Verifies credentials comparably, regenerates the identifier, and binds the user. */
    async login({ email, password, request }) {
      const user = await userRepository.findActiveForAuthentication(email);
      let valid = false;
      try {
        valid = await argon2.verify(user?.passwordHash ?? await dummyHashPromise, password);
      } catch {
        // A corrupt operational hash must remain indistinguishable from every other login failure.
        await argon2.verify(await dummyHashPromise, password).catch(() => false);
      }
      if (!user || !valid) {
        throw new AppError({
          status: 401,
          code: "AUTHENTICATION_FAILED",
          message: "The supplied credentials could not be authenticated.",
        });
      }
      await signInSession(request, user);
      return resolveAuthenticated(user);
    },

    /** Invalidates the complete server-side session. */
    logout(session) {
      return destroySession(session);
    },

    /**
     * Creates an account for whoever asks, when this install's signup is open, and signs it in.
     *
     * Closed by default (`ORBIK_SIGNUP=closed`): a self-hosted install adds people by invite. An
     * extension's checks run first and may refuse — verification, abuse limits, a waiting list.
     * An address that already has an account is told so: with signup open, that an address is
     * taken is not a secret worth a confusing error.
     */
    async signup({ email, password, request }) {
      if (!signup.open) {
        throw new AppError({ status: 403, code: "SIGNUP_DISABLED", message: "Self-service signup is unavailable." });
      }
      try {
        await signup.check({ email, request });
      } catch (error) {
        // An extension's refusal is answered as it was given — a 4xx status and a code of its own —
        // and anything else it throws is a fault, answered as one.
        if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 && typeof error.code === "string") {
          throw new AppError({ status: error.status, code: error.code, message: error.message });
        }
        throw error;
      }
      const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
      let user;
      try {
        user = await userRepository.create({ email, passwordHash, status: "active" });
      } catch (error) {
        if (error.code !== 11000) throw error;
        throw new AppError({ status: 409, code: "ACCOUNT_EXISTS", message: "An account already uses that address. Sign in instead." });
      }
      await signInSession(request, user);
      await signup.events.emit("account.created", { user: { id: user._id.toHexString(), email: user.email }, via: "signup" });
      return resolveAuthenticated(user);
    },
  };
}

/**
 * Wraps callback-based session regeneration so authentication can await fixation protection.
 * Exported for the one other place an account is signed in: accepting an invite that creates it.
 */
export function regenerateSession(session) {
  return new Promise((resolve, reject) => session.regenerate((error) => error ? reject(error) : resolve()));
}

/**
 * Signs an account in on this request: a new session identifier, against fixation, with the user
 * bound to it and a fresh CSRF token. Shared by login, signup, an approved access link and a
 * password reset.
 */
export async function signInSession(request, user) {
  await regenerateSession(request.session);
  request.session.userId = user._id.toHexString();
  request.session.authVersion = 1;
  request.session.csrfToken = randomBytes(32).toString("base64url");
}

/** Wraps callback-based destruction so responses wait for store invalidation. */
function destroySession(session) {
  return new Promise((resolve, reject) => session.destroy((error) => error ? reject(error) : resolve()));
}
