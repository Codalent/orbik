"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NeutralLoading } from "@/components/NeutralLoading";
import { extensionApi, useExtensionSlots } from "@/lib/extensions/slots";
import { useEdition } from "@/lib/api/edition";
import { AUTH_LINK, AuthError, AuthField, AuthPanel, AuthPanelFoot } from "./AuthFrame";
import { AuthDivider, GoogleSignInButton, googleSignInOffered } from "./GoogleSignIn";
import { SignupDisabledForm } from "./SignupDisabledForm";

/**
 * The pieces the sign-in pages are built from, handed to an extension's signup page so it looks
 * like them. `googleSignIn` says whether this install offers Continue with Google.
 */
function useAuthKit() {
  const { edition } = useEdition();
  return {
    AuthPanel, AuthField, AuthError, AuthPanelFoot, AuthDivider, GoogleSignInButton,
    Button, Input, Link, AUTH_LINK,
    googleSignIn: googleSignInOffered(edition),
  };
}

/**
 * `/signup` on an install with no admin to ask (`ORBIK_INSTALL_ADMIN=off`) and no way of its own to
 * make an account: people join by invite.
 */
function InviteOnlyNotice() {
  return (
    <AuthPanel title="Invite only" description="Accounts here are made by invite.">
      <p className="text-sm text-orb-gray">
        Ask someone who manages a workspace here to invite you. Their invite link makes your account.
      </p>
      <AuthPanelFoot><Link href="/login" className={AUTH_LINK}>Back to sign in</Link></AuthPanelFoot>
    </AuthPanel>
  );
}

/**
 * `/signup`. Orbik has no self-service signup: here a person asks the install's admins for access
 * (the Request access form), or, on an install with no admin, is told to ask for an invite. A
 * deployment whose extension adds a way to make an account puts its own page here instead (the
 * `signupPage` slot), which is handed the app's API client and the sign-in pages' pieces.
 */
export function SignupPage() {
  const { signupPage } = useExtensionSlots();
  const { edition } = useEdition();
  const ui = useAuthKit();
  const { status, page } = signupPage();
  if (status === "loading" || !edition) return <NeutralLoading inline />;
  if (status === "missing") return edition.accessRequests === false ? <InviteOnlyNotice /> : <SignupDisabledForm />;
  const { Component } = page;
  return <Component api={extensionApi} ui={ui} />;
}
