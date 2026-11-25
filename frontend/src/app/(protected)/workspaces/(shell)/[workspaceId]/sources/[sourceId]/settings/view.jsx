"use client";

import { useParams } from "next/navigation";

import { SourceSettingsTab } from "@/components/sources/SourceSettingsTab";

/** One source's Settings tab. Its id — or `website` — is read from the route. */
export default function SourceSettingsView() {
  const { workspaceId, sourceId } = useParams();
  return <SourceSettingsTab workspaceId={workspaceId} sourceId={sourceId} />;
}
