"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEdition } from "@/lib/api/edition";
import { useAuth } from "@/lib/auth/AuthProvider";
import { returnPathFromCurrentUrl } from "@/lib/auth/returnPath";
import { loginSchema } from "@/lib/validation/auth";
import { workspaceHomePath } from "@/lib/workspaces/home";
import { AUTH_LINK, AuthError, AuthField, AuthPanel, AuthPanelFoot } from "./AuthFrame";

/** Accessible credential form with exact password handling and one pending submission. */
export function LoginForm() {
  const { authenticate } = useAuth();
  const router = useRouter();
  const { edition } = useEdition();
  // An install with no account yet has nobody to sign in: it is claimed on the setup page.
  useEffect(() => {
    if (edition?.setupRequired) router.replace("/setup");
  }, [edition?.setupRequired, router]);
  const signupOpen = edition?.signup === "open";
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
    shouldFocusError: true,
  });

  /**
   * Authenticates the canonical form values and maps only trusted destination enums to routes.
   *
   * A `next` in the URL wins, because somebody who was sent to a page and asked to sign in on the
   * way meant to be on that page — most of all on the OAuth consent screen, which an AI client
   * sends them to and which would otherwise be abandoned here. It is read at submit time rather
   * than during render so that this page needs no Suspense boundary for a value only the successful
   * path uses, and `returnPathFromCurrentUrl` refuses anything that is not a path inside this app.
   */
  async function submit(values) {
    try {
      const session = await authenticate(values);
      const destination =
        returnPathFromCurrentUrl() ??
        (session.destination === "workspace-home" ? workspaceHomePath(session.selectedWorkspaceId) : "/workspaces/new");
      router.replace(destination);
    } catch {
      setError("root", { message: "Sign in failed. Check your credentials and try again." });
    }
  }

  return (
    <AuthPanel
      title="Sign in"
      description={signupOpen ? "Use your Orbik account." : "Use the Orbik account you were given or invited to."}
    >
      <form onSubmit={handleSubmit(submit)} noValidate className="space-y-5">
        {errors.root && <AuthError>{errors.root.message}</AuthError>}
        <AuthField htmlFor="email" label="Email" error={errors.email?.message} errorId="email-error">
          <Input id="email" type="email" autoComplete="email" aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? "email-error" : undefined} {...register("email")} />
        </AuthField>
        <AuthField
          htmlFor="password"
          label="Password"
          error={errors.password?.message}
          errorId="password-error"
          aside={<Link href="/forgot-password" className="rounded-sm text-xs text-orb-gray underline-offset-4 transition-colors hover:text-orb-white hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70">Forgot password?</Link>}
        >
          <Input id="password" type="password" autoComplete="current-password" aria-invalid={Boolean(errors.password)} aria-describedby={errors.password ? "password-error" : undefined} {...register("password")} />
        </AuthField>
        <Button className="h-10 w-full" type="submit" disabled={isSubmitting}>{isSubmitting ? "Signing in…" : "Sign in"}</Button>
      </form>
      <AuthPanelFoot>
        Need an account?{" "}
        {signupOpen
          ? <Link href="/signup" className={AUTH_LINK}>Create one</Link>
          : <Link href="/signup" className={AUTH_LINK}>Request access</Link>}
      </AuthPanelFoot>
    </AuthPanel>
  );
}
