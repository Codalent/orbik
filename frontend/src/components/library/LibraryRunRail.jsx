"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Check, ChevronDown, CircleDashed } from "lucide-react";

import { Button } from "@/components/ui/button";
import { describeRunEvent } from "@/lib/agents/runEvents";
import { cn } from "@/lib/utils";

/** How many of a run's writes the rail lists before it offers the rest. */
const WRITES_SHOWN = 8;

/** How often the "so far" duration is brought up to date. */
const CLOCK_MS = 15_000;

/**
 * What started a run, as the end of "Started 9:41…". The Library agent's runs are all `event`:
 * a page your Library is written from changed. The other two are runs recorded before that was the only way.
 */
const RUN_CAUSES = Object.freeze({
  event: " after your site changed",
  schedule: " on its schedule",
  manual: " by you",
});

/**
 * A run in flight, beside the file you were reading.
 *
 * It takes the place of the file's own rail rather than pushing the page around, because a run
 * lasts minutes and a person watching one is usually reading while they wait. It shows the run as
 * three kinds of work — looking at the site, reading, and writing into the folders the person
 * chose — with the count of each the run has actually reported. The agent does not do these in
 * order, it reads and writes a subject at a time, so the mark of "happening now" moves between
 * them and a phase is only ticked off when the run is over. There is no percentage and no list of
 * files still to come: the agent announces no plan, and a progress bar here would be a guess.
 *
 * @param {object} props
 * @param {object} props.work the return of `useAgentWork`
 * @param {ReturnType<import("@/lib/library/runActivity").runPhases>} props.phases
 * @param {Set<string>} props.userPaths files that hold a person's writing
 * @param {(path: string) => void} props.onOpen
 */
export function LibraryRunRail({ work, phases, userPaths, onOpen }) {
  const { run, events } = work;
  const [everyStep, setEveryStep] = useState(false);
  const failure = run?.status === "failed" ? run.error : null;
  const current = events.at(-1);

  return (
    <aside
      aria-label="This run"
      className="flex w-full shrink-0 flex-col gap-5 overflow-y-auto border-t border-orb-line p-5 md:w-80 md:border-t-0 md:border-l"
    >
      <div className="flex flex-col gap-0.5">
        <h2 className="text-2xs font-medium uppercase tracking-[0.12em] text-orb-muted">This run</h2>
        <p className="text-compact tabular-nums text-orb-gray">
          <RunClock run={run} />
        </p>
      </div>

      {phases.tiles && (
        <dl className="grid grid-cols-3 gap-2">
          {phases.tiles.map((tile) => (
            <div key={tile.label} className="flex flex-col-reverse gap-0.5 rounded-xl bg-orb-raised px-3 py-2.5">
              <dt className="text-xs text-orb-muted">{tile.label}</dt>
              <dd className="font-display text-[1.375rem] leading-7 font-bold tracking-[-0.02em] text-orb-white tabular-nums">
                {tile.value.toLocaleString()}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <ol className="flex flex-col gap-4">
        {phases.phases.map((phase) => (
          <li key={phase.key} className="flex gap-3">
            <PhaseMark state={phase.state} />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex flex-col gap-0.5">
                <span className={cn("text-sm font-medium", phase.state === "pending" || phase.state === "skipped" ? "text-orb-gray" : "text-orb-white")}>
                  {phase.label}
                </span>
                <PhaseLine phase={phase} />
              </div>
              {phase.key === "write" && (phases.writes.length > 0 || phases.writing) && (
                <Writes writes={phases.writes} writing={phases.writing} userPaths={userPaths} onOpen={onOpen} />
              )}
            </div>
          </li>
        ))}
      </ol>

      {failure && (
        <p role="alert" className="flex items-start gap-2 text-compact text-orb-coral">
          <AlertCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {failure.message}
        </p>
      )}

      <div className="mt-auto flex flex-col gap-2.5 border-t border-orb-line pt-3.5">
        {events.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2.5 self-start"
            aria-expanded={everyStep}
            aria-controls="library-run-steps"
            onClick={() => setEveryStep((open) => !open)}
          >
            {everyStep ? "Hide the steps" : `Show every step (${events.length.toLocaleString()})`}
            <ChevronDown aria-hidden="true" className={cn("size-3.5 transition-transform", everyStep && "rotate-180")} />
          </Button>
        )}
        {everyStep && (
          <ol id="library-run-steps" className="flex flex-col gap-1.5">
            {events.map((event) => (
              <li key={event.seq} className="flex items-start gap-2 text-compact">
                <StepIcon event={event} current={event === current && run?.status !== "succeeded"} />
                <span className={cn("min-w-0 break-words", event.type === "failed" ? "text-orb-coral" : "text-orb-gray")}>
                  {describeRunEvent(event)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}

/** When the run started, who started it, and how long it has been going. */
function RunClock({ run }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  if (!run?.startedAt) return "Queued, not started yet";
  const started = new Date(run.startedAt);
  const minutes = Math.floor((now - started.getTime()) / 60_000);
  const by = RUN_CAUSES[run.trigger] ?? "";
  const elapsed = minutes < 1 ? "under a minute so far" : `${minutes.toLocaleString()} min so far`;
  return `Started ${started.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}${by} · ${elapsed}`;
}

/** The circle beside a phase: not started, happening now, has had some work, or done. */
function PhaseMark({ state }) {
  if (state === "current") {
    return (
      <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-orb-lime">
        <span className="size-1.5 rounded-full bg-orb-lime motion-safe:animate-[orbik-beacon_2s_ease-in-out_infinite]" />
      </span>
    );
  }
  if (state === "done") {
    return (
      <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-orb-raised text-orb-gray">
        <Check aria-hidden="true" className="size-3" strokeWidth={2.5} />
      </span>
    );
  }
  if (state === "visited") {
    return (
      <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-orb-raised">
        <span className="size-1.5 rounded-full bg-orb-muted" />
      </span>
    );
  }
  return <span className="mt-px size-5 shrink-0 rounded-full border-[1.5px] border-dashed border-orb-line" />;
}

/** The line under a phase's name: what it has done, and whether it is doing it now. */
function PhaseLine({ phase }) {
  if (phase.state === "current") {
    return (
      <span className="text-xs text-orb-muted tabular-nums">
        <span className="text-orb-lime">working now</span>
        {phase.detail && ` · ${phase.detail}`}
      </span>
    );
  }
  const text = phase.state === "pending" ? "not started" : phase.state === "skipped" ? "not needed this run" : phase.detail;
  return text ? <span className="text-xs text-orb-muted tabular-nums">{text}</span> : null;
}

/**
 * The files a run has written, newest last, and the one it is writing now.
 *
 * The file in progress has no name: the event that starts a write names the tool, not the path,
 * so all the rail can honestly say is that one is being written.
 */
function Writes({ writes, writing, userPaths, onOpen }) {
  const [all, setAll] = useState(false);
  const shown = all ? writes : writes.slice(-WRITES_SHOWN);
  const hidden = writes.length - shown.length;
  return (
    <ul className="flex flex-col gap-1.5 text-xs">
      {hidden > 0 && (
        <li>
          <button type="button" onClick={() => setAll(true)} className="text-orb-muted hover:text-orb-white">
            {hidden.toLocaleString()} written earlier: show them
          </button>
        </li>
      )}
      {shown.map((write) => (
        <li key={write.path}>
          <button
            type="button"
            onClick={() => write.action !== "deleted" && onOpen(write.path)}
            disabled={write.action === "deleted"}
            className="flex w-full items-center gap-2 text-left text-orb-gray hover:text-orb-white disabled:cursor-default disabled:hover:text-orb-gray"
          >
            <Check aria-hidden="true" className="size-3 shrink-0" strokeWidth={2.5} />
            <span className="min-w-0 flex-1 truncate font-mono">{write.path}</span>
            <span className={cn("shrink-0", write.action === "deleted" ? "text-orb-coral" : "text-orb-muted")}>
              {write.action === "deleted" ? "removed" : write.action}
              {write.action === "updated" && userPaths.has(write.path) && ", yours kept"}
            </span>
          </button>
        </li>
      ))}
      {writing && (
        <li className="flex items-center gap-2 text-orb-white">
          <span aria-hidden="true" className="flex w-3 shrink-0 justify-center">
            <span className="size-1.5 rounded-full bg-orb-lime motion-safe:animate-[orbik-beacon_2s_ease-in-out_infinite]" />
          </span>
          <span className="min-w-0 flex-1 text-orb-lime">Writing a file…</span>
        </li>
      )}
    </ul>
  );
}

/** The mark beside one step of the full log: done, happening, or failed. */
function StepIcon({ event, current }) {
  if (event.type === "failed") return <AlertCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-orb-coral" />;
  if (event.type === "truncated") return <CircleDashed aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-orb-muted" />;
  if (current) {
    return <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-orb-lime motion-safe:animate-[orbik-beacon_2s_ease-in-out_infinite]" />;
  }
  return <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-orb-muted" />;
}
