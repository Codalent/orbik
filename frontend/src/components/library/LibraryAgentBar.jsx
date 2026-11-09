"use client";

import { ChevronDown, Library, Pause, Play, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { describeRunEvent } from "@/lib/agents/runEvents";
import { actionTone, runHeadline } from "@/lib/library/runActivity";
import { cn } from "@/lib/utils";

/** How a run's state reads in the one line the chip has for it. */
const STATUS_LABELS = Object.freeze({
  queued: "queued",
  running: "working now",
  succeeded: "idle",
  failed: "last run failed",
  cancelled: "last run stopped",
});

/** What the switch does, in each direction. */
const PAUSE_LABEL = "Pause the agent: your site is still crawled, the Library is left as it is";
const WORK_LABEL = "Set the agent to work: it rewrites the Library whenever a crawl finds a change";

/**
 * The agent, in the Library's header: what it is doing, and the one switch it has.
 *
 * It sits here rather than in a card above the files because the Library is the thing and the
 * agent is one of its two writers. A card would put the machinery first and make a page about a
 * company's own knowledge read as an agent's output panel — which is exactly what the Library
 * replaced.
 *
 * Idle, the chip answers "when was this last true": the last run, and what will cause the next
 * one. Working, it answers "what is happening": the kind of work the run is doing and how much of
 * it, in the agent's own colour, with the orbit turning. Both hang the detail off one disclosure,
 * because the detail — which files changed and why — is what somebody opens once and then leaves
 * shut.
 *
 * There is no Run now. Nobody starts this agent: it reads each page your crawl brings back and
 * rewrites the Library when what those pages say has changed, so a button would only ever start a
 * run with nothing new to read. What a person decides is whether it works at all, which is the
 * switch — and while a run is in flight, Stop sits beside it: ending this run and switching the
 * agent off are different things.
 *
 * @param {object} props
 * @param {object} props.work the return of `useAgentWork`
 * @param {ReturnType<import("@/lib/library/runActivity").runPhases>} props.phases what the run is doing
 * @param {boolean} props.ready whether there is anything for the agent to read
 * @param {boolean} props.detailOpen whether the run detail is showing
 * @param {() => void} props.onToggleDetail
 * @param {boolean} [props.hasDetail] whether there is anything to disclose
 */
export function LibraryAgentBar({ work, phases, ready, detailOpen, onToggleDetail, hasDetail = true, waitingOnStructure = false }) {
  const { run, inFlight, working, busy } = work;
  const status = inFlight ? (STATUS_LABELS[run?.status] ?? "working now") : (run ? STATUS_LABELS[run.status] ?? "idle" : "not run yet");
  const failed = !inFlight && run?.status === "failed";

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2.5 rounded-4xl border py-1.5 pl-1.5 pr-1.5",
        inFlight ? "border-orb-lime/35" : "border-orb-line",
      )}
    >
      <span
        className={cn(
          "relative flex size-7 shrink-0 items-center justify-center rounded-full border",
          inFlight ? "border-orb-lime/60 text-orb-lime" : "border-orb-line text-orb-gray",
        )}
      >
        <Library aria-hidden="true" className="size-3.5" />
        {inFlight && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -inset-px rounded-full motion-safe:animate-[orbik-orbit_6s_linear_infinite]"
          >
            <span className="absolute -top-[3px] left-[11px] size-1.5 rounded-full bg-orb-lime" />
          </span>
        )}
      </span>

      <div className="min-w-0 leading-tight">
        <p className="truncate text-compact font-medium text-orb-white" role="status">
          Library agent{" "}
          <span className={cn("font-normal", inFlight ? "text-orb-lime" : failed ? "text-orb-coral" : "text-orb-gray")}>
            · {status}
          </span>
        </p>
        <p className="truncate text-xs text-orb-muted">
          {!work.inFlight && waitingOnStructure ? "Waiting for you to choose its folders" : timing(work, phases, ready)}
        </p>
      </div>

      {hasDetail && (
        <>
          <span aria-hidden="true" className="mx-0.5 h-6 w-px shrink-0 bg-orb-line" />
          <Button
            type="button"
            variant={detailOpen ? "secondary" : "ghost"}
            size="sm"
            aria-expanded={detailOpen}
            onClick={onToggleDetail}
          >
            {inFlight ? "This run" : "What changed"}
            <ChevronDown aria-hidden="true" className={cn("size-3.5 transition-transform", detailOpen && "rotate-180")} />
          </Button>
        </>
      )}

      {inFlight && (
        <Button type="button" variant="ghost" size="sm" onClick={work.stop} disabled={busy || run?.cancelRequested}>
          <Square aria-hidden="true" className="size-3.5" />
          {run?.cancelRequested ? "Stopping…" : "Stop"}
        </Button>
      )}

      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={work.toggleWorking}
        disabled={busy || !ready}
        aria-label={working ? PAUSE_LABEL : WORK_LABEL}
        title={working ? PAUSE_LABEL : WORK_LABEL}
      >
        {working ? <Pause aria-hidden="true" className="size-3.5" /> : <Play aria-hidden="true" className="size-3.5" />}
      </Button>
    </div>
  );
}

/**
 * The second line: when the agent last wrote, and what will make it write again.
 *
 * While a run is in flight it is displaced by what the run is doing, which is the only thing
 * anybody watching wants from this line — the kind of work and how much of it, or, before any of
 * that has begun, the latest step in the run's own words.
 */
function timing({ run, events, setup, inFlight, working }, phases, ready) {
  if (inFlight) return runHeadline(phases) ?? (events.length ? describeRunEvent(events.at(-1)) : "Starting…");
  if (!ready) return "Crawl your site first";
  const last = setup?.lastRunAt ?? run?.finishedAt ?? run?.startedAt;
  const parts = [];
  if (last) parts.push(`Last run ${formatDate(last)}`);
  parts.push(working ? "runs when your site changes" : "paused");
  return parts.join(" · ");
}

/**
 * What the last run did to the Library, file by file.
 *
 * The run records a reason for every node it touched, and this is the only place those reasons are
 * readable. "Why is there suddenly a folder called Engagement" is a fair question, and the answer
 * is a sentence the agent wrote at the time rather than one anybody reconstructs afterwards. The
 * source ledger is folded in at the foot for the same reason: "why is my best blog post not in
 * here" is a question about the last run, not about the file somebody happens to have open.
 *
 * @param {object} props
 * @param {object} props.changes the run's own record, from `changesOf`
 * @param {object|null} props.run
 * @param {(path: string) => void} props.onOpen
 * @param {(() => void)|null} [props.onRebuild] opens the structure step again, when it is not open
 * @param {string} [props.className] replaces the panel's own frame, for a page that gives it a
 *   whole tab rather than a band above the files
 */
export function LibraryRunChanges({ changes, run, onOpen, onRebuild = null, className, children }) {
  return (
    <section
      aria-label="What the last run changed"
      className={className ?? "max-h-[50%] shrink-0 overflow-y-auto border-b border-orb-line bg-orb-black/20 px-6 py-4"}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-medium text-orb-white">
          {run?.finishedAt ? `Run of ${formatDate(run.finishedAt)}` : "The last run"}
        </h2>
        {changes ? (
          <p className="text-xs tabular-nums text-orb-muted">
            {changes.written.length.toLocaleString()} {changes.written.length === 1 ? "file" : "files"} changed
            {changes.unchanged > 0 && `, ${changes.unchanged.toLocaleString()} left alone`}
            {changes.sources && ` · written from ${(changes.sources.used ?? 0).toLocaleString()} of your pages, ${(changes.sources.excluded ?? 0).toLocaleString()} not chosen`}
          </p>
        ) : (
          // A run that failed, was stopped, or predates the record it now keeps: the ledger below
          // still says which of your pages the agent has read, which is the question this panel is
          // most often opened for.
          <p className="text-xs text-orb-muted">
            {run ? "This run left no record of what it changed." : "No run has been recorded yet."}
          </p>
        )}
      </div>

      {changes?.summary && <p className="mt-2 max-w-3xl text-sm text-orb-gray">{changes.summary}</p>}

      {changes?.written.length > 0 && (
        <ul className="mt-3 grid gap-1 md:grid-cols-2">
          {changes.written.map((node) => (
            <li key={`${node.action}:${node.path}`}>
              <button
                type="button"
                onClick={() => node.action !== "deleted" && onOpen(node.path)}
                disabled={node.action === "deleted"}
                className="flex w-full items-baseline gap-2 rounded-lg px-2 py-1 text-left hover:bg-orb-raised/60 disabled:cursor-default disabled:hover:bg-transparent"
              >
                <span className={cn("shrink-0 text-xs", actionTone(node.action))}>{node.action}</span>
                <span className="shrink-0 font-mono text-xs text-orb-white">{node.path}</span>
                {node.why && <span className="truncate text-xs text-orb-muted">{node.why}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      {changes?.aroundUserContent.length > 0 && (
        <p className="mt-3 text-xs text-orb-gray">
          It wrote around your own passages in{" "}
          {changes.aroundUserContent.map((path, index) => (
            <span key={path}>
              {index > 0 && ", "}
              <button type="button" onClick={() => onOpen(path)} className="font-mono text-orb-cyan hover:underline">
                {path}
              </button>
            </span>
          ))}.
        </p>
      )}

      {changes?.unfiled.length > 0 && (
        <div className="mt-3">
          <h3 className="text-2xs font-medium uppercase tracking-[0.12em] text-orb-muted">
            Not filed: no folder of yours fits
          </h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-orb-gray">
            {changes.unfiled.map((item) => (
              <li key={item.subject}>
                <span className="text-orb-white">{item.subject}</span>
                {item.suggestedFolder && <> — it would suggest a folder “{item.suggestedFolder}”</>}
                {item.why && <>. {item.why}</>}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-orb-muted">Make the folder yourself and the next run files into it.</p>
        </div>
      )}

      {changes?.openQuestions.length > 0 && (
        <div className="mt-3">
          <h3 className="text-2xs font-medium uppercase tracking-[0.12em] text-orb-muted">
            What it could not tell from your site
          </h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-orb-gray">
            {changes.openQuestions.map((question) => <li key={question}>{question}</li>)}
          </ul>
        </div>
      )}

      {children && <div className="mt-3">{children}</div>}

      {onRebuild && (
        <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-orb-muted">
          <span>Want the top-level folders worked out again from your site?</span>
          <Button type="button" variant="ghost" size="sm" onClick={onRebuild}>Rebuild the structure…</Button>
        </p>
      )}
    </section>
  );
}
