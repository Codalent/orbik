import { apiFetch } from "./client";

/**
 * Getting in without self-service signup, and back in without a password: asking for access,
 * an approved request's one-time link, a password reset link, and the Admin page's reads and writes.
 */

const TOKEN = /^orb[apv]_[A-Za-z0-9_-]{43}$/;

/**
 * The token from a link's address, or a refusal shaped like the API's 404 for an unknown link, so
 * a page shows a truncated or mangled link the way it shows one the API does not know.
 *
 * Every function below that takes a token is `async`, so this refusal arrives as a rejected
 * promise, never as an exception thrown while a page is rendering or running an effect: a page
 * that reads a link in `useEffect(() => { read(token).then(…).catch(…) })` must reach its `catch`.
 */
function requireToken(token) {
  const value = String(token ?? "");
  if (!TOKEN.test(value)) {
    const error = new Error("This link was not found. Check that the whole link was copied, or ask for a new one.");
    error.code = "LINK_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  return value;
}

/** Asks to join an invite-only install. */
export function requestAccess({ email }) {
  return apiFetch("/v1/access-requests", { method: "POST", body: JSON.stringify({ email }) });
}

/** What an approved access link is for: the address it makes an account for. */
export async function readAccessLink(token) {
  return apiFetch(`/v1/access-links/${requireToken(token)}`);
}

/** Uses an approved access link: makes the account with this password and signs it in. */
export async function acceptAccessLink(token, { password }) {
  return apiFetch(`/v1/access-links/${requireToken(token)}/accept`, { method: "POST", body: JSON.stringify({ password }) });
}

/** Asks for a password reset link by email. */
export function requestPasswordReset({ email }) {
  return apiFetch("/v1/auth/password-resets", { method: "POST", body: JSON.stringify({ email }) });
}

/** What a reset link is for. */
export async function readPasswordReset(token) {
  return apiFetch(`/v1/auth/password-resets/${requireToken(token)}`);
}

/** Sets the new password with a reset link, and signs this browser in. */
export async function completePasswordReset(token, { password }) {
  return apiFetch(`/v1/auth/password-resets/${requireToken(token)}/complete`, { method: "POST", body: JSON.stringify({ password }) });
}

/** The Admin page's read, as an SWR key: every access request, or those of one status. */
export function accessRequestsPath({ status } = {}) {
  return status ? `/v1/admin/access-requests?status=${encodeURIComponent(status)}` : "/v1/admin/access-requests";
}

/** Approves a request: returns its one-time link, and whether it was emailed. */
export function approveAccessRequest(id) {
  return apiFetch(`/v1/admin/access-requests/${encodeURIComponent(id)}/approve`, { method: "POST", body: "{}" });
}

/** Dismisses a request. */
export function dismissAccessRequest(id) {
  return apiFetch(`/v1/admin/access-requests/${encodeURIComponent(id)}/dismiss`, { method: "POST", body: "{}" });
}

/** An admin's reset link for someone's account, to hand over. */
export function createPasswordResetLink({ email }) {
  return apiFetch("/v1/admin/password-resets", { method: "POST", body: JSON.stringify({ email }) });
}

/** What a signup's confirmation link is for: the address, and until when it works. */
export async function readSignupVerification(token) {
  return apiFetch(`/v1/auth/signup-verifications/${requireToken(token)}`);
}

/** Confirms a signup's address with its link: makes the account, and signs this browser in. */
export async function confirmSignup(token) {
  return apiFetch(`/v1/auth/signup-verifications/${requireToken(token)}/confirm`, { method: "POST", body: JSON.stringify({}) });
}

/** The API's refusals on these pages, as sentences a person reads. */
export function describeAccessError(error, fallback = "Something went wrong. Try again.") {
  switch (error?.code) {
    case "RATE_LIMITED": return "Too many tries. Wait a few minutes and try again.";
    case "SIGNUP_OPEN": return "Signup is open here: create an account instead.";
    case "EMAIL_NOT_CONFIGURED": return "This Orbik can't send email. Ask its admin for a reset link.";
    case "ACCOUNT_EXISTS": return "That address already has an account. Sign in instead.";
    case "ACCOUNT_NOT_FOUND": return "No active account uses that address.";
    case "VALIDATION_FAILED": return error.fields?.[0]?.message ?? "Check what you entered.";
    default: return error?.message || fallback;
  }
}
