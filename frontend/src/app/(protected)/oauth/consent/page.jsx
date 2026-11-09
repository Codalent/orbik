"use client";

import { Suspense } from "react";

import { AuthFrame } from "@/components/auth/AuthFrame";
import { ConsentForm } from "@/components/auth/ConsentForm";
import { NeutralLoading } from "@/components/NeutralLoading";
import { ProtectedRoute } from "@/lib/auth/ProtectedRoute";

/**
 * Where an AI client sends somebody to ask whether it may read a workspace.
 *
 * Outside the workspace shell on purpose. Somebody lands here from another application holding one
 * question, and a sidebar offering eight other places to go is an invitation to wander off with the
 * question unanswered. It is the same shape as the sign-in and new-workspace pages for that reason:
 * the logo, one panel (`AuthFrame`), one decision.
 *
 * `allowOnboarding` is passed because an account with no workspaces must still reach this page. The
 * ordinary bounce to `/workspaces/new` would drop the authorization request on the floor, whereas
 * the card can say there is nothing to share yet and point at the same place.
 *
 * `Suspense` is required around the form because it reads the request identifier from the query
 * string, which opts its subtree into client-side rendering.
 */
export default function OauthConsentPage() {
  return (
    <ProtectedRoute allowOnboarding>
      <AuthFrame>
        <Suspense fallback={<NeutralLoading inline label="Loading the authorization request" />}>
          <ConsentForm />
        </Suspense>
      </AuthFrame>
    </ProtectedRoute>
  );
}
