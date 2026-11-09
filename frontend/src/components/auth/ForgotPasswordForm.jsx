"use client";

import { useState } from "react";
import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { KeyRound, MailCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NeutralLoading } from "@/components/NeutralLoading";
import { describeAccessError, requestPasswordReset } from "@/lib/api/access";
import { useEdition } from "@/lib/api/edition";
import { emailOnlySchema } from "@/lib/validation/auth";
import { AUTH_LINK, AuthError, AuthField, AuthPanel, AuthPanelFoot } from "./AuthFrame";

const NOTICE = "flex gap-2.5 rounded-lg border border-orb-cyan/40 bg-orb-cyan/10 px-3.5 py-3 text-sm text-orb-white";

/**
 * Forgot password. Where this install sends email, the person asks for a link and is emailed one;
 * the answer is the same whether or not the address has an account. Where it sends none, the
 * install's admin makes the link (Admin page, or `reset:password`), and this page says so.
 */
export function ForgotPasswordForm() {
  const { edition } = useEdition();
  const [sentTo, setSentTo] = useState(null);
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(emailOnlySchema),
    defaultValues: { email: "" },
    shouldFocusError: true,
  });

  async function submit(values) {
    try {
      await requestPasswordReset(values);
      setSentTo(values.email.trim());
    } catch (error) {
      setError("root", { message: describeAccessError(error, "The link could not be sent. Try again.") });
    }
  }

  const foot = <AuthPanelFoot><Link href="/login" className={AUTH_LINK}>Back to sign in</Link></AuthPanelFoot>;

  if (!edition) return <NeutralLoading inline />;

  if (edition.passwordReset !== "email") {
    return (
      <AuthPanel title="Forgot your password?" description="This Orbik doesn't send email.">
        <div className={NOTICE}>
          <KeyRound aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-orb-cyan" />
          <p>Ask the person who runs this Orbik for a password reset link. They can make one on the Admin page.</p>
        </div>
        {foot}
      </AuthPanel>
    );
  }

  if (sentTo) {
    return (
      <AuthPanel title="Check your email" description="The link works once, for an hour.">
        <div role="status" className={NOTICE}>
          <MailCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-orb-cyan" />
          <p className="min-w-0 [overflow-wrap:anywhere]">
            If <span className="font-medium">{sentTo}</span> has an Orbik account, we&apos;ve emailed it a link to choose a new password.
          </p>
        </div>
        {foot}
      </AuthPanel>
    );
  }

  return (
    <AuthPanel title="Forgot your password?" description="Enter your account's email and we'll send you a link to choose a new one.">
      <form onSubmit={handleSubmit(submit)} noValidate className="space-y-5">
        {errors.root && <AuthError>{errors.root.message}</AuthError>}
        <AuthField htmlFor="reset-email" label="Email" error={errors.email?.message} errorId="reset-email-error">
          <Input id="reset-email" type="email" autoComplete="email" aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? "reset-email-error" : undefined} {...register("email")} />
        </AuthField>
        <Button className="h-10 w-full" type="submit" disabled={isSubmitting}>{isSubmitting ? "Sending…" : "Send reset link"}</Button>
      </form>
      {foot}
    </AuthPanel>
  );
}
