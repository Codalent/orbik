import { apiFetch, fetchSession as readSession } from "./client";

/** Retrieves authentication state and creates an anonymous CSRF session when necessary. */
export function fetchSession() {
  return readSession();
}

/** Authenticates a pre-provisioned account using the current CSRF session. */
export function login(credentials) {
  return apiFetch("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify(credentials),
  });
}

/** Creates an account and signs it in, on an install whose signup is open. */
export function signup(credentials) {
  return apiFetch("/v1/auth/signup", {
    method: "POST",
    body: JSON.stringify(credentials),
  });
}

/** Claims a new install with its setup code: creates the first account and signs it in. */
export function claimSetup({ code, email, password }) {
  return apiFetch("/v1/setup", {
    method: "POST",
    body: JSON.stringify({ code, email, password }),
  });
}

/** Destroys the current server-side authentication session. */
export function logout() {
  return apiFetch("/v1/auth/logout", { method: "POST", body: "{}" });
}
