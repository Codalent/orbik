"use client";

import { useParams } from "next/navigation";

import { NeutralLoading } from "@/components/NeutralLoading";
import { AgentDashboard } from "@/components/agents/AgentDashboard";
import { PageFrame } from "@/components/workspaces/PageFrame";
import { extensionApi, useExtensionSlots } from "@/lib/extensions/slots";

/**
 * One agent, for one workspace: run it, and watch it work.
 *
 * An agent a deployment's extension added may bring its own page (`agentPages` in
 * `@orbik/web-extensions`); it is rendered here in place of the generic one. An entry without a
 * `Component`, or none at all, gets the generic page.
 *
 * Both identifiers are read on the client rather than awaited from server-side `params`, for the
 * same reason the workspace home does it: awaiting `params` opts the route into per-request server
 * rendering, and everything on this page is loaded from the API by the browser anyway.
 */
export default function AgentView() {
  const { workspaceId, agentSlug } = useParams();
  const { status, agent } = useExtensionSlots().agentPage(agentSlug);

  if (status === "loading") return <NeutralLoading />;
  if (agent?.Component) {
    const { Component } = agent;
    return <Component workspaceId={workspaceId} agentSlug={agentSlug} api={extensionApi} />;
  }
  return (
    <PageFrame label="Agent">
      <AgentDashboard workspaceId={workspaceId} agentSlug={agentSlug} />
    </PageFrame>
  );
}
