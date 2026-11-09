"use client";

import { useParams } from "next/navigation";

import { HomeDashboard } from "@/components/home/HomeDashboard";

/**
 * Home: where a workspace's setup stands, for the person looking, and then the workspace at a
 * glance. The workspace is read from the route on the client, as every page here does: everything
 * on it is loaded from the API by the browser anyway.
 */
export default function HomeView() {
  const { workspaceId } = useParams();
  return <HomeDashboard workspaceId={workspaceId} />;
}
