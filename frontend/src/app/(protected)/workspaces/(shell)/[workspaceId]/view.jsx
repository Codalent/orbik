"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

import { NeutralLoading } from "@/components/NeutralLoading";
import { workspaceHomePagePath } from "@/lib/workspaces/home";

/**
 * Sends the workspace's bare address to its Home page.
 *
 * Done on the client, as the Opening view does, because reading `params` on the server would make
 * the route render per request. `replace`, so Back does not land here and bounce forward again.
 */
export default function WorkspaceRootView() {
  const { workspaceId } = useParams();
  const router = useRouter();

  useEffect(() => {
    if (workspaceId) router.replace(workspaceHomePagePath(workspaceId));
  }, [workspaceId, router]);

  return <NeutralLoading inline label="Opening workspace" />;
}
