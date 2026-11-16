"use client";

import { useState } from "react";
import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Check, KeyRound } from "lucide-react";

import { AccountFrame } from "@/components/account/AccountFrame";
import { AuthError, AuthField } from "@/components/auth/AuthFrame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { changePassword } from "@/lib/api/auth";
import { useAuth } from "@/lib/auth/AuthProvider";
import { changePasswordSchema } from "@/lib/validation/auth";

/** What the API's refusals say on this page. */
function describeFailure(error) {
  switch (error?.code) {
    case "RATE_LIMITED": return "Too many tries. Wait a few minutes and try again.";
    case "NO_PASSWORD": return error.message;
    default: return error?.message || "The password could not be changed. Try again.";
  }
}

/**
 * Changing the signed-in account's password: the current one, then the new one twice. The API
 * checks the current password, sets the new one and signs the account out everywhere else; this
 * browser stays signed in. An account made by signing in with Google has no password to change,
 * and the page says how it gets one.
 */
export function ChangePasswordPage() {
  const auth = useAuth();
  const [done, setDone] = useState(null);
  const { register, handleSubmit, setError, reset, formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirm: "" },
    shouldFocusError: true,
  });

  async function submit({ currentPassword, newPassword }) {
    try {
      const result = await changePassword({ currentPassword, newPassword });
      reset();
      setDone({ others: result?.otherSessionsSignedOut ?? 0 });
    } catch (error) {
      if (error?.code === "CURRENT_PASSWORD_INCORRECT") {
        setError("currentPassword", { message: "That is not your current password." }, { shouldFocus: true });
        return;
      }
      const field = error?.code === "VALIDATION_FAILED" ? error.fields?.find((entry) => ["currentPassword", "newPassword"].includes(entry.field)) : null;
      if (field) setError(field.field, { message: field.message }, { shouldFocus: true });
      else setError("root", { message: describeFailure(error) });
    }
  }

  const header = (
    <PageHeader
      icon={KeyRound}
      title="Change password"
      description={auth.user?.email ? <>For <span className="text-orb-white">{auth.user.email}</span>. You stay signed in here; every other browser and device is signed out.</> : null}
    />
  );

  if (auth.user && auth.user.hasPassword === false) {
    return (
      <AccountFrame>
        {header}
        <EmptyState icon={KeyRound}>
          This account signs in with Google and has no password. To set one, sign out and choose Forgot password? on the sign-in page, or ask
          this Orbik&apos;s admin for a reset link.
        </EmptyState>
      </AccountFrame>
    );
  }

  return (
    <AccountFrame>
      {header}
      <Panel className="max-w-md">
        {done ? (
          <div role="status" className="space-y-4">
            <p className="flex gap-2.5 text-sm text-orb-white">
              <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-orb-lime" />
              <span>
                Your password was changed.{" "}
                {done.others > 0
                  ? `${done.others.toLocaleString()} other ${done.others === 1 ? "session was" : "sessions were"} signed out.`
                  : "No other session was signed in."}
              </span>
            </p>
            <Link href="/" className="inline-flex text-sm text-orb-white underline decoration-orb-muted/70 underline-offset-4 hover:decoration-orb-white">
              Back to Orbik
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit(submit)} noValidate className="space-y-5">
            {errors.root && <AuthError>{errors.root.message}</AuthError>}
            {/* The address, for a password manager to file the new password under. */}
            <input type="email" name="email" autoComplete="username" value={auth.user?.email ?? ""} readOnly hidden />
            <AuthField htmlFor="current-password" label="Current password" error={errors.currentPassword?.message} errorId="current-password-error">
              <Input id="current-password" type="password" autoComplete="current-password" autoFocus aria-invalid={Boolean(errors.currentPassword)} aria-describedby={errors.currentPassword ? "current-password-error" : undefined} {...register("currentPassword")} />
            </AuthField>
            <AuthField htmlFor="new-password" label="New password" error={errors.newPassword?.message} errorId="new-password-error" hint="At least 8 characters." hintId="new-password-hint">
              <Input id="new-password" type="password" autoComplete="new-password" aria-invalid={Boolean(errors.newPassword)} aria-describedby={errors.newPassword ? "new-password-error" : "new-password-hint"} {...register("newPassword")} />
            </AuthField>
            <AuthField htmlFor="confirm-password" label="Confirm new password" error={errors.confirm?.message} errorId="confirm-password-error">
              <Input id="confirm-password" type="password" autoComplete="new-password" aria-invalid={Boolean(errors.confirm)} aria-describedby={errors.confirm ? "confirm-password-error" : undefined} {...register("confirm")} />
            </AuthField>
            <Button type="submit" disabled={isSubmitting}>{isSubmitting ? "Changing…" : "Change password"}</Button>
          </form>
        )}
      </Panel>
    </AccountFrame>
  );
}
