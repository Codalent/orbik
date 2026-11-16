"use client";

import { useSyncExternalStore } from "react";

import { buttonVariants } from "@/components/ui/button";
import { getApiBaseUrl } from "@/lib/api/client";
import { returnPathFromCurrentUrl } from "@/lib/auth/returnPath";
import { cn } from "@/lib/utils";
import { AuthError } from "./AuthFrame";

/**
 * What the sign-in page says when a Google sign-in came back without a session (`?google=` from
 * the API's callback). The page's own words: the reason is all the address carries.
 */
const REASONS = {
  cancelled: "Google sign-in was cancelled.",
  expired: "That sign-in took too long, or finished in another browser. Try again.",
  unverified: "Google has not verified that account's email address, so it cannot sign in here.",
  "no-account": "No account here uses that Google account's address. Ask someone in a workspace for an invite, or request access.",
  disabled: "That account cannot sign in.",
  "linked-elsewhere": "That address's account is linked to a different Google account. Sign in with that one, or with your password.",
  refused: "That address cannot sign up here.",
  busy: "Too many sign-in attempts from here. Wait a few minutes and try again.",
  failed: "Google sign-in did not work. Try again.",
};

/** Whether this install offers signing in with Google (`GOOGLE_CLIENT_ID` on the API). */
export function googleSignInOffered(edition) {
  return Boolean(edition?.signInWith?.includes("google"));
}

/**
 * "Continue with Google": the browser leaves for Google and comes back, so this navigates rather
 * than fetches. The address is made at the click, in the browser: the API may be this page's own
 * origin, and the page somebody was sent here from (`next`) travels along, as with the password.
 */
export function GoogleSignInButton() {
  function go() {
    const next = returnPathFromCurrentUrl();
    // An API route, not a page of this app: a full navigation, which the router cannot do.
    window.location.href = new URL(`/v1/auth/google/start${next ? `?next=${encodeURIComponent(next)}` : ""}`, getApiBaseUrl()).toString();
  }
  return (
    <button type="button" onClick={go} className={cn(buttonVariants({ variant: "outline" }), "h-10 w-full gap-2.5")}>
      <GoogleMark />
      Continue with Google
    </button>
  );
}

/** The line between the Google button and the password form. */
export function AuthDivider({ children = "or" }) {
  return (
    <div className="my-5 flex items-center gap-3 text-xs text-orb-muted" role="separator">
      <span className="h-px flex-1 bg-orb-line/70" />
      {children}
      <span className="h-px flex-1 bg-orb-line/70" />
    </div>
  );
}

const noSubscription = () => () => {};
const reasonInAddress = () => new URLSearchParams(window.location.search).get("google");

/** The sign-in page's message for a Google sign-in that came back refused, or nothing. */
export function GoogleSignInError() {
  const value = useSyncExternalStore(noSubscription, reasonInAddress, () => null);
  if (!value) return null;
  return <AuthError className="mb-5">{REASONS[Object.hasOwn(REASONS, value) ? value : "failed"]}</AuthError>;
}

/** Google's "G", in its four colours, as its sign-in branding asks. */
function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" className="size-4">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
