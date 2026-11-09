"use client";

import { useParams } from "next/navigation";
import { Users } from "lucide-react";

import { SettingsSection } from "@/components/settings/SettingsSection";
import { WorkspaceMembers } from "@/components/settings/WorkspaceMembers";

/** The People section of Settings, at `/settings/people`: who is in the workspace, and their roles. */
export default function PeopleSettingsView() {
  const { workspaceId } = useParams();
  return (
    <SettingsSection id="people" icon={Users} title="People" description="Who is in this workspace, and what each of them may do.">
      <WorkspaceMembers workspaceId={workspaceId} />
    </SettingsSection>
  );
}
