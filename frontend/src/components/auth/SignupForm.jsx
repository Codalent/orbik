"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NeutralLoading } from "@/components/NeutralLoading";
import { signup } from "@/lib/api/auth";
import { useEdition } from "@/lib/api/edition";
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

  async function submit(values) {
    try {
      await signup(values);
      router.replace("/workspaces/new");
    } catch (error) {
      setError("root", { message: error?.message ?? "Signup failed. Try again." });
    }
  }

  if (!edition) return <NeutralLoading inline />;
  if (edition.signup !== "open") return <SignupDisabledForm />;

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
        <Button className="h-10 w-full" type="submit" disabled={isSubmitting}>{isSubmitting ? "Creating account…" : "Create account"}</Button>
      </form>
      <AuthPanelFoot>Have an account? <Link href="/login" className={AUTH_LINK}>Sign in</Link></AuthPanelFoot>
    </AuthPanel>
  );
}
