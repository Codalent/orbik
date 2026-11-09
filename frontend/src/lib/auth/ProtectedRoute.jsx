"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { NeutralLoading } from "@/components/NeutralLoading";
import { signInUrlForCurrentPage } from "./returnPath";
import { useAuth } from "./AuthProvider";

/**
 * Prevents protected children from rendering until server-backed authentication is known.
 *
 * Signing somebody out of a page now carries where they were, so that signing back in returns them
 * to it. That matters for one page in particular: the OAuth consent screen is reached from an AI
 * client rather than from inside the app, and landing on the workspace home instead would abandon
 * the authorization they were sent here to approve.
 */
export function ProtectedRoute({ children, allowOnboarding = false }) {
  const auth = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (auth.status === "anonymous") router.replace(signInUrlForCurrentPage());
    if (auth.status === "authenticated" && auth.destination === "workspace-onboarding" && !allowOnboarding) {
      router.replace("/workspaces/new");
    }
  }, [auth.status, auth.destination, allowOnboarding, router]);
  if (auth.status !== "authenticated") return <NeutralLoading />;
  if (auth.destination === "workspace-onboarding" && !allowOnboarding) return <NeutralLoading />;
  return children;
}
