"use client";

import { useParams } from "next/navigation";

import { AgentsOverview } from "@/components/agents-overview/AgentsOverview";

/**
 * The Agents overview. The workspace is read from the route on the client, as every page here
 * does: everything on it is loaded from the API by the browser anyway.
 */
export default function AgentsOverviewView() {
  const { workspaceId } = useParams();
  return <AgentsOverview workspaceId={workspaceId} />;
}
