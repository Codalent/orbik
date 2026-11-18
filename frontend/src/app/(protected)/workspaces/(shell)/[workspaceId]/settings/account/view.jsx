"use client";

import { UserRound } from "lucide-react";

import { ChangePasswordForm } from "@/components/account/ChangePasswordPage";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { useAuth } from "@/lib/auth/AuthProvider";

/**
 * The Account section of Settings, at `/settings/account`: the signed-in person's own account
 * rather than the workspace — for now, changing its password, which used to be an item in the
 * account menu. The same in every workspace.
 */
export default function AccountSettingsView() {
  const email = useAuth().user?.email;
  return (
    <SettingsSection
      id="account"
      icon={UserRound}
      title="Account"
      description={email
        ? <>Signed in as <span className="text-orb-white">{email}</span>. Changing your password keeps you signed in here and signs out every other browser and device.</>
        : "Your own account, in every workspace."}
    >
      <ChangePasswordForm />
    </SettingsSection>
  );
}
