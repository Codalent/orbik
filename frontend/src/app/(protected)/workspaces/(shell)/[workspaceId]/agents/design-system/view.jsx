"use client";

import { useParams } from "next/navigation";

import { DesignSystemAgentDashboard } from "@/components/design-system/DesignSystemAgentDashboard";
import { PageFrame } from "@/components/workspaces/PageFrame";

/**
 * The Design system agent's page. The workspace identifier is read on the client, as the other
 * agent pages do: everything here is loaded from the API by the browser anyway.
 */
export default function DesignSystemAgentView() {
  const { workspaceId } = useParams();

  return (
    <PageFrame label="Design system agent">
      <DesignSystemAgentDashboard workspaceId={workspaceId} />
    </PageFrame>
  );
}
