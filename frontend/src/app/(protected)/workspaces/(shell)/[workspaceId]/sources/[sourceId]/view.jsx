"use client";

import { useParams } from "next/navigation";

import { SourcePage } from "@/components/sources/SourcePage";

/** One source's page. Its id — or `website` — is read from the route. */
export default function SourceView() {
  const { workspaceId, sourceId } = useParams();
  return <SourcePage workspaceId={workspaceId} sourceId={sourceId} />;
}
