"use client";

import { AuthFrame } from "@/components/auth/AuthFrame";
import { ProtectedRoute } from "@/lib/auth/ProtectedRoute";
import { WorkspaceForm, WorkspaceFormAccount } from "@/components/workspaces/WorkspaceForm";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useRouter } from "next/navigation";
import { workspaceHomePath } from "@/lib/workspaces/home";

/**
 * Onboarding route that frames the two-step workspace form for a new or additional site, in the
 * same logo-and-one-panel frame as sign-in, since a new account has no workspace shell yet. Under
 * the panel, who is signed in and a way to sign out, for the same reason.
 */
export default function NewWorkspacePage() {
  const auth = useAuth();
  const router = useRouter();
  const canCancel = Boolean(auth.selectedWorkspaceId);
  return (
    <ProtectedRoute allowOnboarding>
      <AuthFrame footer={<WorkspaceFormAccount />}>
        <WorkspaceForm canCancel={canCancel} onCancel={() => router.replace(workspaceHomePath(auth.selectedWorkspaceId))} />
      </AuthFrame>
    </ProtectedRoute>
  );
}
