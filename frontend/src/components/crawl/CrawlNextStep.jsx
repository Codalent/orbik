"use client";

import Link from "next/link";
import useSWR from "swr";
import { ArrowRight, FolderTree } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { homePath } from "@/lib/api/home";
import { STEP_STATE } from "@/lib/home/home";
import { cn } from "@/lib/utils";

/**
 * What to do once the first crawl is in: the setup step after it, said on the page the person is
 * already on rather than only on Home.
 *
 * Whether that step is done is Home's answer, read from the same cached read Home draws its
 * checklist from (`GET /v1/workspaces/:id/home`), so the two pages never disagree about it. It is
 * only read, never acted on here: choosing the folders happens in the Library, where this links.
 * Once the folders are chosen and the Library is written there is nothing left to say, and the
 * callout is gone.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 */
export function CrawlNextStep({ workspaceId }) {
  const { data: home } = useSWR(homePath(workspaceId));
  const steps = home?.steps ?? [];
  const structure = steps.find((step) => step.id === "structure");
  const library = steps.find((step) => step.id === "library");
  if (!structure || !library) return null;

  const href = `/workspaces/${workspaceId}/library`;
  let title;
  let body;
  let action;
  if (structure.state !== STEP_STATE.done) {
    if (structure.state === STEP_STATE.notPermitted) {
      title = "Next: the Library's folders";
      body = "A member of this workspace chooses how the Library is organised. Orbik writes it from these pages once they have.";
      action = "Open the Library";
    } else {
      title = "Next: choose how your Library is organised";
      body = "Pick Orbik's default folders or a structure it proposes from your site. Orbik writes the Library from these pages once you confirm.";
      action = "Choose folders";
    }
  } else if (library.state === STEP_STATE.attention) {
    title = "The Library could not be written";
    body = "Open the Library to see what went wrong and try again.";
    action = "Open the Library";
  } else if (library.state !== STEP_STATE.done) {
    title = "Next: the Library is written from these pages";
    body = library.state === STEP_STATE.inProgress
      ? "Orbik is writing your Library now, into the folders you chose."
      : "Orbik writes your Library from these pages, into the folders you chose.";
    action = "Open the Library";
  } else {
    return null;
  }

  return (
    <div className="px-6 pt-4">
      <aside
        aria-label="Next step"
        className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-orb-orange/40 bg-orb-raised/40 px-4 py-3"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-orb-orange/40 bg-orb-space">
          <FolderTree aria-hidden="true" className="size-4 text-orb-orange" />
        </span>
        <div className="min-w-[11rem] flex-1">
          <p className="text-sm font-semibold text-orb-white">{title}</p>
          <p className="text-compact text-orb-gray">{body}</p>
        </div>
        <Link href={href} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}>
          {action}
          <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
      </aside>
    </div>
  );
}
