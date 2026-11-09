"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";

import { KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { NeutralLoading } from "@/components/NeutralLoading";
import { claimSetup } from "@/lib/api/auth";
import { useEdition } from "@/lib/api/edition";
import { setupSchema } from "@/lib/validation/auth";
import { AuthError, AuthField, AuthPanel } from "./AuthFrame";

/** What the API's refusals of a setup say, in the form's words. */
const REFUSALS = Object.freeze({
  SETUP_CODE_INVALID: "That is not this install's setup code. Copy it from the API's log and try again.",
  SETUP_COMPLETE: "This install already has an account. Sign in instead.",
  SETUP_IN_PROGRESS: "Someone is setting up this install right now. Wait a moment and reload.",
  RATE_LIMITED: "Too many tries. Wait a few minutes and try again.",
});

/**
 * The first page a new install shows: create its first account.
 *
 * It asks for the setup code the API printed to its log when it started, so that whoever opens a
 * fresh install on a public address first cannot claim it without access to the server. Once an
 * account exists this page sends everyone to sign in.
 */
export function SetupForm() {
  const router = useRouter();
  const { edition, error: editionError, mutate } = useEdition();
  // Set once this page has claimed the install, so the edition it re-reads afterwards — which no
  // longer needs setting up — does not send the new account to the sign-in page.
  const [claimed, setClaimed] = useState(false);
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(setupSchema),
    defaultValues: { code: "", email: "", password: "" },
    shouldFocusError: true,
  });

  useEffect(() => {
    if (edition && !edition.setupRequired && !claimed) router.replace("/login");
  }, [edition, claimed, router]);

  async function submit(values) {
    try {
      await claimSetup(values);
      setClaimed(true);
      router.replace("/workspaces/new");
      void mutate();
    } catch (error) {
      setError("root", { message: REFUSALS[error?.code] ?? error?.message ?? "Setup failed. Try again." });
      if (error?.code === "SETUP_COMPLETE") await mutate();
    }
  }

  if (editionError) {
    return <AuthError className="w-full max-w-md">The API could not be reached. Check that it is running, then reload.</AuthError>;
  }
  if (!edition || !edition.setupRequired) return <NeutralLoading inline />;

  return (
    <AuthPanel
      eyebrow={<Pill>New install</Pill>}
      title="Set up Orbik"
      description={
        <>
          Create the first account. The setup code is in the API&apos;s log — with Docker, run{" "}
          <code className="whitespace-nowrap rounded border border-orb-line bg-orb-space/70 px-1.5 py-0.5 font-mono text-xs text-orb-white">docker compose logs api</code>.
        </>
      }
    >
      <form onSubmit={handleSubmit(submit)} noValidate className="space-y-5">
        {errors.root && <AuthError>{errors.root.message}</AuthError>}
        <div className="rounded-lg border border-orb-line bg-orb-space/50 p-3.5">
          <AuthField
            htmlFor="code"
            label={<><KeyRound aria-hidden="true" className="size-3.5 text-orb-lime" />Setup code</>}
            error={errors.code?.message}
            errorId="code-error"
          >
            <Input id="code" autoComplete="one-time-code" spellCheck={false} placeholder="ABCD-EFGH-JKMN" className="font-mono tracking-[0.12em]" aria-invalid={Boolean(errors.code)} aria-describedby={errors.code ? "code-error" : undefined} {...register("code")} />
          </AuthField>
        </div>
        <AuthField htmlFor="email" label="Your email" error={errors.email?.message} errorId="email-error">
          <Input id="email" type="email" autoComplete="email" aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? "email-error" : undefined} {...register("email")} />
        </AuthField>
        <AuthField htmlFor="password" label="Password" error={errors.password?.message} errorId="password-error" hint="At least 8 characters." hintId="password-hint">
          <Input id="password" type="password" autoComplete="new-password" aria-invalid={Boolean(errors.password)} aria-describedby={errors.password ? "password-error" : "password-hint"} {...register("password")} />
        </AuthField>
        <Button className="h-10 w-full" type="submit" disabled={isSubmitting}>{isSubmitting ? "Creating account…" : "Create account"}</Button>
      </form>
    </AuthPanel>
  );
}
