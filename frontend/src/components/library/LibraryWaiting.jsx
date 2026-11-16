"use client";

import Link from "next/link";
import { Check, Play } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/pill";
import { useLibrary } from "./libraryContext";
import { aiAvailability } from "@/lib/library/agentWait";
import { runHeadline } from "@/lib/library/runActivity";
import { VIEWS } from "@/lib/library/workspaceTabs";
import { cn } from "@/lib/utils";

/**
 * Where the Library stands before its first write, wherever a person is looking: the overview that
 * has not been written yet, and What changed before there is anything to list.
 *
 * Five things have to be true before the agent writes — the site crawled, its folders chosen, the
 * agent set to work, AI available to write with, and then a run — and a person waiting on the
 * Library needs to see which of them it is stuck on and the one thing that moves it forward. The
 * steps are drawn as a list rather than a sentence, so "everything is ready, it starts within a
 * minute" and "nothing will ever happen" cannot look alike.
 *
 * The facts come from `library.wait` (`lib/library/agentWait.js`), worked out once for the page.
 *
 * @param {object} props
 * @param {string} [props.heading] the view's own heading; the wait's title when not given
 */
export function LibraryWaiting({ heading }) {
  const library = useLibrary();
  const { wait, state, work, phases } = library;
  const headline = work.inFlight ? runHeadline(phases) ?? "Starting…" : null;

  return (
    <div className="max-w-xl">
      <h2 className="font-display text-lg font-bold text-orb-white">{heading ?? wait?.title ?? "Nothing is waiting"}</h2>
      {wait && <p className="mt-2 text-sm leading-relaxed text-orb-gray">{wait.detail}</p>}
      {headline && (
        <p role="status" className="mt-3 flex items-center gap-2 text-compact text-orb-lime">
          <StatusDot tone="lime" pulse /> {headline}
        </p>
      )}
      <WaitAction wait={wait} className="mt-4" />
      <SetupSteps state={state} work={work} wait={wait} />
    </div>
  );
}

/**
 * The one action that moves the wait forward, when the reader may take it: crawl the site, choose
 * the folders, or set the agent to work. Nothing for a wait no button here can end.
 */
export function WaitAction({ wait, className, size = "sm" }) {
  const library = useLibrary();
  if (!wait?.action) return null;
  if (wait.action === "crawl") {
    return (
      <div className={className}>
        <Link href={`/workspaces/${library.workspaceId}/agents/crawler`} className={buttonVariants({ size })}>
          Crawl your site
        </Link>
      </div>
    );
  }
  if (wait.action === "structure") {
    return (
      <div className={className}>
        <Button type="button" size={size} onClick={() => library.openView(VIEWS.structure)}>Choose the folders</Button>
      </div>
    );
  }
  return (
    <div className={className}>
      <Button type="button" size={size} onClick={library.work.toggleWorking} disabled={library.work.busy}>
        <Play aria-hidden="true" className="size-3.5" /> Set the agent to work
      </Button>
    </div>
  );
}

/**
 * The steps before the first write, each done, current or still to come. The first one not done
 * is the one the Library is waiting on, marked in the tone of the wait.
 */
function SetupSteps({ state, work, wait }) {
  const library = useLibrary();
  const coverage = state?.coverage ?? {};
  const stored = coverage.stored ?? 0;
  const ai = aiAvailability({ state, edition: library.edition, work });
  // The agent's own setup once it is read, the Library's read before.
  const working = work.setup ? Boolean(work.working) : Boolean(state?.writer?.working);
  const steps = [
    {
      key: "crawl",
      label: "Site crawled",
      done: (state?.readiness?.markdownPages ?? 0) > 0,
      note: stored ? `${stored.toLocaleString()} ${stored === 1 ? "page" : "pages"} copied into Sources` : null,
    },
    { key: "structure", label: "Folders chosen", done: !state?.structure?.needsChoice },
    { key: "work", label: "Agent set to work", done: working },
    {
      key: "ai",
      label: wait?.kind === "plan" ? "Included in the workspace's plan" : "AI available to write with",
      // Not known until the scheduler's first pass after the agent is set to work, which says so
      // within a minute; until then it is taken as there rather than shown as the hold-up.
      done: wait?.kind !== "plan" && (ai === "available" || (ai === "unknown" && working)),
    },
    { key: "write", label: "Overview and folders written", done: false, moving: work.inFlight },
  ];
  const current = steps.find((step) => !step.done)?.key ?? null;

  return (
    <ol aria-label="Before the first write" className="mt-6 flex flex-col gap-2 border-t border-orb-line pt-4">
      {steps.map((step) => {
        const now = step.key === current;
        return (
          <li key={step.key} className="flex items-start gap-2.5 text-compact">
            <span aria-hidden="true" className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
              {step.done ? (
                <Check className="size-3.5 text-orb-lime" />
              ) : (
                <StatusDot
                  tone={now ? (step.moving ? "lime" : wait?.tone === "muted" ? "neutral" : wait?.tone ?? "neutral") : "idle"}
                  pulse={now && (step.moving || wait?.kind === "starting")}
                />
              )}
            </span>
            <span className={cn(step.done ? "text-orb-gray" : now ? "text-orb-white" : "text-orb-muted")}>
              {step.label}
              {step.note && <span className="text-orb-muted"> · {step.note}</span>}
              {now && !step.done && wait?.short && step.key !== "crawl" && (
                <span className="text-orb-muted"> · {wait.short}</span>
              )}
              <span className="sr-only">{step.done ? ", done" : now ? ", waiting on this" : ", still to come"}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
