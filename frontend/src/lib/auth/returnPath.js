"use client";

/** The query parameter that carries where somebody was going before they were asked to sign in. */
const RETURN_PARAM = "next";

/**
 * Builds the sign-in URL for whoever is being sent away from a page they asked for.
 *
 * Until now every sign-in landed on the workspace home, which was fine while the only way to reach
 * a protected page was from inside the app. The OAuth consent screen is the first page somebody
 * arrives at from somewhere else — an AI client sends them — and dropping them on the workspace
 * home afterwards would silently abandon the authorization they came to approve.
 *
 * Read from `window.location` rather than from `useSearchParams`, deliberately. The hook would opt
 * every page under a `ProtectedRoute` into client-side rendering up to a Suspense boundary, and
 * this value is only ever needed in the browser, in an effect, at the moment of redirecting.
 */
export function signInUrlForCurrentPage() {
  if (typeof window === "undefined") return "/login";
  const here = `${window.location.pathname}${window.location.search}`;
  // Nothing to come back to: the sign-in page would send them where it always did anyway.
  if (here === "/" || here.startsWith("/login")) return "/login";
  return `/login?${RETURN_PARAM}=${encodeURIComponent(here)}`;
}

/**
 * Reads the return path from the current URL, or null.
 *
 * Only a path within this app is ever returned. A value naming another origin — `https://…`, or the
 * protocol-relative `//evil.example` that is easy to forget — is discarded rather than corrected,
 * because a sign-in page that will forward to wherever its query string says is an open redirector,
 * and an open redirector on a sign-in page is how a convincing phishing link is built.
 */
export function returnPathFromCurrentUrl() {
  if (typeof window === "undefined") return null;
  return safeReturnPath(new URLSearchParams(window.location.search).get(RETURN_PARAM));
}

/** Keeps a return path only if it is a path, within this app, and not the sign-in page again. */
function safeReturnPath(raw) {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw.startsWith("/login")) return null;
  // `new URL` against any base resolves `/a/../..` and the like; anything that escapes this origin
  // has already been refused above, and this catches what a bare string check would not.
  try {
    const resolved = new URL(raw, window.location.origin);
    return resolved.origin === window.location.origin ? `${resolved.pathname}${resolved.search}` : null;
  } catch {
    return null;
  }
}
