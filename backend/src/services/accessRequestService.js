import argon2 from "argon2";
import { ObjectId } from "mongodb";
import { COLLECTIONS, log as defaultLog } from "@orbik/core";

import { AppError } from "../errors/appError.js";
import { canonicalizeEmail } from "../repositories/userRepository.js";
import { signInSession } from "./authService.js";
import { hashToken, isTokenShape, mintToken } from "./oneTimeLink.js";

/** How long an approved link works. */
const LINK_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_PREFIX = "orba_";
const STATUSES = ["pending", "approved", "dismissed", "joined"];

function notFound() {
  return new AppError({ status: 404, code: "ACCESS_LINK_NOT_FOUND", message: "This link was not found." });
}

/**
 * Asking to join an install whose signup is closed, and an admin's answer.
 *
 * Somebody on the closed signup page leaves their address; it lands on the Admin page as one row
 * per address (asking again updates it). Whoever asks is told the same thing whether or not the
 * address already has an account, so the form cannot be used to find out who is here. An admin
 * approves a request — which makes a one-time link, emailed to the address when this install sends
 * email and shown to the admin either way — or dismisses it. The link makes an account for that
 * address and no other, and signs it in; the person then adds their first workspace.
 *
 * @param {object} options
 * @param {import("mongodb").Db} options.database
 * @param {object} options.userRepository
 * @param {{addresses: () => Promise<string[]>}} options.admins told about each new request by email
 * @param {{frontendOrigins: string[], signup: string}} options.config
 * @param {((message: object) => Promise<void>)|null} [options.sendEmail]
 * @param {{emit: Function}} [options.events] told `access.requested` and `account.created`
 * @param {Function} [options.logger]
 * @param {() => Date} [options.now]
 */
export function createAccessRequestService({
  database,
  userRepository,
  admins,
  config,
  sendEmail = null,
  events = { emit: async () => {} },
  logger = defaultLog,
  now = () => new Date(),
}) {
  const requests = database.collection(COLLECTIONS.accessRequests);
  const origin = config.frontendOrigins[0];

  function toRow(row) {
    return {
      id: row._id.toHexString(),
      email: row.email,
      status: row.status,
      requestCount: row.requestCount ?? 1,
      firstRequestedAt: row.firstRequestedAt.toISOString(),
      lastRequestedAt: row.lastRequestedAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decidedBy: row.decidedBy ?? null,
      linkExpiresAt: row.status === "approved" ? row.approval?.expiresAt?.toISOString() ?? null : null,
      joinedAt: row.joinedAt?.toISOString() ?? null,
    };
  }

  async function send(message, event) {
    if (!sendEmail) return false;
    try {
      await sendEmail(message);
      return true;
    } catch (error) {
      logger("warn", event, { message: error?.message ?? "unknown" });
      return false;
    }
  }

  async function findByToken(token) {
    if (!isTokenShape(token, TOKEN_PREFIX)) throw notFound();
    const row = await requests.findOne({ "approval.tokenHash": hashToken(token) });
    if (!row) throw notFound();
    if (row.status === "joined") throw new AppError({ status: 410, code: "ACCESS_LINK_USED", message: "This link has already been used. Sign in instead." });
    if (row.status !== "approved") throw notFound();
    if (row.approval.expiresAt <= now()) throw new AppError({ status: 410, code: "ACCESS_LINK_EXPIRED", message: "This link has expired. Ask for access again." });
    return row;
  }

  return {
    /**
     * Records a request to join. Only while signup is closed: with it open there is nothing to ask.
     * A dismissed request asked again is pending again; an approved one keeps its link.
     */
    async request({ email }) {
      if (config.signup === "open") {
        throw new AppError({ status: 409, code: "SIGNUP_OPEN", message: "Signup is open here: create an account instead." });
      }
      const address = canonicalizeEmail(email);
      const at = now();
      const before = await requests.findOneAndUpdate(
        { email: address },
        {
          $setOnInsert: { email: address, firstRequestedAt: at },
          $set: { lastRequestedAt: at },
          $inc: { requestCount: 1 },
        },
        { upsert: true, returnDocument: "before" },
      );
      if (!before || before.status === "dismissed") {
        await requests.updateOne({ email: address }, { $set: { status: "pending" }, $unset: { decidedAt: "", decidedBy: "" } });
      }
      // Tell the admins about a request they have not seen yet, never about one asked again.
      if (!before) {
        const row = await requests.findOne({ email: address });
        await events.emit("access.requested", { request: { id: row._id.toHexString(), email: address } });
        const to = await admins.addresses();
        if (to.length) {
          await send({
            to: to.join(", "),
            subject: `${address} asked for access to Orbik`,
            text: [
              `${address} asked to join your Orbik.`,
              "",
              "Approve or dismiss it on the Admin page:",
              `${origin}/admin`,
            ].join("\n"),
          }, "access.request_notify_failed");
        }
      }
    },

    /** Every request, newest first, optionally of one status; and how many are pending. */
    async list({ status } = {}) {
      const filter = STATUSES.includes(status) ? { status } : {};
      const [rows, pending] = await Promise.all([
        requests.find(filter).sort({ lastRequestedAt: -1 }).limit(500).toArray(),
        requests.countDocuments({ status: "pending" }),
      ]);
      return { requests: rows.map(toRow), pending, emailConfigured: Boolean(sendEmail) };
    },

    /**
     * Approves a request: a new one-time link for its address, replacing any earlier one. The link
     * is returned once, for the admin to send if the email did not go.
     */
    async approve({ id, admin }) {
      if (!ObjectId.isValid(id)) throw notFound();
      const row = await requests.findOne({ _id: new ObjectId(id) });
      if (!row) throw new AppError({ status: 404, code: "ACCESS_REQUEST_NOT_FOUND", message: "That request was not found." });
      if (await userRepository.findByEmail(row.email)) {
        await requests.updateOne({ _id: row._id }, { $set: { status: "joined", joinedAt: row.joinedAt ?? now() }, $unset: { approval: "" } });
        throw new AppError({ status: 409, code: "ACCOUNT_EXISTS", message: "That address already has an account. They can sign in." });
      }
      const token = mintToken(TOKEN_PREFIX);
      const at = now();
      const expiresAt = new Date(at.getTime() + LINK_LIFETIME_MS);
      await requests.updateOne(
        { _id: row._id },
        { $set: { status: "approved", decidedAt: at, decidedBy: admin.email, approval: { tokenHash: hashToken(token), expiresAt } } },
      );
      const url = `${origin}/join/${token}`;
      const emailed = await send({
        to: row.email,
        subject: "Your Orbik access is ready",
        text: [
          "You asked to join Orbik, and you're in.",
          "",
          "Open this link to choose a password and create your account. It works once, and for seven days:",
          url,
        ].join("\n"),
      }, "access.approval_email_failed");
      const updated = await requests.findOne({ _id: row._id });
      return { request: toRow(updated), url, emailed };
    },

    /** Dismisses a request; any link it had stops working. */
    async dismiss({ id, admin }) {
      if (!ObjectId.isValid(id)) throw notFound();
      const result = await requests.findOneAndUpdate(
        { _id: new ObjectId(id), status: { $ne: "joined" } },
        { $set: { status: "dismissed", decidedAt: now(), decidedBy: admin.email }, $unset: { approval: "" } },
        { returnDocument: "after" },
      );
      if (!result) throw new AppError({ status: 404, code: "ACCESS_REQUEST_NOT_FOUND", message: "That request was not found, or the person has already joined." });
      return { request: toRow(result) };
    },

    /** What an approved link is for, for its page: the address it makes an account for. */
    async describeLink(token) {
      const row = await findByToken(token);
      return { email: row.email, expiresAt: row.approval.expiresAt.toISOString() };
    },

    /**
     * Uses an approved link: creates the account for its address with this password and signs it
     * in. The row is claimed with one conditional write first, so a link works once; a failure
     * after the claim gives it back.
     */
    async acceptLink({ token, password, request }) {
      const row = await findByToken(token);
      if (await userRepository.findByEmail(row.email)) {
        await requests.updateOne({ _id: row._id }, { $set: { status: "joined", joinedAt: now() } });
        throw new AppError({ status: 409, code: "ACCOUNT_EXISTS", message: "That address already has an account. Sign in instead." });
      }
      const claimed = await requests.findOneAndUpdate(
        { _id: row._id, status: "approved", "approval.tokenHash": row.approval.tokenHash },
        { $set: { status: "joined", joinedAt: now() } },
      );
      if (!claimed) throw new AppError({ status: 410, code: "ACCESS_LINK_USED", message: "This link has already been used. Sign in instead." });
      let user;
      try {
        user = await userRepository.create({ email: row.email, passwordHash: await argon2.hash(password, { type: argon2.argon2id }), status: "active" });
      } catch (error) {
        await requests.updateOne({ _id: row._id }, { $set: { status: "approved" }, $unset: { joinedAt: "" } });
        if (error.code === 11000) throw new AppError({ status: 409, code: "ACCOUNT_EXISTS", message: "That address already has an account. Sign in instead." });
        throw error;
      }
      await signInSession(request, user);
      await events.emit("account.created", { user: { id: user._id.toHexString(), email: user.email }, via: "access-request" });
    },
  };
}
