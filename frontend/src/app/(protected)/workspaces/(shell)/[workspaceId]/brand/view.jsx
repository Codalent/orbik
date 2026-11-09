"use client";

import { useParams } from "next/navigation";

import { Suspense } from "react";

import { BrandDashboard } from "@/components/brand/BrandDashboard";
import { NeutralLoading } from "@/components/NeutralLoading";
import { PageFrame } from "@/components/workspaces/PageFrame";

/**
 * The Brand page: a workspace's design system, to read, correct and copy out.
 *
 * It has its own route rather than living only under the agent that derives it, for the reason
 * the Library has: what is here outlives the run that wrote it, a person corrects it, and somebody
 * looking for their brand's colours should not have to know which agent found them. The agent's
 * own controls are in the head of the page, and the agent route renders this same view.
 *
 * The workspace identifier is read on the client rather than awaited from server-side `params`,
 * as the other workspace pages do: everything here is loaded from the API by the browser anyway.
 */
export default function BrandView() {
  const { workspaceId } = useParams();

  return (
    <PageFrame label="Brand" className="max-w-6xl">
      <Suspense fallback={<NeutralLoading label="Loading the brand" />}>
        <BrandDashboard workspaceId={workspaceId} />
      </Suspense>
    </PageFrame>
  );
}
