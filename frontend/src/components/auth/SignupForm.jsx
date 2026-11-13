"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NeutralLoading } from "@/components/NeutralLoading";
import { signup } from "@/lib/api/auth";
import { useEdition } from "@/lib/api/edition";
import { useExtensionSlots } from "@/lib/extensions/slots";
import { signupSchema } from "@/lib/validation/auth";
import { AUTH_LINK, AuthError, AuthField, AuthPanel, AuthPanelFoot } from "./AuthFrame";
import { SignupDisabledForm } from "./SignupDisabledForm";

/**
 * Creating an account, on an install whose signup is open (`ORBIK_SIGNUP=open`). Closed — the
 * default — it says how people join instead: by an invite from someone already here.
 */
export function SignupForm() {
  const router = useRouter();
  const { edition } = useEdition();
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(signupSchema),
    defaultValues: { email: "", password: "" },
    shouldFocusError: true,
  });
  // A deployment's own fields (a captcha, a consent), sent along by id for its signup check.
  const { signupFields } = useExtensionSlots();
  const [fields, setFields] = useState({});
  const [attempt, setAttempt] = useState(0);
  // Where signup waits for the address to be confirmed: the address the link was sent to.
  const [sentTo, setSentTo] = useState(null);
  const fieldIds = signupFields.map((field) => field.id).join(",");
  // One stable setter per field, so a field that reports from an effect does not loop.
  const setters = useMemo(() => Object.fromEntries(fieldIds.split(",").filter(Boolean).map((id) => [id, (value) => {
    setFields((current) => {
      const next = { ...current };
      if (typeof value === "string") next[id] = value;
      else delete next[id];
      return next;
    });
  }])), [fieldIds]);

  async function submit(values) {
    try {
      const result = await signup(Object.keys(fields).length ? { ...values, extensions: fields } : values);
      if (result?.verificationSent) {
        setSentTo(result.email);
        return;
      }
      router.replace("/workspaces/new");
    } catch (error) {
      setAttempt((count) => count + 1);
      setError("root", { message: error?.message ?? "Signup failed. Try again." });
    }
  }

  if (!edition) return <NeutralLoading inline />;
  if (edition.signup !== "open") return <SignupDisabledForm />;

  if (sentTo) {
    return (
      <AuthPanel
        title="Check your email"
        description={<>We sent a link to <span className="font-medium text-orb-white">{sentTo}</span>. Open it within a day to confirm the address and finish making your account.</>}
      >
        <AuthPanelFoot>
          Wrong address, or no email? <button type="button" className={AUTH_LINK} onClick={() => setSentTo(null)}>Sign up again</button>
        </AuthPanelFoot>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel title="Create an account" description="Then add your website as your first workspace.">
      <form onSubmit={handleSubmit(submit)} noValidate className="space-y-5">
        {errors.root && <AuthError>{errors.root.message}</AuthError>}
        <AuthField htmlFor="signup-email" label="Email" error={errors.email?.message} errorId="signup-email-error">
          <Input id="signup-email" type="email" autoComplete="email" aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? "signup-email-error" : undefined} {...register("email")} />
        </AuthField>
        <AuthField htmlFor="signup-password" label="Password" error={errors.password?.message} errorId="signup-password-error" hint="At least 8 characters." hintId="signup-password-hint">
          <Input id="signup-password" type="password" autoComplete="new-password" aria-invalid={Boolean(errors.password)} aria-describedby={errors.password ? "signup-password-error" : "signup-password-hint"} {...register("password")} />
        </AuthField>
        {signupFields.map(({ id, Component }) => (
          <Component key={id} onChange={setters[id]} attempt={attempt} />
        ))}
        <Button className="h-10 w-full" type="submit" disabled={isSubmitting}>{isSubmitting ? "Creating account…" : "Create account"}</Button>
      </form>
      <AuthPanelFoot>Have an account? <Link href="/login" className={AUTH_LINK}>Sign in</Link></AuthPanelFoot>
    </AuthPanel>
  );
}
