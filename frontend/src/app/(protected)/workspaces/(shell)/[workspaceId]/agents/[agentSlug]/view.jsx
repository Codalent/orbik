"use client";

import { useParams } from "next/navigation";

import { AgentDashboard } from "@/components/agents/AgentDashboard";
import { PageFrame } from "@/components/workspaces/PageFrame";

/**
 * One agent, for one workspace: run it, and watch it work.
 *
 * Both identifiers are read on the client rather than awaited from server-side `params`, for the
 * same reason the workspace home does it: awaiting `params` opts the route into per-request server
 * rendering, and everything on this page is loaded from the API by the browser anyway.
 */
export default function AgentView() {
  const { workspaceId, agentSlug } = useParams();

  return (
    <PageFrame label="Agent">
      <AgentDashboard workspaceId={workspaceId} agentSlug={agentSlug} />
    </PageFrame>
  );
}
