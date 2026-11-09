"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";

import { NeutralLoading } from "@/components/NeutralLoading";
import { useAskPanel } from "@/lib/ask/askPanel";
import { workspaceHomePath } from "@/lib/workspaces/home";

/**
 * Ask used to be a page of its own here. It is now the panel that opens from the side of every
 * workspace page, so this address opens the panel — with the `?q=` question in its box, when a
 * link carries one — and moves to where the workspace opens for this person (Home while their setup is
 * unfinished, the Library after), where the panel stays open.
 *
 * Kept rather than removed because links to it exist: the AI calls log links a chat's calls here,
 * and somebody may have it bookmarked.
 */
export default function AskView() {
  return (
    <Suspense fallback={<NeutralLoading label="Opening Ask" />}>
      <OpenAsk />
    </Suspense>
  );
}

function OpenAsk() {
  const { workspaceId } = useParams();
  const question = useSearchParams().get("q");
  const router = useRouter();
  const panel = useAskPanel();

  useEffect(() => {
    if (!panel) return;
    if (question) panel.askAbout(question);
    else panel.setOpen(true);
    router.replace(workspaceHomePath(workspaceId));
    // Once, on arrival: the panel's own state takes over from here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <NeutralLoading label="Opening Ask" />;
}
