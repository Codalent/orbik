"use client";

import { Activity, BookMarked, Bot, Sparkles, Waypoints } from "lucide-react";
import useSWR from "swr";

import { LIVE_ACTIVITY_PATH } from "@/lib/api/activity";
import { hostOf, personFromEmail } from "@/lib/format";
import { cn } from "@/lib/utils";

/** How often the monitor asks while something is running, and while nothing is. */
const POLL_MS = Object.freeze({ active: 3000, idle: 15000 });

/**
 * The small window at the foot of the sidebar that shows what Orbik is doing right now.
 *
 * It is the one place a person can glance at from any page and know whether anything is
 * happening: a crawl with how far along it is, an agent run and the tool it is on, a model call
 * in flight. It spans workspaces on purpose; a crawl of one site is still worth knowing about
 * while looking at another.
 *
 * Something a person started says who (`startedBy`): in a workspace several people share, a crawl
 * a colleague asked for is worth telling apart from one the schedule began. What the schedule or
 * a finished crawl started names nobody.
 *
 * It asks the server rather than assembling a picture from what the page happens to know,
 * because the page only knows about its own workspace and only while it is open. Polling slows
 * to a crawl when nothing is live, so an idle sidebar costs a request every fifteen seconds.
 */
export function LiveActivity() {
  // The cadence is chosen from the latest answer, so the faster one starts on the read after
  // something goes live rather than after one idle-length wait.
  const { data: activity = null, error } = useSWR(LIVE_ACTIVITY_PATH, {
    refreshInterval: (latest) => (latest?.active ? POLL_MS.active : POLL_MS.idle),
  });
  const failed = Boolean(error);
  const active = activity?.active === true;

  const library = activity?.library ?? [];
  const items = activity ? [...activity.crawls, ...activity.agents, ...activity.aiCalls, ...library] : [];

  return (
    <section
      aria-label="Activity"
      aria-live="polite"
      className="rounded-xl border border-orb-line bg-orb-black/30 p-2.5"
    >
      <header className="flex items-center gap-1.5 text-[0.7rem] font-medium text-orb-muted">
        <Activity aria-hidden="true" className={cn("size-3", active && "text-orb-lime")} />
        <span>Activity</span>
        {active && <span aria-hidden="true" className="ml-auto size-1.5 rounded-full bg-orb-lime motion-safe:animate-pulse" />}
      </header>

      {failed && !activity ? (
        <p className="mt-2 text-xs text-orb-muted">Status unavailable.</p>
      ) : !activity ? (
        <p className="mt-2 text-xs text-orb-muted">Checking…</p>
      ) : items.length === 0 ? (
        <p className="mt-2 text-xs text-orb-muted">Nothing running.</p>
      ) : (
        <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto">
          {activity.crawls.map((crawl) => <CrawlItem key={`crawl-${crawl.workspaceId}`} crawl={crawl} />)}
          {library.map((entry) => <LibraryItem key={`library-${entry.workspaceId}`} entry={entry} />)}
          {activity.agents.map((run) => <AgentItem key={`agent-${run.runId}`} run={run} />)}
          {activity.aiCalls.map((call) => <CallItem key={`call-${call.id}`} call={call} />)}
        </ul>
      )}
    </section>
  );
}

/**
 * One crawl: the site, its phase, and a bar for how far along it is.
 *
 * The bar's denominator is what has been found so far, so it can slide as discovery adds work.
 * That is honest — a crawl genuinely does not know its size until it has walked the site — and
 * the count beside it says the real numbers, so the bar is a feel for pace rather than a promise.
 */
function CrawlItem({ crawl }) {
  const total = crawl.fetched + crawl.outstanding;
  const share = total > 0 ? Math.min(1, crawl.fetched / total) : 0;
  const queued = crawl.phase === "queued";
  const starter = starterOf(crawl.startedBy);
  return (
    <li className="space-y-1">
      <div className="flex items-center gap-1.5 text-xs">
        <Waypoints aria-hidden="true" className={cn("size-3 shrink-0", queued ? "text-orb-orange" : "text-orb-cyan")} />
        <span className="truncate text-orb-white">{crawl.workspaceName ?? hostOf(crawl.seedUrl)}</span>
        <span className={cn("ml-auto shrink-0", queued ? "text-orb-orange" : "text-orb-muted")}>{describePhase(crawl.phase)}</span>
      </div>
      <div
        role="progressbar"
        aria-label={`Crawl of ${crawl.workspaceName ?? hostOf(crawl.seedUrl)}`}
        aria-valuemin={0}
        aria-valuemax={total || undefined}
        aria-valuenow={queued ? undefined : crawl.fetched}
        aria-valuetext={queued ? "Queued" : `${crawl.fetched.toLocaleString()} of about ${total.toLocaleString()} pages`}
        className="h-1 overflow-hidden rounded-full bg-orb-raised"
      >
        <div
          className={cn("h-full rounded-full transition-[width] duration-700", queued ? "w-1/6 bg-orb-orange motion-safe:animate-pulse" : "bg-orb-cyan")}
          style={queued ? undefined : { width: `${Math.max(2, Math.round(share * 100))}%` }}
        />
      </div>
      {!queued && (
        <p className="font-mono text-[0.65rem] tabular-nums text-orb-muted">
          {crawl.fetched.toLocaleString()}
          {crawl.outstanding > 0 && ` of about ${total.toLocaleString()}`} pages
        </p>
      )}
      {starter && (
        <p className="truncate text-[0.65rem] text-orb-muted">
          {starter} {queued ? "asked for a crawl" : "started this crawl"}
        </p>
      )}
    </li>
  );
}

/** One agent run: which agent, where, and the last thing it reported. */
function AgentItem({ run }) {
  const starter = starterOf(run.startedBy);
  return (
    <li className="space-y-0.5">
      <div className="flex items-center gap-1.5 text-xs">
        <Bot aria-hidden="true" className="size-3 shrink-0 text-orb-lime" />
        <span className="truncate text-orb-white">{humanize(run.agentSlug)}</span>
        <span className="ml-auto shrink-0 text-orb-muted">{describeRunStatus(run.status)}</span>
      </div>
      <p className="truncate pl-[1.125rem] text-[0.65rem] text-orb-muted">
        {run.workspaceName ?? "Workspace"}
        {starter && ` · started by ${starter}`}
        {run.activity?.tool ? ` · ${run.activity.tool}` : run.activity?.type === "started" ? " · started" : ""}
      </p>
    </li>
  );
}

/**
 * The Library agent copying a site's pages into Sources.
 *
 * That stage is a queue job, not a run, so it is not among the agent runs above — and it calls no
 * model, so without a line of its own there would be no sign of it at all.
 */
function LibraryItem({ entry }) {
  return (
    <li className="space-y-0.5">
      <div className="flex items-center gap-1.5 text-xs">
        <BookMarked aria-hidden="true" className="size-3 shrink-0 text-orb-lime" />
        <span className="truncate text-orb-white">Library</span>
        <span className="ml-auto shrink-0 text-orb-muted">Copying pages</span>
      </div>
      <p className="truncate pl-[1.125rem] text-[0.65rem] text-orb-muted">{entry.workspaceName ?? "Workspace"}</p>
    </li>
  );
}

/** One model call in flight: what for, and which model is thinking. */
function CallItem({ call }) {
  return (
    <li className="flex items-center gap-1.5 text-xs">
      <Sparkles aria-hidden="true" className="size-3 shrink-0 text-orb-orange motion-safe:animate-pulse" />
      <span className="truncate text-orb-white">{call.purpose === "crawl-schedule" ? "Crawl planning" : humanize(call.agentSlug) || "Agent run"}</span>
      <span className="ml-auto shrink-0 truncate font-mono text-[0.65rem] text-orb-muted">{call.model ?? "model"}</span>
    </li>
  );
}

/** The name of whoever started an item, or null when nobody did. */
function starterOf(startedBy) {
  if (!startedBy) return null;
  return personFromEmail(startedBy.email)?.name ?? startedBy.email ?? null;
}

function describePhase(phase) {
  return {
    queued: "Queued",
    starting: "Starting",
    discovering: "Discovering",
    fetching: "Crawling",
    finalizing: "Finishing",
  }[phase] ?? phase;
}

function describeRunStatus(status) {
  return {
    queued: "Queued",
    running: "Running",
  }[status] ?? status;
}

function humanize(slug) {
  if (!slug) return "";
  return String(slug).split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}
