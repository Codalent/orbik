"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { NeutralLoading } from "@/components/NeutralLoading";
import { ProtectedRoute } from "@/lib/auth/ProtectedRoute";
import { useAuth } from "@/lib/auth/AuthProvider";
import { workspaceHomePath } from "@/lib/workspaces/home";

/**
 * The app's bare address. It shows nothing of its own: someone signed in goes to their workspace,
 * someone who has none yet to the form that makes one (ProtectedRoute does that), and anyone else
 * to sign in.
 */
export default function AppEntry() {
  return <ProtectedRoute><OpenWorkspace /></ProtectedRoute>;
}

function OpenWorkspace() {
  const { selectedWorkspaceId } = useAuth();
  const router = useRouter();
  useEffect(() => {
    router.replace(selectedWorkspaceId ? workspaceHomePath(selectedWorkspaceId) : "/workspaces/new");
  }, [selectedWorkspaceId, router]);
  return <NeutralLoading />;
}
