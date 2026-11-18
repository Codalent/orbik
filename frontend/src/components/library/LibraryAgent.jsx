"use client";

import { FileDiff, Library, ScrollText, Square, SquareActivity } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLibrary } from "./libraryContext";
import { formatDate } from "@/lib/format";
import { describeRunEvent } from "@/lib/agents/runEvents";
import { runHeadline } from "@/lib/library/runActivity";
import { VIEWS } from "@/lib/library/workspaceTabs";
import { cn } from "@/lib/utils";

/** How a run's state reads in the agent's one line. */
const STATUS_LABELS = Object.freeze({
  queued: "queued",
  running: "working now",
  succeeded: "idle",
  failed: "last run failed",
  cancelled: "last run stopped",
});

/**
 * The Knowledge base agent as one small round icon at the foot of the Library: grey while it is
 * paused, lime once it is set to work, and lime with a dot circling it while
 * a run is in flight. It used to be a strip with its name, a line, a switch and two buttons at
 * the foot of the explorer; the line along the foot of the Library already says what it is doing,
 * so the icon only has to show at a glance whether it is working.
 *
 * Pressing it opens what the strip held: what it is doing, the switch that sets it to work, and
 * the two records of what it did — what changed, and which pages it read — or, while a run is in
 * flight, that run and Stop.
 *
 * There is no Run now. Nobody starts this agent: it reads each page your crawl brings back and
 * rewrites the Library when what those pages say has changed, so a button would only ever start a
 * run with nothing new to read. What a person decides is whether it works at all, which is the
 * switch — and while a run is in flight, Stop sits beside it: ending this run and switching the
 * agent off are different things.
 *
 * @param {object} props
 * @param {"top"|"bottom"} [props.side] where the menu opens: above the icon in the line along the
 *   foot of the page, below it elsewhere
 * @param {boolean} [props.withLine] also write the agent's name and line beside the icon, as the
 *   explorer's drawer on a phone does, where the line along the foot is not drawn
 */
export function LibraryAgent({ side = "top", withLine = false }) {
  const library = useLibrary();
  const { work } = library;
  const { run, inFlight, working } = work;
  const ready = (library.state?.readiness?.markdownPages ?? 0) > 0;
  const { line, tone } = agentLine(library);
  const label = `Knowledge base agent: ${line}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        title={label}
        className={cn(
          "group flex min-w-0 items-center gap-2.5 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
          withLine && "w-full rounded-lg px-1 py-1 text-left hover:bg-orb-raised/60",
        )}
      >
        <AgentIcon working={working} inFlight={inFlight} />
        {withLine && (
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-compact font-medium text-orb-white">Knowledge base agent</span>
            <span className={cn("block truncate text-xs", TONES[tone])}>{line}</span>
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align="start" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5 pb-1.5">
            <span className="text-compact font-medium text-orb-white">Knowledge base agent</span>
            <span role="status" title={library.wait?.detail} className={cn("text-xs leading-snug", TONES[tone])}>{line}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        {library.canEdit && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={working}
              onCheckedChange={() => work.toggleWorking()}
              disabled={work.busy || !ready}
              title={working
                ? "It rewrites the Library whenever a crawl finds a change. Uncheck to pause it."
                : "Paused: your site is still crawled, the Library is left as it is. Check to set it to work."}
            >
              Set to work
            </DropdownMenuCheckboxItem>
          </>
        )}
        <DropdownMenuSeparator />
        {inFlight ? (
          <>
            <DropdownMenuItem onClick={() => library.inspector.setRun((value) => !value)}>
              <SquareActivity aria-hidden="true" />{library.inspector.run ? "Hide this run" : "This run"}
            </DropdownMenuItem>
            {library.canEdit && (
              <DropdownMenuItem onClick={work.stop} disabled={work.busy || run?.cancelRequested}>
                <Square aria-hidden="true" />{run?.cancelRequested ? "Stopping…" : "Stop this run"}
              </DropdownMenuItem>
            )}
          </>
        ) : (
          <>
            <DropdownMenuItem
              title="What the agent's last run wrote, changed and left alone, file by file, and what it is waiting on"
              onClick={(event) => library.openView(VIEWS.changes, event)}
            >
              <FileDiff aria-hidden="true" />What changed
            </DropdownMenuItem>
            <DropdownMenuItem
              title="Every page of your site, and whether the knowledge base is written from it, with the reason"
              onClick={(event) => library.openView(VIEWS.ledger, event)}
            >
              <ScrollText aria-hidden="true" />Source ledger
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The colour of the agent's line, by what it says. */
const TONES = Object.freeze({
  live: "text-orb-lime",
  coral: "text-orb-coral",
  orange: "text-orb-orange",
  muted: "text-orb-muted",
});

/**
 * The icon: the Library's mark in a ring, lime once the agent is set to work, with a dot going
 * round the ring while a run is in flight.
 */
function AgentIcon({ working, inFlight }) {
  return (
    <span
      className={cn(
        "relative flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
        inFlight || working
          ? "border-orb-lime/70 text-orb-lime"
          : "border-orb-line text-orb-muted group-hover:text-orb-gray",
      )}
    >
      <Library aria-hidden="true" className="size-2.5" />
      {inFlight && (
        <span aria-hidden="true" className="pointer-events-none absolute -inset-px rounded-full motion-safe:animate-[orbik-orbit_4s_linear_infinite]">
          <span className="absolute -top-[2px] left-[9px] size-1 rounded-full bg-orb-lime" />
        </span>
      )}
    </span>
  );
}

/**
 * What the agent is doing, in one line, and its tone: the run's headline while one is in flight,
 * what it is waiting on when anything is, or else how its last run ended and when it last wrote.
 */
function agentLine(library) {
  const { work, phases, wait } = library;
  const { run, inFlight, working } = work;
  const status = inFlight ? (STATUS_LABELS[run?.status] ?? "working now") : run ? STATUS_LABELS[run.status] ?? "idle" : "not run yet";
  const last = work.setup?.lastRunAt ?? run?.finishedAt ?? run?.startedAt;
  // What it is waiting on, when anything is, rather than "not run yet" with no reason: the same
  // account the overview and the line along the foot give.
  const waiting = !inFlight && wait && wait.kind !== "writing" ? wait : null;
  if (inFlight) {
    return { line: runHeadline(phases) ?? (work.events.length ? describeRunEvent(work.events.at(-1)) : "Starting…"), tone: "live" };
  }
  if (waiting) {
    return {
      line: [sentenceCase(waiting.short), last ? `wrote ${formatDate(last)}` : null].filter(Boolean).join(" · "),
      tone: waiting.tone === "coral" ? "coral" : waiting.tone === "orange" ? "orange" : "muted",
    };
  }
  return {
    line: sentenceCase([status, last ? `wrote ${formatDate(last)}` : null, working ? null : "paused"].filter(Boolean).join(" · ")),
    tone: run?.status === "failed" ? "coral" : "muted",
  };
}

/** A short state as the start of a line: "waiting for its folders" → "Waiting for its folders". */
function sentenceCase(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
