"use client";

import { useParams } from "next/navigation";
import { Bot } from "lucide-react";
import useSWR from "swr";

import { AiQuestions } from "@/components/settings/AiQuestions";
import { ConnectYourAi } from "@/components/settings/ConnectYourAi";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { WORKSPACES_PATH } from "@/lib/api/workspaces";
import { can, roleOf } from "@/lib/workspaces/roles";

/**
 * The Orbik MCP section of Settings, at `/settings/ai`: what may read this workspace. It is per
 * workspace, so it reads the workspace from the route.
 */
export default function AiSettingsView() {
  const { workspaceId } = useParams();
  const workspace = useSWR(WORKSPACES_PATH).data?.items?.find((item) => item.id === workspaceId) ?? null;

  return (
    <SettingsSection id="ai" icon={Bot} title="Orbik MCP" description="What may read this workspace over MCP: Claude, ChatGPT, your editor, or an agent you built.">
      <div className="space-y-4">
        <ConnectYourAi workspaceId={workspaceId} />
        {/* What every member's AI asked here, so only for the people who manage the workspace. */}
        {workspace && can(roleOf(workspace), "admin") && <AiQuestions workspaceId={workspaceId} />}
      </div>
    </SettingsSection>
  );
}
