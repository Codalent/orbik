"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Pill } from "@/components/ui/pill";
import { AGENT_STATUS } from "@/lib/agents/registry";
import { ago, fromNow } from "@/lib/home/home";
import { cn } from "@/lib/utils";

/** The short word each state is shown as on a card, beside the agent's name. */
const STATUS_PILL = Object.freeze({
  [AGENT_STATUS.working]: { tone: "lime", text: "Working", dot: true, pulse: true },
  [AGENT_STATUS.idle]: { tone: "neutral", text: "Idle" },
  [AGENT_STATUS.failed]: { tone: "coral", text: "Failed", dot: true },
  [AGENT_STATUS.unconfigured]: { tone: "muted", text: "Not set up" },
  [AGENT_STATUS.unknown]: { tone: "muted", text: "Status unavailable" },
});

/** How the icon tile is drawn for each state: the same colours the sidebar's glyph uses. */
const TILE_STYLE = Object.freeze({
  [AGENT_STATUS.working]: "border-orb-lime/50 bg-orb-lime/10 text-orb-lime",
  [AGENT_STATUS.idle]: "border-orb-line bg-orb-space/70 text-orb-gray",
  [AGENT_STATUS.failed]: "border-orb-coral/50 bg-orb-coral/10 text-orb-coral",
  [AGENT_STATUS.unconfigured]: "border-dashed border-orb-line text-orb-muted",
  [AGENT_STATUS.unknown]: "border-dashed border-orb-line text-orb-muted",
});

/** What a finished run's status reads as after "Last run". */
const RUN_ENDING = Object.freeze({ succeeded: "finished", failed: "failed", cancelled: "stopped" });

/**
 * One agent on the overview: its icon, name and state, what it does in a line or two, and then how
 * its last run went and when it runs next, as a card that opens its page.
 *
 * The state is the sidebar row's own (`describe` in the agent registry), so the card and the row
 * beside it always say the same thing. A row may word its state for itself, and the card then says
 * those words. The last run and the next run are the API's figures, as the overview read reports
 * them.
 *
 * @param {object} props
 * @param {object} props.agent a row from `buildAgentRows`, with `summary`, `run`, `next`, `nextNote`,
 *   `facts` and `hint` added by the overview
 */
export function AgentCard({ agent }) {
  const Icon = agent.icon;
  const run = agent.run;
  const runFailed = run?.status === "failed";
  const running = run?.status === "running" || run?.status === "queued";
  // The sidebar's status is what the crawl and its other reads say; it calls an agent idle while a
  // run of its own is under way or after one failed, because it does not read runs. The card does,
  // so an idle row is drawn as working or failed when its newest run says so — the pill never
  // contradicts the run line under it.
  const described = STATUS_PILL[agent.status] ? agent.status : AGENT_STATUS.unknown;
  const status = described === AGENT_STATUS.idle && running
    ? AGENT_STATUS.working
    : described === AGENT_STATUS.idle && runFailed
      ? AGENT_STATUS.failed
      : described;
  const pill = STATUS_PILL[status];
  // The registry's own words only where the short one would understate it (a failure or a sync);
  // a row not set up says why in its hint line instead.
  const pillText = status !== described
    ? (running ? (run.status === "queued" ? "Queued" : "Running") : "Last run failed")
    : agent.label && (status === AGENT_STATUS.failed || status === AGENT_STATUS.working)
      ? capitalise(agent.label)
      : pill.text;

  return (
    <Link
      href={agent.href}
      data-testid={`agent-card-${agent.id}`}
      className={cn(
        "group flex w-full min-w-0 flex-col rounded-xl border bg-orb-raised/40 p-4 transition-colors",
        "hover:border-orb-muted/50 hover:bg-orb-raised/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
        runFailed || status === AGENT_STATUS.failed ? "border-orb-coral/40" : "border-orb-line",
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span aria-hidden="true" className={cn("relative flex size-9 shrink-0 items-center justify-center rounded-lg border", TILE_STYLE[status])}>
          <Icon className="size-4" />
          {status === AGENT_STATUS.working && (
            <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full border-2 border-orb-black bg-orb-lime motion-safe:animate-pulse" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="min-w-0 text-sm font-semibold text-orb-white [overflow-wrap:anywhere]">{agent.name}</h3>
            <Pill tone={pill.tone} dot={pill.dot} pulse={pill.pulse}>{pillText}</Pill>
          </div>
          {agent.summary && <p className="mt-1 line-clamp-2 text-compact leading-snug text-orb-gray">{agent.summary}</p>}
        </div>
      </div>

      <div className="mt-auto pt-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-orb-line/70 pt-3 text-xs">
          <div className="min-w-[11rem] flex-1 space-y-0.5">
            <p className={runFailed ? "text-orb-coral" : running ? "text-orb-lime" : "text-orb-muted"}>{lastRunLine(agent)}</p>
            {nextLine(agent) && <p className="text-orb-gray">{nextLine(agent)}</p>}
          </div>
          <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 text-orb-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 max-sm:hidden" />
        </div>
        {runFailed && run.error?.message && (
          <p className="mt-1.5 line-clamp-2 text-xs text-orb-coral/90">{run.error.message}</p>
        )}
      </div>
    </Link>
  );
}

/**
 * The card's run line: running now, how and when the last run ended, or — for an agent with no
 * run yet — what it waits for when it is not set up, and "No runs yet" when it is.
 */
function lastRunLine(agent) {
  const run = agent.run;
  if (run?.status === "running") return `${agent.runningWord ?? "Running"} now · started ${ago(run.startedAt)}`;
  if (run?.status === "queued") return "Queued to start";
  if (run) return `Last ${agent.runNoun ?? "run"} ${RUN_ENDING[run.status] ?? run.status} ${ago(run.finishedAt ?? run.startedAt)}`;
  if (agent.status === AGENT_STATUS.unconfigured && agent.hint) return agent.hint;
  if (agent.runUnknown || agent.status === AGENT_STATUS.unknown) return "Last run unavailable";
  return "No runs yet";
}

/**
 * The card's second line: when it runs next, or that it is set to work with no time to give (it
 * runs after the work before it), or that it is not; and the Crawler's page count.
 */
function nextLine(agent) {
  const parts = [];
  if (agent.next) parts.push(`${agent.nextWord ?? "Next run"} ${fromNow(agent.next)}`);
  else if (agent.nextNote) parts.push(agent.nextNote);
  if (agent.facts) parts.push(agent.facts);
  return parts.join(" · ") || null;
}

/** The first letter in capitals: the registry's labels are written to follow a comma. */
function capitalise(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
