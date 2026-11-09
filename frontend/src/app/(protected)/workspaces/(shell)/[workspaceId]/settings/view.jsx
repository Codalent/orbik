"use client";

import { useParams } from "next/navigation";
import { Building2 } from "lucide-react";
import useSWR from "swr";

import { SettingsSection } from "@/components/settings/SettingsSection";
import { FactsSkeleton } from "@/components/settings/SettingsSkeletons";
import { DeleteWorkspace, WorkspaceDetails } from "@/components/settings/WorkspaceDetails";
import { WORKSPACES_PATH } from "@/lib/api/workspaces";
import { roleOf } from "@/lib/workspaces/roles";

/**
 * The first Settings section, at `/settings`: what the workspace is, and — for admins and the
 * owner — renaming it and changing its website. Deleting it is below, for the owner only.
 *
 * The identifier is read on the client rather than awaited from server-side `params`, for the same
 * reason the Library does it: awaiting `params` opts the route into per-request server rendering,
 * and everything here is loaded from the API by the browser anyway.
 */
export default function WorkspaceSettingsView() {
  const { workspaceId } = useParams();
  const workspace = useSWR(WORKSPACES_PATH).data?.items?.find((item) => item.id === workspaceId) ?? null;

  return (
    <>
      <SettingsSection id="workspace" icon={Building2} title="Workspace" description="What this workspace is, and the details your AI and your team may ask for.">
        {workspace ? <WorkspaceDetails workspace={workspace} /> : <FactsSkeleton />}
      </SettingsSection>

      {/* Below everything a person comes here to change, and only for the owner. */}
      {workspace && roleOf(workspace) === "owner" && <DeleteWorkspace workspace={workspace} />}
    </>
  );
}
