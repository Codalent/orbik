"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";

import { Button, buttonVariants } from "@/components/ui/button";
import { NeutralLoading } from "@/components/NeutralLoading";
import { confirmSignup, describeAccessError, readSignupVerification } from "@/lib/api/access";
import { cn } from "@/lib/utils";
import { workspaceHomePath } from "@/lib/workspaces/home";
import { AUTH_LINK, AuthError, AuthPanel, AuthPanelFoot } from "./AuthFrame";

/**
 * Confirms a signup's address and makes the account.
 *
 * Only when the person presses the button, never as the page loads: some mail services open every
 * link in a message to check it, and that must not make an account.
 */
export function VerifyEmailForm() {
  const { token } = useParams();
  const router = useRouter();
  const [link, setLink] = useState({ loading: true, email: null, error: null });
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    readSignupVerification(token)
      .then((described) => { if (!cancelled) setLink({ loading: false, email: described.email, error: null }); })
      .catch((caught) => { if (!cancelled) setLink({ loading: false, email: null, error: caught }); });
    return () => { cancelled = true; };
  }, [token]);

  async function confirm() {
    setConfirming(true);
    setError(null);
    try {
      const session = await confirmSignup(token);
      router.replace(session?.destination === "workspace-home" ? workspaceHomePath(session.selectedWorkspaceId) : "/workspaces/new");
    } catch (caught) {
      if (caught?.status === 404 || caught?.status === 410) setLink({ loading: false, email: null, error: caught });
      else setError(caught);
      setConfirming(false);
    }
  }

  if (link.loading) return <NeutralLoading inline />;

  if (link.error) {
    const signIn = link.error.code === "ACCOUNT_EXISTS";
    return (
      <AuthPanel title="This link has stopped working" description={describeAccessError(link.error, "This link was not found.")}>
        <Link href={signIn ? "/login" : "/signup"} className={cn(buttonVariants({ size: "lg" }), "h-10 w-full")}>
          {signIn ? "Sign in" : "Sign up again"}
        </Link>
        <AuthPanelFoot><Link href="/login" className={AUTH_LINK}>Back to sign in</Link></AuthPanelFoot>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel
      title="Confirm your email"
      description={<>Confirm <span className="font-medium text-orb-white">{link.email}</span> to finish making your account.</>}
    >
      <div className="space-y-5">
        {error && <AuthError>{describeAccessError(error)}</AuthError>}
        <Button className="h-10 w-full" type="button" onClick={confirm} disabled={confirming}>
          {confirming ? "Confirming…" : "Confirm and continue"}
        </Button>
      </div>
      <AuthPanelFoot>Have an account? <Link href="/login" className={AUTH_LINK}>Sign in</Link></AuthPanelFoot>
    </AuthPanel>
  );
}
