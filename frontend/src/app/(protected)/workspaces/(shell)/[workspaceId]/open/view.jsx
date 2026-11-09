"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";

import { NeutralLoading } from "@/components/NeutralLoading";
import { homePath } from "@/lib/api/home";
import { workspaceHomePagePath, workspaceLibraryPath } from "@/lib/workspaces/home";

/**
 * Moves a person arriving in a workspace to where it opens for them: Home while setup they can do
 * is unfinished, the Library once it is not.
 *
 * Reads the Home page's own answer, from the cache the page itself uses, so landing on Home shows
 * it at once rather than reading it twice. A read that fails goes to the Library — where every
 * workspace opened before Home existed — rather than leaving somebody on a loading screen.
 * `replace`, so Back does not return here and bounce them forward again.
 */
export default function OpenWorkspaceView() {
  const { workspaceId } = useParams();
  const router = useRouter();
  // Decided on a fresh answer, never on a copy cached from an earlier visit: the person may have
  // finished setup since, and a stale "home" would send them back to a checklist that is done.
  const { data, error, isValidating } = useSWR(workspaceId ? homePath(workspaceId) : null, { revalidateOnMount: true });
  const target = isValidating
    ? null
    : data
    ? data.landing === "home" ? workspaceHomePagePath(workspaceId) : workspaceLibraryPath(workspaceId)
    : error ? workspaceLibraryPath(workspaceId) : null;

  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

  return <NeutralLoading inline label="Opening workspace" />;
}
