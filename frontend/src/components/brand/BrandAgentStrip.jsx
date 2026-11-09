"use client";

import Link from "next/link";
import { Check, History, Loader2, Palette, RefreshCw, Settings2, Square } from "lucide-react";

import { HEAD_WRAP } from "@/components/agents/AgentPage";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Pill } from "@/components/ui/pill";
import { describeRunEvent } from "@/lib/agents/runEvents";
import { runPhases } from "@/lib/brand/brand";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/** What the switch does, in each direction. */
const PAUSE_LABEL = "Pause the agent: the system is left as it is";
const WORK_LABEL = "Set the agent to work: once a week it checks whether your site's styling changed, and derives the system again only if it did";

/**
 * The head of the Brand page, with the agent that derives the brand folded into it: the page's
 * name and what it is for, how the Design system agent stands in a pill, how current the system is
 * on the meta line, and the few things the agent can be asked on the right, with a link to the agent's own page for its
 * settings.
 *
 * The page is about the brand, and the agent is one of the two things that write it, so the agent
 * lives in the head rather than in a card of its own — as it does on every agent's page. Idle, the
 * meta line answers "how current is this": when it was derived, from how many pages, when it will
 * be looked at again. Working, the line under the head shows which of four stages the derivation is
 * in, because a run is a few minutes of a real browser and two model calls, and a spinner would say
 * nothing about which.
 *
 * **Re-derive** forces a fresh derivation. The weekly check ends in a second when the site's
 * styling has not changed, which is right for a schedule and wrong for somebody who has just
 * changed which pages are rendered or wants a second opinion — so asking by hand skips the check.
 *
 * @param {object} props
 * @param {object} props.work the return of `useAgentWork`
 * @param {object|null} props.brand the system view from the API
 * @param {boolean} props.ready whether there is a crawl to choose pages from
 * @param {import("react").ReactNode} props.description the page's one line under the title
 * @param {boolean} [props.canRun] whether the person's role may run and steer the agent
 * @param {() => void} props.onDerive starts a forced derivation
 * @param {string} props.agentHref the Design system agent's page: its pages, schedule and runs
 * @param {() => void} props.onHistory opens the kept versions
 */
export function BrandAgentStrip({ work, brand, ready, description, canRun = true, onDerive, agentHref, onHistory }) {
  const { run, events, complete, inFlight, working, busy, setup } = work;
  const phases = runPhases(events, complete);
  const failed = !inFlight && run?.status === "failed";
  const derived = Boolean(brand?.system);
  const chosen = setup?.pages?.length ?? 0;

  const meta = inFlight
    ? [events.length ? describeRunEvent(events.at(-1)) : "Starting…"]
    : !ready
      ? ["Design system agent: crawl your site first"]
      : [
          derived ? `Design system agent derived it from ${brand.pages.length} page${brand.pages.length === 1 ? "" : "s"} on ${formatDate(brand.derivedAt)}` : "Design system agent: not derived yet",
          chosen ? `${chosen} page${chosen === 1 ? "" : "s"} chosen by you` : "pages chosen from your crawl",
          working ? (setup?.nextRunAt ? `next check ${formatDate(setup.nextRunAt)}` : "checks weekly") : null,
        ].filter(Boolean);

  return (
    <div className="space-y-4">
      <PageHeader
        className={HEAD_WRAP}
        icon={Palette}
        title="Brand"
        description={description}
        status={(
          <span role="status" className="flex flex-wrap items-center gap-1.5">
            {inFlight ? (
              <Pill tone="lime" dot pulse>Deriving now</Pill>
            ) : !ready ? (
              <Pill tone="muted">Not set up</Pill>
            ) : working ? (
              <Pill tone="lime" dot title={WORK_LABEL}>Agent set to work</Pill>
            ) : (
              <Pill tone="neutral" dot title={PAUSE_LABEL}>Agent paused</Pill>
            )}
            {failed && <Pill tone="coral" dot>Last run failed</Pill>}
          </span>
        )}
        meta={meta.map((item, index) => (
          // The separator ends the item before it, so a line that wraps starts with words.
          <span key={item} className={cn(index === 0 && inFlight && "text-orb-lime")}>
            {item}
            {index < meta.length - 1 && <span aria-hidden="true" className="ml-2">·</span>}
          </span>
        ))}
        actions={(
          <>
            {!canRun ? null : inFlight ? (
              <Button type="button" variant="outline" size="sm" onClick={work.stop} disabled={busy || run?.cancelRequested}>
                <Square className="size-3.5" /> {run?.cancelRequested ? "Stopping…" : "Stop"}
              </Button>
            ) : (
              // Before there is a system the page's own panel carries the primary button; the head's is quiet then.
              <Button type="button" size="sm" variant={derived ? "default" : "outline"} onClick={onDerive} disabled={busy || !ready} title="Render the pages and derive the system again, whether or not the site's styling changed. Your pinned values are kept.">
                <RefreshCw className="size-3.5" /> {derived ? "Re-derive" : "Derive"}
              </Button>
            )}
            {derived && (
              <Button type="button" variant="outline" size="sm" onClick={onHistory} disabled={busy}>
                <History className="size-3.5" /> History
              </Button>
            )}
            {/* Which pages are rendered and the weekly schedule are the agent's settings, on its own page. */}
            <Link href={agentHref} className={buttonVariants({ variant: "ghost", size: "sm" })} title="The pages the agent renders, its schedule and its runs">
              <Settings2 className="size-3.5" /> Agent settings
            </Link>
          </>
        )}
      />

      {inFlight && (
        <ol className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-orb-lime/25 bg-orb-lime/5 px-4 py-2.5 text-xs" aria-label="Stages of this run">
          {phases.map((phase) => (
            <li key={phase.id} className={cn("flex items-center gap-1.5", phase.state === "active" ? "text-orb-lime" : phase.state === "done" ? "text-orb-gray" : "text-orb-muted")}>
              {phase.state === "done" ? <Check aria-hidden="true" className="size-3" /> : phase.state === "active" ? <Loader2 aria-hidden="true" className="size-3 animate-spin" /> : <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />}
              {phase.label}{phase.detail && <span className="tabular-nums"> {phase.detail}</span>}
            </li>
          ))}
        </ol>
      )}

      {failed && run.error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            {run.error.message}
            {run.error.code && <span className="ml-1.5 font-mono text-xs opacity-80">({run.error.code})</span>}
          </AlertDescription>
        </Alert>
      )}
      {!inFlight && derived && attemptAfter(brand) && (
        // A later derivation rendered the site and proposed nothing — no model was configured, or
        // its answer could not be used. What is on the page is the system from before, and saying
        // so is the difference between "current" and "the last one that worked".
        <p role="status" className="rounded-lg border border-orb-orange/30 bg-orb-orange/5 px-4 py-2.5 text-compact text-orb-orange">
          On {formatDate(brand.lastAttempt.at)} your site was rendered again but no new system was proposed
          {attemptReason(brand.lastAttempt) && <>: {attemptReason(brand.lastAttempt)}</>}. This is the system derived on {formatDate(brand.derivedAt)}.
        </p>
      )}
      {!inFlight && run?.status === "succeeded" && run.result?.state === "unchanged" && (
        <p className="rounded-lg border border-orb-line bg-orb-space/50 px-4 py-2.5 text-compact text-orb-gray">
          Last check {formatDate(run.finishedAt)}: your site&apos;s styling is what the system was derived from, so nothing was rendered and no model was asked. Re-derive does it anyway.
        </p>
      )}
    </div>
  );
}

/** Whether a derivation tried and proposed nothing after the system on screen was derived. */
function attemptAfter(brand) {
  return Boolean(brand?.lastAttempt?.at && brand.derivedAt && new Date(brand.lastAttempt.at) > new Date(brand.derivedAt));
}

/** Why an attempt proposed nothing, in the words it recorded. */
function attemptReason(attempt) {
  const reason = attempt.synthesis?.visual?.reason ?? attempt.synthesis?.graphics?.reason ?? null;
  return reason ? `${reason.message}${reason.code ? ` (${reason.code})` : ""}` : null;
}
