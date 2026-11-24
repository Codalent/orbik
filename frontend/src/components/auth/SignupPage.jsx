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
 * `/signup`. Orbik has no self-service signup: here a person asks the install's admins for access
 * (the Request access form). A deployment whose extension adds a way to make an account puts its
 * own page here instead (the `signupPage` slot), which is handed the app's API client and the
 * sign-in pages' pieces.
 */
export function SignupPage() {
  const { signupPage } = useExtensionSlots();
  const ui = useAuthKit();
  const { status, page } = signupPage();
  if (status === "loading") return <NeutralLoading inline />;
  if (status === "missing") return <SignupDisabledForm />;
  const { Component } = page;
  return <Component api={extensionApi} ui={ui} />;
}
