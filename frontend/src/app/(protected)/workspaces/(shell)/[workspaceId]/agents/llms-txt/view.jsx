"use client";

import { useParams } from "next/navigation";

import { LlmsTxtDashboard } from "@/components/llms-txt/LlmsTxtDashboard";
import { PageFrame } from "@/components/workspaces/PageFrame";

/**
 * The llms.txt agent's page: one file to copy, which the generic dashboard — whose answer to
 * "what did it produce" is a block of JSON — does not serve.
 */
export default function LlmsTxtView() {
  const { workspaceId } = useParams();

  return (
    <PageFrame label="llms.txt">
      <LlmsTxtDashboard workspaceId={workspaceId} />
    </PageFrame>
  );
}
