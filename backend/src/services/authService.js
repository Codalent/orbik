import { randomBytes } from "node:crypto";

import argon2 from "argon2";

import { AppError } from "../errors/appError.js";
import { hashToken, isTokenShape, mintToken } from "./oneTimeLink.js";

const dummyHashPromise = argon2.hash("not-a-real-account-password", { type: argon2.argon2id });

/** How long a signup's confirmation link works. A day: long enough to find the email tomorrow. */
const VERIFICATION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const VERIFICATION_PREFIX = "orbv_";

function verificationNotFound() {
  return new AppError({ status: 404, code: "SIGNUP_LINK_NOT_FOUND", message: "This confirmation link was not found. Sign up again for a new one." });
}

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
  verification = null,
}) {
  // With ORBIK_SIGNUP_VERIFY_EMAIL on: where pending signups are kept, how the link is sent, and the
  // web app's address the link opens. Null when signup makes the account at once.
  const pending = verification?.collection ?? null;
  const now = verification?.now ?? (() => new Date());

  /** Creates a self-service account, signs this browser in and tells extensions, as signup does. */
  async function createSignedUp({ email, passwordHash, request }) {
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
  }

  /**
   * Keeps a signup until its address is confirmed and emails the link that confirms it. Signing up
   * again with the same address replaces the earlier one, and its link stops working.
   */
  async function startVerification({ email, passwordHash }) {
    const at = now();
    const token = mintToken(VERIFICATION_PREFIX);
    const expiresAt = new Date(at.getTime() + VERIFICATION_LIFETIME_MS);
    const row = { email, passwordHash, tokenHash: hashToken(token), createdAt: at, expiresAt };
    try {
      await pending.updateOne({ email }, { $set: row }, { upsert: true });
    } catch (error) {
      // Two signups for one address at once: the other made the row, so this one replaces it.
      if (error.code !== 11000) throw error;
      await pending.updateOne({ email }, { $set: row });
    }
    const url = `${verification.origin}/verify-email/${token}`;
    try {
      await verification.sendEmail({
        to: email,
        subject: "Confirm your email address for Orbik",
        text: [
          "Someone, hopefully you, signed up for Orbik with this address.",
          "",
          "Open this link to confirm it and finish making your account. It works once, for a day:",
          url,
          "",
          "If it was not you, ignore this email: no account is made without it.",
        ].join("\n"),
      });
    } catch (error) {
      verification.logger?.("warn", "auth.signup_verification_email_failed", { message: error?.message ?? "unknown" });
      throw new AppError({ status: 502, code: "EMAIL_NOT_SENT", message: "The confirmation email could not be sent. Try again in a moment." });
    }
    return { verificationSent: true, email, expiresAt: expiresAt.toISOString() };
  }

  async function findPending(token) {
    if (!pending) throw verificationNotFound();
    if (!isTokenShape(token, VERIFICATION_PREFIX)) throw verificationNotFound();
    const row = await pending.findOne({ tokenHash: hashToken(token) });
    if (!row) throw verificationNotFound();
    if (row.expiresAt <= now()) {
      throw new AppError({ status: 410, code: "SIGNUP_LINK_EXPIRED", message: "This confirmation link has expired. Sign up again for a new one." });
    }
    return row;
  }

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
    async signup({ email, password, fields = {}, request }) {
      if (!signup.open) {
        throw new AppError({ status: 403, code: "SIGNUP_DISABLED", message: "Self-service signup is unavailable." });
      }
      try {
        await signup.check({ email, fields, request });
      } catch (error) {
        // An extension's refusal is answered as it was given — a 4xx status and a code of its own —
        // and anything else it throws is a fault, answered as one.
        if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 && typeof error.code === "string") {
          throw new AppError({ status: error.status, code: error.code, message: error.message });
        }
        throw error;
      }
      const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
      if (!pending) return createSignedUp({ email, passwordHash, request });
      // No account until the address is confirmed. One that is already taken is said now, as it
      // would be without confirmation, rather than after a link that could only fail.
      if (await userRepository.findByEmail(email)) {
        throw new AppError({ status: 409, code: "ACCOUNT_EXISTS", message: "An account already uses that address. Sign in instead." });
      }
      return startVerification({ email, passwordHash });
    },

    /** What a confirmation link is for, to show before it is used: the address and its expiry. */
    async describeSignupVerification(token) {
      const row = await findPending(token);
      return { email: row.email, expiresAt: row.expiresAt.toISOString() };
    },

    /**
     * Uses a confirmation link: makes the account the signup asked for, signs this browser in and
     * tells extensions `account.created`, then forgets the pending signup. Works once.
     */
    async confirmSignup({ token, request }) {
      const row = await findPending(token);
      const claimed = await pending.findOneAndDelete({ _id: row._id, tokenHash: row.tokenHash, expiresAt: { $gt: now() } });
      if (!claimed) throw verificationNotFound();
      return createSignedUp({ email: claimed.email, passwordHash: claimed.passwordHash, request });
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
