import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { signInSession } from "./authService.js";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

/** How long a sign-in may take between leaving for Google and coming back. */
const ATTEMPT_LIFETIME_MS = 10 * 60 * 1000;

/** The path, on the API, Google sends the browser back to. Registered in Google's console. */
export const GOOGLE_CALLBACK_PATH = "/v1/auth/google/callback";

/**
 * A sign-in that did not end in a session, said to the sign-in page as `?google=<reason>`. Only
 * the reason travels, never a message: the page has its own words for each, so a link cannot make
 * it say something else.
 */
export class GoogleSignInRefusal extends Error {
  constructor(reason, detail = null) {
    super(`Google sign-in refused: ${reason}`);
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Signing in with Google (OpenID Connect, the authorization code flow with PKCE), on an install
 * with `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set.
 *
 * The account is found by the Google account's own id once it is linked, and otherwise by its
 * address — only one Google says is verified, which proves the same thing a password reset link
 * does, that the person holds that mailbox — and linked then. With nothing found, an account is
 * made only when this install's signup is open; extensions' signup checks run first (told
 * `method: "google"`) and `account.created` follows with `via: "google"`. Such an account has no
 * password; Forgot password can give it one.
 *
 * The ID token comes straight from Google's token endpoint over TLS, in exchange for a code only
 * this client's secret redeems, so its claims are checked (issuer, audience, expiry, nonce) but its
 * signature is not fetched and verified (OpenID Connect Core § 3.1.3.7, item 6).
 *
 * @param {object} options
 * @param {{googleClientId: string, googleClientSecret: string, publicApiUrl: string}} options.config
 * @param {object} options.userRepository
 * @param {{open: boolean, check: Function, events: {emit: Function}}} options.signup
 * @param {typeof fetch} [options.fetch]
 * @param {Function} [options.logger]
 */
export function createGoogleSignInService({ config, userRepository, signup, fetch: send = fetch, logger = () => {}, now = () => new Date() }) {
  const clientId = config.googleClientId;
  const clientSecret = config.googleClientSecret;
  const redirectUri = `${config.publicApiUrl}${GOOGLE_CALLBACK_PATH}`;

  async function exchange(code, verifier) {
    let response;
    try {
      response = await send(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri,
          grant_type: "authorization_code", code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new GoogleSignInRefusal("failed", `token request: ${error?.message ?? "unknown"}`);
    }
    const body = await response.json().catch(() => null);
    if (!response.ok || typeof body?.id_token !== "string") {
      throw new GoogleSignInRefusal("failed", `token endpoint answered ${response.status} ${body?.error ?? ""}`.trim());
    }
    return body.id_token;
  }

  function claimsOf(idToken, nonce) {
    let claims;
    try {
      claims = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
    } catch {
      throw new GoogleSignInRefusal("failed", "unreadable ID token");
    }
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!ISSUERS.has(claims.iss) || !audience.includes(clientId) || typeof claims.sub !== "string" || !claims.sub) {
      throw new GoogleSignInRefusal("failed", "ID token not for this client");
    }
    if (!(Number(claims.exp) * 1000 > now().getTime())) throw new GoogleSignInRefusal("failed", "ID token expired");
    if (!safeEqual(String(claims.nonce ?? ""), nonce)) throw new GoogleSignInRefusal("failed", "nonce mismatch");
    if (claims.email_verified !== true && claims.email_verified !== "true") throw new GoogleSignInRefusal("unverified");
    if (typeof claims.email !== "string" || !claims.email.includes("@")) throw new GoogleSignInRefusal("unverified");
    return { sub: claims.sub, email: claims.email };
  }

  /** The account this Google account signs in to: linked, linked now, or made now. */
  async function accountFor({ sub, email }, request) {
    const linked = await userRepository.findByGoogleSub(sub);
    if (linked) {
      if (linked.status !== "active") throw new GoogleSignInRefusal("disabled");
      return linked;
    }
    const existing = await userRepository.findByEmail(email);
    if (existing) {
      if (existing.status !== "active") throw new GoogleSignInRefusal("disabled");
      // Linked to another Google account already: the address moved between Google accounts,
      // which is for a person to sort out, not to be decided here.
      if (!(await userRepository.linkGoogle(existing._id, sub))) throw new GoogleSignInRefusal("linked-elsewhere");
      logger("info", "auth.google_linked", { userId: existing._id.toHexString() });
      return existing;
    }
    if (!signup.open) throw new GoogleSignInRefusal("no-account");
    try {
      await signup.check({ email, fields: {}, request, method: "google" });
    } catch (error) {
      if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
        throw new GoogleSignInRefusal("refused", typeof error.code === "string" ? error.code : null);
      }
      throw error;
    }
    let user;
    try {
      user = await userRepository.create({ email, passwordHash: null, status: "active", googleSub: sub });
    } catch (error) {
      // The same person in two tabs: the other made it a moment ago.
      if (error.code !== 11000) throw error;
      const made = await userRepository.findByGoogleSub(sub);
      if (!made) throw new GoogleSignInRefusal("linked-elsewhere");
      return made;
    }
    await signup.events.emit("account.created", { user: { id: user._id.toHexString(), email: user.email }, via: "google" });
    return user;
  }

  return {
    /**
     * Starts a sign-in: remembers, in this browser's session, the values that tie Google's answer
     * to it, and answers the address to send the browser to.
     *
     * @param {import("express").Request} request
     * @param {string|null} next where to go once signed in, a path in the web app
     */
    start(request, next) {
      const state = randomBytes(24).toString("base64url");
      const nonce = randomBytes(24).toString("base64url");
      const verifier = randomBytes(48).toString("base64url");
      request.session.googleSignIn = { state, nonce, verifier, next, startedAt: now().getTime() };
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email",
        state,
        nonce,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        prompt: "select_account",
      }).toString();
      return url.toString();
    },

    /**
     * Finishes a sign-in Google sent back: checks it belongs to this browser's attempt, redeems
     * the code, finds or makes the account and signs this browser in.
     *
     * @returns {Promise<{next: string|null}>} where the attempt asked to go
     * @throws {GoogleSignInRefusal}
     */
    async finish(request, { code, state, error }) {
      const attempt = request.session.googleSignIn;
      delete request.session.googleSignIn;
      if (!attempt || !safeEqual(String(state ?? ""), attempt.state) || now().getTime() - attempt.startedAt > ATTEMPT_LIFETIME_MS) {
        throw new GoogleSignInRefusal("expired");
      }
      if (error) throw new GoogleSignInRefusal(error === "access_denied" ? "cancelled" : "failed", `Google said ${String(error).slice(0, 64)}`);
      if (typeof code !== "string" || !code) throw new GoogleSignInRefusal("failed", "no code");
      const identity = claimsOf(await exchange(code, attempt.verifier), attempt.nonce);
      const user = await accountFor(identity, request);
      await signInSession(request, user);
      return { next: attempt.next };
    },
  };
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
