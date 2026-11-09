"use client";

import { useParams } from "next/navigation";

import { Suspense } from "react";

import { LibraryWorkspace } from "@/components/library/LibraryWorkspace";
import { NeutralLoading } from "@/components/NeutralLoading";

/**
 * The Library: a workspace's knowledge, as folders and files.
 *
 * It has its own route rather than living only under the agent that writes it, because it is no
 * longer only that agent's output. People create and edit files here, other agents will read it,
 * and a person looking for what their company knows should not have to know which agent produced
 * it. The agent's own switch is still on the page — the agent route renders the same workspace, so
 * a link from the agent list lands in the same place.
 *
 * It fills the panel rather than sitting in the usual column of cards: an explorer, tabs and an
 * inspector, each scrolling separately, so it renders its own `main` instead of `PageFrame`. It is
 * keyed by the workspace, so switching workspace starts from that workspace's own tabs.
 *
 * The workspace identifier is read on the client rather than awaited from server-side `params`,
 * for the same reason the workspace home does it: awaiting `params` opts the route into
 * per-request server rendering, and everything here is loaded from the API by the browser anyway.
 */
export default function LibraryView() {
  const { workspaceId } = useParams();

  return (
    <Suspense fallback={<NeutralLoading label="Loading the Library" />}>
      <LibraryWorkspace key={workspaceId} workspaceId={workspaceId} />
    </Suspense>
  );
}
