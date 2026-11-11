import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import argon2 from "argon2";
import { COLLECTIONS } from "@orbik/core";

import { AppError } from "../errors/appError.js";
import { regenerateSession } from "./authService.js";

const SETUP_ID = "setup";

/** No 0/O, 1/I/L: the code is read off a terminal and typed by hand. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const GROUPS = 3;
const GROUP_LENGTH = 4;

/**
 * First-run setup: the browser asks for the first account instead of a command having to make it.
 *
 * While the install has no account at all, the API keeps a one-time **setup code** in
 * `system_state` and prints it to its log at startup (`docker compose logs api`). The setup page
 * takes the code, an email address and a password, and creates the first account with them —
 * whoever opens a fresh install on a public address first cannot claim it without having read the
 * server's log. Once any account exists the code is deleted and the setup route answers
 * `SETUP_COMPLETE`, whoever asks: an account made by `seed:user` or an invite ends setup the same
 * way.
 *
 * The code is stored as it is shown, not hashed, because every process that starts must be able to
 * print it, and it is worth nothing once the first account exists. Anyone who can read this
 * database can already do everything an account could.
 *
 * @param {object} options
 * @param {import("mongodb").Db} options.database
 * @param {object} options.userRepository
 * @param {{emit: Function}} options.events told `account.created` when the first account is made
 * @param {() => Date} [options.now]
 */
export function createSetupService({ database, userRepository, events, now = () => new Date() }) {
  const state = database.collection(COLLECTIONS.systemState);
  const users = database.collection(COLLECTIONS.users);
  // Once an account exists, setup is over for the life of the process: it is never re-opened.
  let complete = false;

  async function required() {
    if (complete) return false;
    complete = (await users.countDocuments({}, { limit: 1 })) > 0;
    return !complete;
  }

  return {
    required,

    /**
     * Claims the install: checks the code, creates the first account, signs it in.
     *
     * The code document is claimed with one conditional update before the account is made, so two
     * people submitting at once get one account and one `SETUP_IN_PROGRESS`. A failure after the
     * claim gives it back, so the form can be submitted again.
     */
    async claim({ code, email, password, request }) {
      if (!(await required())) throw setupComplete();
      const stored = await state.findOne({ _id: SETUP_ID });
      if (!stored?.code || !sameCode(code, stored.code)) {
        throw new AppError({ status: 403, code: "SETUP_CODE_INVALID", message: "That setup code is not this install's. It is printed in the API's log." });
      }
      const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
      // A claim older than a minute belongs to an attempt that died between claiming and creating
      // the account; it is taken over rather than leaving the install unclaimable.
      const current = now();
      const claimed = await state.findOneAndUpdate(
        { _id: SETUP_ID, code: stored.code, $or: [{ claimedAt: null }, { claimedAt: { $lt: new Date(current.getTime() - 60_000) } }] },
        { $set: { claimedAt: current } },
      );
      if (!claimed) throw new AppError({ status: 409, code: "SETUP_IN_PROGRESS", message: "Someone is setting up this install right now." });

      let user;
      try {
        if (!(await required())) throw setupComplete();
        user = await userRepository.create({ email, passwordHash, status: "active" });
      } catch (error) {
        await state.updateOne({ _id: SETUP_ID, claimedAt: { $ne: null } }, { $set: { claimedAt: null } });
        throw error;
      }
      complete = true;
      await state.deleteOne({ _id: SETUP_ID });

      await regenerateSession(request.session);
      request.session.userId = user._id.toHexString();
      request.session.authVersion = 1;
      request.session.csrfToken = randomBytes(32).toString("base64url");
      await events.emit("account.created", { user: { id: user._id.toHexString(), email: user.email }, via: "setup" });
      return user;
    },
  };
}

/**
 * Makes sure an install with no account has a setup code, and returns it — or null once it has an
 * account, deleting any code left behind. Called by the API at startup to print it.
 *
 * @param {import("mongodb").Db} database
 * @returns {Promise<string|null>}
 */
export async function prepareFirstRun(database) {
  const state = database.collection(COLLECTIONS.systemState);
  const hasAccount = (await database.collection(COLLECTIONS.users).countDocuments({}, { limit: 1 })) > 0;
  if (hasAccount) {
    await state.deleteOne({ _id: SETUP_ID });
    return null;
  }
  // Written once and kept across restarts, so the code in an older log line still works.
  const document = await state.findOneAndUpdate(
    { _id: SETUP_ID },
    { $setOnInsert: { code: generateCode(), createdAt: new Date(), claimedAt: null } },
    { upsert: true, returnDocument: "after" },
  );
  return document.code;
}

/**
 * The banner the API prints while the install has no account. Plain text, for a terminal.
 *
 * The address carries the code as `?key=`, so opening it fills the setup page in; the code is also
 * printed on its own for someone typing it.
 */
export function setupBanner({ code, url }) {
  const link = new URL(url);
  link.searchParams.set("key", code);
  const lines = [
    "Orbik has no account yet. Open this address and create the first one:",
    "",
    `    ${link.href}`,
    "",
    `Setup code:  ${code}`,
    "",
    "The code works once, until the first account exists.",
  ];
  const width = Math.max(...lines.map((line) => line.length)) + 4;
  const rule = "─".repeat(width);
  return [rule, ...lines.map((line) => `  ${line}`), rule].join("\n");
}

function generateCode() {
  const groups = [];
  for (let group = 0; group < GROUPS; group += 1) {
    let part = "";
    for (let index = 0; index < GROUP_LENGTH; index += 1) part += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(part);
  }
  return groups.join("-");
}

/** Compares a typed code with the stored one, ignoring case, spaces and dashes. */
function sameCode(typed, stored) {
  const clean = (value) => Buffer.from(String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, ""));
  const left = clean(typed);
  const right = clean(stored);
  return left.length === right.length && timingSafeEqual(left, right);
}

function setupComplete() {
  return new AppError({ status: 409, code: "SETUP_COMPLETE", message: "This install already has an account. Sign in instead." });
}
