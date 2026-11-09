"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";

import { NeutralLoading } from "@/components/NeutralLoading";
import { WORKSPACES_PATH } from "@/lib/api/workspaces";
import { useAuth } from "@/lib/auth/AuthProvider";
import { workspaceHomePath } from "@/lib/workspaces/home";

/**
 * Renders a workspace's pages only when the address names a workspace this account has.
 *
 * An address can carry anything: a mistyped identifier, a workspace that was deleted, one that
 * belongs to somebody else. Each page used to discover that separately, as a failed request or an
 * exception from the identifier check, and answer with whatever its own error state happened to
 * be. Deciding it once, above every page, gives all of them the same plain answer.
 *
 * The list is the one the shell already loaded, read from the same cache, so this asks for
 * nothing. While it is being re-read — just after a workspace was created, say — an identifier
 * missing from the copy in hand is not yet known to be wrong, so that shows as loading.
 *
 * A workspace that was in the list and has dropped out of it — the person was removed from it, or
 * left it in another tab — is not "not found" but gone: the page moves to the workspace the API
 * now selects for them, or to making one when they have none left. The list is re-read whenever a
 * request is refused for want of access, which is how the drop is noticed.
 */
export function WorkspaceGate({ children }) {
  const { workspaceId } = useParams();
  const router = useRouter();
  const { refresh } = useAuth();
  const { data, isValidating } = useSWR(WORKSPACES_PATH);
  const [seen, setSeen] = useState(() => []);

  const known = data?.items?.some((workspace) => workspace.id === workspaceId);
  // Remembered during render, as the Library does with what it has followed: one entry per
  // workspace opened in this tab.
  if (known && !seen.includes(workspaceId)) setSeen([...seen, workspaceId]);
  const lost = Boolean(data) && !known && !isValidating && seen.includes(workspaceId);
  const fallback = data?.selectedWorkspaceId && data.selectedWorkspaceId !== workspaceId ? workspaceHomePath(data.selectedWorkspaceId) : null;

  useEffect(() => {
    if (!lost) return;
    if (fallback) {
      router.replace(fallback);
      return;
    }
    // No workspace left: the session's destination becomes onboarding once it is read again.
    (async () => {
      await refresh();
      router.replace("/workspaces/new");
    })();
  }, [lost, fallback, router, refresh]);

  if (known) return children;
  if (!data || isValidating || lost) return <NeutralLoading inline label={lost ? "This workspace is no longer available to you" : "Loading workspace"} />;

  return (
    <main aria-label="Workspace not found" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="font-display text-2xl font-bold tracking-[-0.02em] text-orb-white">Workspace not found</h1>
      <p className="max-w-sm text-sm text-orb-gray">
        This address does not belong to one of your workspaces. Choose one from the sidebar.
      </p>
      {data.selectedWorkspaceId && (
        <Link href={workspaceHomePath(data.selectedWorkspaceId)} className="text-sm text-orb-white underline underline-offset-4">
          Go to your workspace
        </Link>
      )}
    </main>
  );
}
