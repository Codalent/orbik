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
 * @param {{isAdmin: (user: object) => Promise<boolean>}} [dependencies.admins] whether an account
 *   administers the install, which the session reports so the web app can show the Admin page
 * @param {import("mongodb").Collection} [dependencies.sessions] the session store's collection,
 *   from which changing a password removes the account's other sessions
 */
export function createAuthService({
  userRepository,
  workspaceRepository,
  admins = { isAdmin: async () => false },
  sessions = null,
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
      user: {
        id: user._id.toHexString(),
        email: user.email,
        isAdmin: await admins.isAdmin(user),
        // Whether there is a password to change: an account made by signing in with Google has none.
        hasPassword: user.hasPassword ?? typeof user.passwordHash === "string",
      },
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
     * Changes the signed-in account's password, given its current one. Every other session of the
     * account is removed, as a reset does, and this one stays signed in. An account with no
     * password (made by signing in with Google) has nothing to change: it gets one through
     * Forgot password. Answers how many other sessions were signed out.
     */
    async changePassword({ userId, currentPassword, newPassword, request }) {
      const user = await userRepository.findPasswordHashById(userId);
      if (!user) {
        throw new AppError({ status: 401, code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." });
      }
      if (typeof user.passwordHash !== "string") {
        throw new AppError({
          status: 409,
          code: "NO_PASSWORD",
          message: "This account signs in with Google and has no password to change. Use Forgot password on the sign-in page to set one.",
        });
      }
      let valid = false;
      try {
        valid = await argon2.verify(user.passwordHash, currentPassword);
      } catch {
        valid = false;
      }
      if (!valid) {
        throw new AppError({
          status: 400,
          code: "CURRENT_PASSWORD_INCORRECT",
          message: "That is not your current password.",
          fields: [{ field: "currentPassword", code: "INCORRECT", message: "That is not your current password." }],
        });
      }
      const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
      if (!(await userRepository.setPasswordHash(user._id, passwordHash))) {
        throw new AppError({ status: 401, code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." });
      }
      // connect-mongo keeps a session under its identifier, the session's `userId` inside it.
      const removed = sessions
        ? await sessions.deleteMany({ "session.userId": user._id.toHexString(), _id: { $ne: request.sessionID } })
        : { deletedCount: 0 };
      return { changed: true, otherSessionsSignedOut: removed.deletedCount ?? 0 };
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
 * bound to it and a fresh CSRF token. Shared by login, an approved access link, a password reset
 * and an extension's routes that make an account (`http.accounts.signIn`).
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
