import { createHash, randomBytes } from "node:crypto";

/**
 * The one-time links the signed-out pages open: an approved access request (`orba_`) and a
 * password reset (`orbp_`). Each is a prefix and 32 random bytes in base64url, shown once and
 * stored only as its SHA-256 — fast rather than argon2id, because the token is unguessable and the
 * row must be found by it, as for invite links.
 */
const TOKEN_BYTES = 32;

/** A new token with the given prefix. */
export function mintToken(prefix) {
  return `${prefix}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

/** The only form of a token that is ever stored. */
export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

/** Whether a string has the shape of a token with this prefix; anything else is answered as unknown. */
export function isTokenShape(token, prefix) {
  return typeof token === "string" && token.startsWith(prefix) && /^[A-Za-z0-9_-]{43}$/.test(token.slice(prefix.length));
}
