"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NeutralLoading } from "@/components/NeutralLoading";
import { acceptAccessLink, completePasswordReset, describeAccessError, readAccessLink, readPasswordReset } from "@/lib/api/access";
import { newPasswordSchema } from "@/lib/validation/auth";
import { cn } from "@/lib/utils";
import { workspaceHomePath } from "@/lib/workspaces/home";
import { AUTH_LINK, AuthError, AuthField, AuthPanel, AuthPanelFoot } from "./AuthFrame";

/** The two pages a one-time link opens to choose a password on. */
const KINDS = {
  reset: {
    read: readPasswordReset,
    use: completePasswordReset,
    title: "Choose a new password",
    describe: (email) => <>For <span className="font-medium text-orb-white">{email}</span>. You&apos;ll be signed out everywhere else.</>,
    submit: "Set password and sign in",
    working: "Saving…",
    gone: { title: "This reset link has stopped working", again: { href: "/forgot-password", label: "Ask for a new link" } },
  },
  join: {
    read: readAccessLink,
    use: acceptAccessLink,
    title: "Create your account",
    describe: (email) => <>Your access was approved. Choose a password for <span className="font-medium text-orb-white">{email}</span>.</>,
    submit: "Create account",
    working: "Creating account…",
    gone: { title: "This link has stopped working", again: { href: "/signup", label: "Request access again" } },
  },
};

/**
 * Choosing a password from a one-time link: a password reset (`/reset-password/:token`) or an
 * approved access request (`/join/:token`). The link is checked first, so one that has been used
 * or has expired says so before anybody types; either way it ends signed in.
 *
 * @param {object} props
 * @param {"reset"|"join"} props.kind
 */
export function NewPasswordForm({ kind }) {
  const copy = KINDS[kind];
  const { token } = useParams();
  const router = useRouter();
  const [link, setLink] = useState({ loading: true, email: null, error: null });
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(newPasswordSchema),
    defaultValues: { password: "", confirm: "" },
    shouldFocusError: true,
  });

  useEffect(() => {
    let cancelled = false;
    copy.read(token)
      .then((described) => { if (!cancelled) setLink({ loading: false, email: described.email, error: null }); })
      .catch((error) => { if (!cancelled) setLink({ loading: false, email: null, error }); });
    return () => { cancelled = true; };
  }, [copy, token]);

  async function submit({ password }) {
    try {
      const session = await copy.use(token, { password });
      router.replace(session?.destination === "workspace-home" ? workspaceHomePath(session.selectedWorkspaceId) : "/workspaces/new");
    } catch (error) {
      if (error?.status === 404 || error?.status === 410) setLink({ loading: false, email: null, error });
      else setError("root", { message: describeAccessError(error) });
    }
  }

  if (link.loading) return <NeutralLoading inline />;

  if (link.error) {
    const signIn = link.error.code === "ACCESS_LINK_USED" || link.error.code === "ACCOUNT_EXISTS";
    return (
      <AuthPanel title={copy.gone.title} description={describeAccessError(link.error, "This link was not found.")}>
        <Link href={signIn ? "/login" : copy.gone.again.href} className={cn(buttonVariants({ size: "lg" }), "h-10 w-full")}>
          {signIn ? "Sign in" : copy.gone.again.label}
        </Link>
        <AuthPanelFoot><Link href="/login" className={AUTH_LINK}>Back to sign in</Link></AuthPanelFoot>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel title={copy.title} description={copy.describe(link.email)}>
      <form onSubmit={handleSubmit(submit)} noValidate className="space-y-5">
        {errors.root && <AuthError>{errors.root.message}</AuthError>}
        {/* The address, for a password manager to file the new password under. */}
        <input type="email" name="email" autoComplete="username" value={link.email ?? ""} readOnly hidden />
        <AuthField htmlFor="new-password" label="New password" error={errors.password?.message} errorId="new-password-error" hint="At least 8 characters." hintId="new-password-hint">
          <Input id="new-password" type="password" autoComplete="new-password" aria-invalid={Boolean(errors.password)} aria-describedby={errors.password ? "new-password-error" : "new-password-hint"} {...register("password")} />
        </AuthField>
        <AuthField htmlFor="confirm-password" label="Confirm password" error={errors.confirm?.message} errorId="confirm-password-error">
          <Input id="confirm-password" type="password" autoComplete="new-password" aria-invalid={Boolean(errors.confirm)} aria-describedby={errors.confirm ? "confirm-password-error" : undefined} {...register("confirm")} />
        </AuthField>
        <Button className="h-10 w-full" type="submit" disabled={isSubmitting}>{isSubmitting ? copy.working : copy.submit}</Button>
      </form>
      <AuthPanelFoot><Link href="/login" className={AUTH_LINK}>Back to sign in</Link></AuthPanelFoot>
    </AuthPanel>
  );
}
