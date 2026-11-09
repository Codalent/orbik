"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { NeutralLoading } from "@/components/NeutralLoading";
import { workspaceHomePath } from "@/lib/workspaces/home";
import { returnPathFromCurrentUrl } from "./returnPath";
import { useAuth } from "./AuthProvider";

/**
 * The other side of `ProtectedRoute`, for the sign-in and signup pages: somebody already signed in
 * has no use for either form and is sent on, where signing in would have sent them — the page in
 * `next` if there is one (the OAuth consent screen, say), else their workspace, else the form that
 * makes one. Until the session is known nothing is shown, so a signed-in person never sees the form
 * flash first.
 */
export function GuestOnlyRoute({ children }) {
  const auth = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (auth.status !== "authenticated") return;
    const destination =
      returnPathFromCurrentUrl() ??
      (auth.destination === "workspace-home" ? workspaceHomePath(auth.selectedWorkspaceId) : "/workspaces/new");
    router.replace(destination);
  }, [auth.status, auth.destination, auth.selectedWorkspaceId, router]);
  if (auth.status !== "anonymous") return <NeutralLoading inline />;
  return children;
}
