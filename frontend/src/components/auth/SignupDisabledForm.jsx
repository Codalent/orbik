"use client";

import { useState } from "react";
import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { MailCheck, MailPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { describeAccessError, requestAccess } from "@/lib/api/access";
import { emailOnlySchema } from "@/lib/validation/auth";
import { AUTH_LINK, AuthError, AuthField, AuthPanel, AuthPanelFoot } from "./AuthFrame";

/**
 * Signup on an install where it is closed: the person leaves their address and asks for access.
 * The request goes to the install's admins, on the Admin page; when one approves it, the person
 * gets a one-time link that makes their account. Someone invited to a workspace needs none of
 * this: their invite link makes the account.
 */
export function SignupDisabledForm() {
  const [sentTo, setSentTo] = useState(null);
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(emailOnlySchema),
    defaultValues: { email: "" },
    shouldFocusError: true,
  });

  async function submit(values) {
    try {
      await requestAccess(values);
      setSentTo(values.email.trim());
    } catch (error) {
      setError("root", { message: describeAccessError(error, "Your request could not be sent. Try again.") });
    }
  }

  if (sentTo) {
    return (
      <AuthPanel title="Request sent" description="Orbik is invite-only for now.">
        <div role="status" className="flex gap-2.5 rounded-lg border border-orb-cyan/40 bg-orb-cyan/10 px-3.5 py-3 text-sm text-orb-white">
          <MailCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-orb-cyan" />
          <p className="min-w-0 [overflow-wrap:anywhere]">
            We&apos;ve got your request for <span className="font-medium">{sentTo}</span>. When it&apos;s approved you&apos;ll get a link to create your account.
          </p>
        </div>
        <AuthPanelFoot><Link href="/login" className={AUTH_LINK}>Back to sign in</Link></AuthPanelFoot>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel title="Request access" description="Orbik is invite-only for now. Leave your email and we'll let you know when you're in.">
      <form onSubmit={handleSubmit(submit)} noValidate className="space-y-5">
        {errors.root && <AuthError>{errors.root.message}</AuthError>}
        <AuthField
          htmlFor="access-email"
          label="Email"
          error={errors.email?.message}
          errorId="access-email-error"
          hint="Invited to a workspace already? Open the link in your invite instead."
          hintId="access-email-hint"
        >
          <Input
            id="access-email"
            type="email"
            autoComplete="email"
            aria-invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? "access-email-error" : "access-email-hint"}
            {...register("email")}
          />
        </AuthField>
        <Button className="h-10 w-full" type="submit" disabled={isSubmitting}>
          <MailPlus aria-hidden="true" />
          {isSubmitting ? "Sending…" : "Request access"}
        </Button>
      </form>
      <AuthPanelFoot>Have an account? <Link href="/login" className={AUTH_LINK}>Sign in</Link></AuthPanelFoot>
    </AuthPanel>
  );
}
