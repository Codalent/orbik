"use client";

import { ShieldCheck } from "lucide-react";
import useSWR from "swr";

import { ADMIN_DESCRIPTION, AdminTools, NotAnAdmin } from "@/components/admin/AdminPage";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { Pill } from "@/components/ui/pill";
import { accessRequestsPath } from "@/lib/api/access";
import { useAuth } from "@/lib/auth/AuthProvider";

/**
 * The Admin section of Settings, at `/settings/admin`, listed only for the install's admins: access
 * requests from the closed signup page, and password reset links. It is about the install rather
 * than this workspace, so it is the same in every workspace; it used to be a page of its own,
 * opened from the account menu, and `/admin` still leads here.
 */
export default function AdminSettingsView() {
  const isAdmin = Boolean(useAuth().user?.isAdmin);
  // The same read the tools make for their first filter, so the cache answers it once.
  const pending = useSWR(isAdmin ? accessRequestsPath({ status: "pending" }) : null).data?.pending ?? 0;
  return (
    <SettingsSection
      id="admin"
      icon={ShieldCheck}
      title="Admin"
      description={ADMIN_DESCRIPTION}
      aside={pending ? <Pill tone="orange" dot>{pending} waiting</Pill> : null}
    >
      {isAdmin ? <AdminTools /> : <NotAnAdmin />}
    </SettingsSection>
  );
}
