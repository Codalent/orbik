import { createHash, randomBytes } from "node:crypto";

import argon2 from "argon2";
import { ObjectId } from "mongodb";
import { log as defaultLog } from "@orbik/core";

import { AppError } from "../errors/appError.js";
import { regenerateSession } from "./authService.js";
import { createWorkspaceAccessCheck, hasRole } from "./workspaceAccess.js";

/** How long a link stays valid. */
const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** Bytes of entropy in a link's token. */
const TOKEN_BYTES = 32;

/** `orbi_` and 32 random bytes in base64url: exactly the shape this service hands out. */
const TOKEN_PATTERN = /^orbi_[A-Za-z0-9_-]{43}$/;

/** The only form of a token that is ever stored. */
export function hashInviteToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

/** Whether a string has the shape of an invite token; anything else is answered as unknown. */
export function isInviteTokenShape(token) {
  return TOKEN_PATTERN.test(token ?? "");
}

/** Where an invite stands at `now`. A used or revoked link stays so after its seven days too. */
function statusOf(invite, now = new Date()) {
  if (invite.acceptedAt) return "accepted";
  if (invite.revokedAt) return "revoked";
  if (invite.expiresAt <= now) return "expired";
  return "pending";
}

function inviteNotFound() {
  return new AppError({ status: 404, code: "INVITE_NOT_FOUND", message: "This invite was not found." });
}

/** The 410 for a link that can no longer be accepted, or null while it still can. */
function goneError(invite) {
  switch (statusOf(invite)) {
    case "accepted":
      return new AppError({ status: 410, code: "INVITE_USED", message: "This invite has already been accepted." });
    case "revoked":
      return new AppError({ status: 410, code: "INVITE_REVOKED", message: "This invite was revoked." });
    case "expired":
      return new AppError({ status: 410, code: "INVITE_EXPIRED", message: "This invite has expired." });
    default:
      return null;
  }
}

function memberLimitReached() {
  return new AppError({ status: 409, code: "MEMBER_LIMIT_REACHED", message: "This workspace has as many members as it may have." });
}

function inviteOwner() {
  return new AppError({ status: 409, code: "INVITE_OWNER", message: "That address belongs to the workspace's owner." });
}

/**
 * Creates the invite use cases: issuing a link from the Members list, and what happens when
 * somebody opens it.
 *
 * A link is `${frontendOrigins[0]}/invite/<token>`, the token shown once and stored only as its
 * SHA-256 — a fast hash rather than argon2id, because the token is 32 random bytes nobody can
 * guess, and the lookup must find the row by it. A link names one address: it is accepted by the
 * account with that address, or creates that account, and never by whoever happens to hold it,
 * which would make it a bearer credential for the workspace.
 *
 * Accepting is one conditional write that sets `acceptedAt` only while the invite is pending, so
 * two acceptances racing get one success between them. What a successful claim then could not
 * finish — the account could not be created, the member limit was reached by a race — gives the
 * claim back, so the link still works, and deletes an account the same request created.
 *
 * An invite carries its inviter's authority: one whose inviter is no longer the owner or an admin
 * of the workspace — removed, left, demoted — is revoked when it is next opened or accepted.
 *
 * `maxMembersPerWorkspace` from the owner's plan limits, when there is one, counts member rows:
 * not the owner, and not pending invites. It is checked when the invite is made and again when it
 * is accepted. The open-source edition has no such limit.
 *
 * @param {object} dependencies
 * @param {object} dependencies.workspaceRepository access by owner or membership
 * @param {object} dependencies.inviteRepository `workspace_invites`, and the workspace behind a link
 * @param {object} dependencies.memberRepository `workspace_members`
 * @param {object} dependencies.userRepository accounts, looked up and created by address
 * @param {{frontendOrigins: string[]}} dependencies.config where the invite page is served
 * @param {(ownerId: ObjectId) => Promise<{maxMembersPerWorkspace: number|null}>} dependencies.limitsFor
 *   the owner's plan limits
 * @param {((message: object) => Promise<void>)|null} [dependencies.sendEmail] when there is one,
 *   an invite is also emailed to its address; the link is returned either way
 * @param {{emit: Function}} [dependencies.events] told `account.created` for an account an invite makes
 * @param {Function} [dependencies.logger]
 */
export function createInviteService({
  workspaceRepository,
  inviteRepository,
  memberRepository,
  userRepository,
  config,
  limitsFor,
  sendEmail = null,
  events = { emit: async () => {} },
  logger = defaultLog,
}) {
  const requireWorkspaceAccess = createWorkspaceAccessCheck(workspaceRepository);

  async function emailsById(userIds) {
    const users = await userRepository.listEmailsByIds(userIds);
    return new Map(users.map((user) => [user._id.toHexString(), user.email]));
  }

  /** The Members list's view of an invite. */
  function toInvite(invite, emails) {
    const inviter = invite.invitedBy?.toHexString() ?? null;
    return {
      id: invite._id.toHexString(),
      email: invite.email,
      role: invite.role,
      invitedBy: inviter ? { userId: inviter, email: emails.get(inviter) ?? null } : null,
      createdAt: invite.createdAt.toISOString(),
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  async function findByToken(token) {
    if (!isInviteTokenShape(token)) throw inviteNotFound();
    const invite = await inviteRepository.findByTokenHash(hashInviteToken(token));
    if (!invite) throw inviteNotFound();
    return invite;
  }

  /** The most members besides the owner the workspace may have, or null for no limit. */
  async function memberLimit(workspace) {
    return (await limitsFor(workspace.ownerId)).maxMembersPerWorkspace;
  }

  /** Refuses when one more member would take the workspace past its limit, when it has one. */
  async function refuseOverLimit(workspace) {
    const limit = await memberLimit(workspace);
    if (typeof limit !== "number") return;
    if (await memberRepository.count(workspace._id, workspace.ownerId) >= limit) throw memberLimitReached();
  }

  /**
   * Emails an invite's link to its address when this install sends email. Whether it went is
   * returned, and a failure is logged without the link: the person who made the invite has the
   * link on screen and can send it themselves.
   */
  async function emailInvite({ workspace, invite, url, inviter }) {
    if (!sendEmail) return false;
    const as = invite.role === "read-only" ? "a read-only member" : `${invite.role === "admin" ? "an" : "a"} ${invite.role}`;
    try {
      await sendEmail({
        to: invite.email,
        subject: `You're invited to ${workspace.name} on Orbik`,
        text: [
          `${inviter ?? "Someone"} invited you to join ${workspace.name} on Orbik as ${as}.`,
          "",
          "Open this link to accept. It works once, and for seven days:",
          url,
          "",
          "If you were not expecting this, you can ignore it.",
        ].join("\n"),
      });
      return true;
    } catch (error) {
      logger("warn", "workspace.invite_email_failed", {
        workspaceId: workspace._id.toHexString(),
        inviteId: invite._id.toHexString(),
        message: error?.message ?? "unknown",
      });
      return false;
    }
  }

  /** Whether whoever issued an invite may still issue it: the owner, or an admin of the workspace. */
  async function inviterStillAllowed(invite, workspace) {
    if (!invite.invitedBy) return false;
    if (workspace.ownerId?.equals(invite.invitedBy)) return true;
    const access = await workspaceRepository.findAccessibleById(invite.invitedBy, workspace._id);
    return Boolean(access) && hasRole(access.role, "admin");
  }

  /**
   * The backstop to revoking a person's invites when they lose admin: a pending invite whose
   * inviter is no longer the owner or an admin is revoked now, whatever path took their authority.
   * Returns the invite as it stands afterwards.
   */
  async function revokeIfInviterLapsed(invite, workspace) {
    if (statusOf(invite) !== "pending" || await inviterStillAllowed(invite, workspace)) return invite;
    const revoked = await inviteRepository.revokePending(workspace._id, invite._id);
    if (revoked) {
      logger("info", "workspace.invite_revoked", {
        workspaceId: workspace._id.toHexString(),
        inviteId: invite._id.toHexString(),
        reason: "inviter_lapsed",
      });
      return revoked;
    }
    return (await inviteRepository.findByTokenHash(invite.tokenHash)) ?? invite;
  }

  /**
   * The person a claimed invite was accepted for joins, with its role unless they belong already.
   * When the workspace has a limit, a row this made is kept only if it is among the first `limit`
   * rows — so of several acceptances racing past the limit, the earliest wins and the rest are
   * refused — and is otherwise taken back before the refusal.
   *
   * @returns {Promise<{member: object, created: boolean}>}
   */
  async function join({ workspace, invite, userId }) {
    const { member, created } = await memberRepository.addIfAbsent({
      workspaceId: workspace._id,
      userId,
      role: invite.role,
      invitedBy: invite.invitedBy,
    });
    const limit = created ? await memberLimit(workspace) : null;
    if (created && typeof limit === "number"
      && !(await memberRepository.isWithinLimit(workspace._id, workspace.ownerId, member._id, limit))) {
      await memberRepository.removeRow(member._id);
      throw memberLimitReached();
    }
    return { member, created };
  }

  /** The answer to a claim that lost: the invite as it stands now is no longer pending. */
  async function lostClaim(invite) {
    const current = await inviteRepository.findByTokenHash(invite.tokenHash);
    return goneError(current ?? invite) ?? goneError({ ...invite, acceptedAt: new Date() });
  }

  /**
   * Puts back what an acceptance refused after its claim had made: the member row and the account
   * this request created, then the claim, so the link works again. Never anything it did not make.
   * A failure here is logged rather than thrown, so the caller still gets the original refusal.
   */
  async function undo({ invite, claimed, memberRowId = null, createdUserId = null }) {
    try {
      if (memberRowId) await memberRepository.removeRow(memberRowId);
      if (createdUserId) await userRepository.removeJustCreated(createdUserId);
      await inviteRepository.release(invite._id, claimed.acceptedAt);
    } catch (error) {
      logger("error", "workspace.invite_undo_failed", {
        inviteId: invite._id.toHexString(),
        errorName: error.name,
      });
    }
  }

  async function finish({ workspace, invite, userId, created, member, accountCreated }) {
    await userRepository.setSelectedWorkspace(userId, workspace._id);
    logger("info", "workspace.invite_accepted", {
      workspaceId: workspace._id.toHexString(),
      inviteId: invite._id.toHexString(),
      memberId: String(userId),
      role: member.role,
      accountCreated,
      alreadyMember: !created,
    });
    return {
      workspaceId: workspace._id.toHexString(),
      role: member.role,
      selectedWorkspaceId: workspace._id.toHexString(),
      destination: "workspace-home",
    };
  }

  /** Accepts for a signed-in account whose address the invite names. */
  async function acceptAs(user, { workspace, invite }) {
    if (workspace.ownerId?.equals(user._id)) throw inviteOwner();
    const existing = await memberRepository.findValid(workspace._id, workspace.ownerId, user._id);
    if (!existing) await refuseOverLimit(workspace);
    const claimed = await inviteRepository.claim(invite._id, { acceptedBy: user._id });
    if (!claimed) throw await lostClaim(invite);
    let joined = null;
    try {
      joined = await join({ workspace, invite, userId: user._id });
      return await finish({ workspace, invite, userId: user._id, ...joined, accountCreated: false });
    } catch (error) {
      await undo({ invite, claimed, memberRowId: joined?.created ? joined.member._id : null });
      throw error;
    }
  }

  /**
   * Creates the account the invite names, accepts for it, and signs it in. The password is hashed
   * before the claim, so the window between claiming the link and the account existing is a
   * single insert. Refused after that — the limit reached by a race, anything failing — the
   * account is deleted again with the claim given back, so no half-made account is left behind.
   */
  async function acceptAsNewAccount({ workspace, invite, password, request }) {
    await refuseOverLimit(workspace);
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const claimed = await inviteRepository.claim(invite._id);
    if (!claimed) throw await lostClaim(invite);
    let user = null;
    let joined = null;
    try {
      try {
        user = await userRepository.create({ email: invite.email, passwordHash, status: "active" });
      } catch (error) {
        // The address got an account a moment ago, through another invite: sign in, then accept.
        if (error.code === 11000) throw authenticationRequired();
        throw error;
      }
      await inviteRepository.setAcceptedBy(invite._id, user._id);
      joined = await join({ workspace, invite, userId: user._id });
      await signIn(request, user);
      const finished = await finish({ workspace, invite, userId: user._id, ...joined, accountCreated: true });
      await events.emit("account.created", { user: { id: user._id.toHexString(), email: user.email }, via: "invite" });
      return finished;
    } catch (error) {
      await undo({
        invite,
        claimed,
        memberRowId: joined?.created ? joined.member._id : null,
        createdUserId: user?._id ?? null,
      });
      throw error;
    }
  }

  return {
    /**
     * Issues an invite link and returns it, the only time its token exists in a usable form. Every
     * earlier pending invite to the same address in this workspace is revoked by this one — after
     * it is stored, and only those made before it, so two made at once leave the newer pending.
     */
    async create({ userId, workspaceId, email, role }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "admin" });
      const owner = await emailsById([workspace.ownerId]);
      if (owner.get(workspace.ownerId.toHexString()) === email) throw inviteOwner();
      const account = await userRepository.findByEmail(email);
      if (account && await memberRepository.findValid(workspace._id, workspace.ownerId, account._id)) {
        throw new AppError({ status: 409, code: "ALREADY_MEMBER", message: "That address already belongs to this workspace." });
      }
      await refuseOverLimit(workspace);

      const now = new Date();
      const token = `orbi_${randomBytes(TOKEN_BYTES).toString("base64url")}`;
      const invite = await inviteRepository.create({
        workspaceId: workspace._id,
        email,
        role,
        tokenHash: hashInviteToken(token),
        invitedBy: userId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + INVITE_LIFETIME_MS),
      });
      const replaced = await inviteRepository.revokeOlderPending(workspace._id, email, invite._id, now);
      logger("info", "workspace.invite_created", {
        workspaceId: workspace._id.toHexString(),
        inviteId: invite._id.toHexString(),
        role,
        invitedBy: String(userId),
        replaced,
      });
      const inviters = await emailsById([userId]);
      const url = `${config.frontendOrigins[0]}/invite/${token}`;
      return {
        invite: toInvite(invite, inviters),
        url,
        emailed: await emailInvite({ workspace, invite, url, inviter: inviters.get(String(userId)) ?? null }),
      };
    },

    /** The workspace's pending invites, newest first. */
    async listPending({ userId, workspaceId }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "admin" });
      const invites = await inviteRepository.listPending(workspace._id);
      const emails = await emailsById(invites.map((invite) => invite.invitedBy));
      return { invites: invites.map((invite) => toInvite(invite, emails)) };
    },

    /** Revokes one pending invite; its link answers 410 from now on. */
    async revoke({ userId, workspaceId, inviteId }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "admin" });
      const invite = await inviteRepository.revokePending(workspace._id, inviteId);
      if (!invite) throw inviteNotFound();
      logger("info", "workspace.invite_revoked", {
        workspaceId: workspace._id.toHexString(),
        inviteId: invite._id.toHexString(),
        revokedBy: String(userId),
      });
      return { invite: toInvite(invite, await emailsById([invite.invitedBy])) };
    },

    /** What the invite page shows before anyone signs in. */
    async describe({ token }) {
      const found = await findByToken(token);
      const workspace = await inviteRepository.findWorkspace(found.workspaceId);
      if (!workspace) throw inviteNotFound();
      const invite = await revokeIfInviterLapsed(found, workspace);
      const emails = await emailsById([invite.invitedBy]);
      const inviter = invite.invitedBy?.toHexString() ?? null;
      return {
        invite: {
          workspace: { id: workspace._id.toHexString(), name: workspace.name },
          email: invite.email,
          role: invite.role,
          invitedBy: inviter && emails.has(inviter) ? { email: emails.get(inviter) } : null,
          expiresAt: invite.expiresAt.toISOString(),
          status: statusOf(invite),
          accountExists: Boolean(await userRepository.findByEmail(invite.email)),
        },
      };
    },

    /**
     * Accepts an invite: as the signed-in account when it has the invited address; by creating
     * that account when the address has none and a password is given; otherwise not.
     */
    async accept({ token, password, request }) {
      const found = await findByToken(token);
      const workspace = await inviteRepository.findWorkspace(found.workspaceId);
      if (!workspace) throw inviteNotFound();
      const invite = await revokeIfInviterLapsed(found, workspace);
      const gone = goneError(invite);
      if (gone) throw gone;

      const sessionUserId = request.session?.userId;
      const signedIn = ObjectId.isValid(sessionUserId) ? await userRepository.findActiveById(sessionUserId) : null;
      if (signedIn) {
        if (signedIn.email !== invite.email) {
          throw new AppError({ status: 403, code: "INVITE_EMAIL_MISMATCH", message: "This invite is for another address." });
        }
        return acceptAs(signedIn, { workspace, invite });
      }

      if (await userRepository.findByEmail(invite.email)) throw authenticationRequired();
      if (typeof password !== "string") {
        throw new AppError({
          status: 400,
          code: "VALIDATION_FAILED",
          message: "Request validation failed.",
          fields: [{ field: "password", code: "REQUIRED", message: "Choose a password of 8 to 1024 characters." }],
        });
      }
      return acceptAsNewAccount({ workspace, invite, password, request });
    },
  };
}

function authenticationRequired() {
  return new AppError({ status: 401, code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." });
}

/**
 * Signs a just-created account in exactly as login does: a new session identifier, against
 * fixation, with the user bound to it and a fresh CSRF token.
 */
async function signIn(request, user) {
  await regenerateSession(request.session);
  request.session.userId = user._id.toHexString();
  request.session.authVersion = 1;
  request.session.csrfToken = randomBytes(32).toString("base64url");
}
