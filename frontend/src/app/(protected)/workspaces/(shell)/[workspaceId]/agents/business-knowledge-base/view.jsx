"use client";

import { useParams } from "next/navigation";

import { KnowledgeBaseAgentDashboard } from "@/components/agents/KnowledgeBaseAgentDashboard";
import { PageFrame } from "@/components/workspaces/PageFrame";

/**
 * The Knowledge base agent's page. The workspace identifier is read on the client, as the other
 * agent pages do: everything here is loaded from the API by the browser anyway.
 */
export default function KnowledgeBaseAgentView() {
  const { workspaceId } = useParams();

  return (
    <PageFrame label="Knowledge base agent">
      <KnowledgeBaseAgentDashboard workspaceId={workspaceId} />
    </PageFrame>
  );
}
