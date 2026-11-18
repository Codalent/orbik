"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { NeutralLoading } from "@/components/NeutralLoading";
import { useAuth } from "@/lib/auth/AuthProvider";

/**
 * A page that became a section of Settings — `/admin`, `/account/password` — kept at its old
 * address for links already sent (an access request's email to the admins names `/admin`). With a
 * workspace selected it goes to that section of the workspace's Settings; an account with no
 * workspace yet has no Settings, and gets the page of its own, `children`.
 *
 * @param {object} props
 * @param {string} props.section the Settings section's route under `/settings/`
 */
export function ToSettings({ section, children }) {
  const { selectedWorkspaceId } = useAuth();
  const router = useRouter();
  const target = selectedWorkspaceId ? `/workspaces/${selectedWorkspaceId}/settings/${section}` : null;
  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);
  return target ? <NeutralLoading /> : children;
}
