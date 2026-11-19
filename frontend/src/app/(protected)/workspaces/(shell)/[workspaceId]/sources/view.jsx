"use client";

import { useParams } from "next/navigation";

import { SourcesOverview } from "@/components/sources/SourcesOverview";

/** All sources. The workspace is read from the route on the client, as every page here does. */
export default function SourcesView() {
  const { workspaceId } = useParams();
  return <SourcesOverview workspaceId={workspaceId} />;
}
