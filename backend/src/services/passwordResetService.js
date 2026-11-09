import argon2 from "argon2";
import { COLLECTIONS, log as defaultLog } from "@orbik/core";

import { AppError } from "../errors/appError.js";
import { signInSession } from "./authService.js";
import { hashToken, isTokenShape, mintToken } from "./oneTimeLink.js";

/** How long a reset link works. */
const LINK_LIFETIME_MS = 60 * 60 * 1000;
const TOKEN_PREFIX = "orbp_";

function notFound() {
  return new AppError({ status: 404, code: "RESET_LINK_NOT_FOUND", message: "This reset link was not found. Ask for a new one." });
}

/**
 * Forgot password: a one-time link, valid for an hour, that sets a new password for one account.
 *
 * Asked for from the sign-in page, the link is emailed when this install sends email; whoever asks
 * is told the same thing whether or not the address has an account. An install that sends no
 * email has its admin make the link instead — on the Admin page, or with `reset:password` from a
 * terminal — and hand it over. A new link replaces the account's earlier ones.
 *
 * Using it sets the password, signs out every session the account had, and signs this browser in.
 *
 * @param {object} options
 * @param {import("mongodb").Db} options.database
 * @param {object} options.userRepository
 * @param {{frontendOrigins: string[]}} options.config
 * @param {((message: object) => Promise<void>)|null} [options.sendEmail]
 * @param {Function} [options.logger]
 * @param {() => Date} [options.now]
 */
export function createPasswordResetService({ database, userRepository, config, sendEmail = null, logger = defaultLog, now = () => new Date() }) {
  const resets = database.collection(COLLECTIONS.passwordResets);
  const sessions = database.collection(COLLECTIONS.sessions);
  const origin = config.frontendOrigins[0];

  /** A new link for an active account, replacing its unused ones. */
  async function issue(user, createdBy) {
    const at = now();
    await resets.deleteMany({ userId: user._id, usedAt: null });
    const token = mintToken(TOKEN_PREFIX);
    await resets.insertOne({
      userId: user._id,
      tokenHash: hashToken(token),
      createdAt: at,
      createdBy,
      expiresAt: new Date(at.getTime() + LINK_LIFETIME_MS),
      usedAt: null,
    });
    return `${origin}/reset-password/${token}`;
  }

  async function findLive(token) {
    if (!isTokenShape(token, TOKEN_PREFIX)) throw notFound();
    const row = await resets.findOne({ tokenHash: hashToken(token) });
    if (!row) throw notFound();
    if (row.usedAt) throw new AppError({ status: 410, code: "RESET_LINK_USED", message: "This reset link has already been used. Ask for a new one." });
    if (row.expiresAt <= now()) throw new AppError({ status: 410, code: "RESET_LINK_EXPIRED", message: "This reset link has expired. Ask for a new one." });
    const user = await userRepository.findActiveById(row.userId);
    if (!user) throw notFound();
    return { row, user };
  }

  return {
    /** Whether a person can get a link by themselves: only when this install sends email. */
    selfService: Boolean(sendEmail),

    /** Emails a link to the address when it has an account. Answers the same either way. */
    async request({ email }) {
      if (!sendEmail) {
        throw new AppError({ status: 503, code: "EMAIL_NOT_CONFIGURED", message: "This Orbik cannot send email. Ask its admin for a reset link." });
      }
      const user = await userRepository.findByEmail(email);
      if (!user || user.status !== "active") return;
      const url = await issue(user, "self");
      try {
        await sendEmail({
          to: user.email,
          subject: "Reset your Orbik password",
          text: [
            "Someone asked to reset the password of your Orbik account.",
            "",
            "Open this link to choose a new one. It works once, and for an hour:",
            url,
            "",
            "If it was not you, ignore this email: your password stays as it is.",
          ].join("\n"),
        });
      } catch (error) {
        logger("warn", "auth.password_reset_email_failed", { userId: user._id.toHexString(), message: error?.message ?? "unknown" });
      }
    },

    /** An admin's link for an account, returned to be handed over. */
    async issueFor({ email, admin }) {
      const user = await userRepository.findByEmail(email);
      if (!user || user.status !== "active") {
        throw new AppError({ status: 404, code: "ACCOUNT_NOT_FOUND", message: "No active account uses that address." });
      }
      const url = await issue(user, admin?.email ?? "operator");
      return { email: user.email, url, expiresAt: new Date(now().getTime() + LINK_LIFETIME_MS).toISOString() };
    },

    /** What a link is for, for its page. */
    async describe(token) {
      const { row, user } = await findLive(token);
      return { email: user.email, expiresAt: row.expiresAt.toISOString() };
    },

    /**
     * Sets the new password. The link is claimed first with one conditional write, so it works
     * once; every other session of the account is then removed, and this request signed in.
     */
    async complete({ token, password, request }) {
      const { row, user } = await findLive(token);
      const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
      const claimed = await resets.findOneAndUpdate(
        { _id: row._id, usedAt: null, expiresAt: { $gt: now() } },
        { $set: { usedAt: now() } },
      );
      if (!claimed) throw new AppError({ status: 410, code: "RESET_LINK_USED", message: "This reset link has already been used. Ask for a new one." });
      if (!(await userRepository.setPasswordHash(user._id, passwordHash))) throw notFound();
      await resets.deleteMany({ userId: user._id, usedAt: null });
      await sessions.deleteMany({ "session.userId": user._id.toHexString() });
      await signInSession(request, user);
    },
  };
}
