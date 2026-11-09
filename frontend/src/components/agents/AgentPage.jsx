"use client";

import Link from "next/link";
import { ArrowUpRight, ChevronDown, CircleCheck, Info, Pause, Play, RefreshCw } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { Skeleton } from "@/components/ui/skeleton";
import { IndexStatus } from "@/components/ask/IndexStatus";
import { RunProgress } from "./RunProgress";
import { buildAgentRows } from "@/lib/agents/registry";
import { RUN_STATUS_LABELS, TERMINAL_RUN_STATUSES } from "@/lib/agents/runEvents";
import { useAgentWork } from "@/lib/agents/useAgentWork";
import { formatDate } from "@/lib/format";
import { ago, fromNow } from "@/lib/home/home";
import { cn } from "@/lib/utils";
import { useCan } from "@/lib/workspaces/roles";

/**
 * The frame every agent's page shares, so fifteen pages read as one product: the head, the
 * headline figures, and the quiet panel of what the agent can and cannot do at the foot.
 *
 * Each dashboard keeps what is its own — its counts, its lists, its reports — and hands this frame
 * only the words and figures the API gave it. Nothing here decides a state: whether the agent is
 * set to work, running or failed is what `useAgentWork` read, and whether it has anything to work
 * from is what the dashboard's own read said.
 */

/**
 * Gives a head's text column a floor, so that when the buttons beside it do not fit they move
 * under the title rather than squeezing the name and summary into a narrow strip. Passed to
 * `PageHeader` as its class; the text column is the header's first `div`.
 */
// The floor leaves room for the icon tile and its gap (3.75rem), so on a phone the tile stays
// beside the title rather than on a line of its own. The buttons, the header's last `div`, may
// shrink to the width there is, so a long row of them wraps instead of running off the screen.
export const HEAD_WRAP = "[&>div:first-of-type]:min-w-[min(calc(100%_-_3.75rem),22rem)] [&>div:last-child]:min-w-0 [&>div:last-child]:shrink";

/** The agent's name and icon as the sidebar shows them, for a head drawn before the agent loads. */
export function agentIdentity(agentSlug) {
  const row = buildAgentRows("", null).find((entry) => entry.id === agentSlug);
  return row ? { name: row.name, icon: row.icon } : null;
}

/**
 * An agent page's head, with the run machinery underneath it.
 *
 * Takes the props the old work panel under each head took (cadence, readiness, the working and
 * paused sentences, run input), so what the controls do did not change when they moved into the
 * head, and watches the agent itself. A page that already watches the agent can draw
 * `AgentHeadView` with its own `work` instead.
 *
 * @param {object} props see `AgentHeadView`; `onAgent` and `onFinished` go to `useAgentWork`
 */
export function AgentHead({ workspaceId, agentSlug, onAgent, onFinished, ...rest }) {
  const work = useAgentWork({ workspaceId, agentSlug, onAgent, onFinished });
  return <AgentHeadView work={work} workspaceId={workspaceId} agentSlug={agentSlug} {...rest} />;
}

/**
 * The head itself: the agent's icon, name and one-line summary; how it stands, in a pill; when it
 * last ran and when it runs next; and Run now and Set to work on the right. Under it, the one
 * thing a person most needs next: why it cannot run yet, or what its last run said, and the run
 * itself while one is in flight or when one failed.
 *
 * Running an agent, setting it to work and stopping a run are a member's; a read-only member is
 * told how the agent stands and offered nothing to press.
 *
 * @param {object} props
 * @param {ReturnType<typeof useAgentWork>} props.work the agent as `useAgentWork` reads it
 * @param {string} props.workspaceId
 * @param {string} props.agentSlug
 * @param {string} [props.fallbackName] the name shown until the agent's definition loads
 * @param {string} [props.fallbackSummary] the summary shown until then
 * @param {string} [props.cadence] how often the schedule fires, in words ("once a week")
 * @param {boolean} [props.ready] whether the agent has anything to work from
 * @param {string} [props.notReadyMessage] what to say when it does not
 * @param {string} [props.notReadyLabel] the pill's word for that state
 * @param {React.ReactNode} [props.notReadyAction] a link beside that message (to the crawler, say)
 * @param {boolean} [props.manual] whether a person can start a run; false for an agent the work
 *   upstream of it starts, which the API refuses to run by hand
 * @param {boolean} [props.switchable] whether the agent has a schedule a person switches on; false
 *   for one whose schedule is chosen elsewhere
 * @param {string} [props.workingMessage] the sentence under the head while it is set to work
 * @param {string} [props.pausedMessage] the sentence while paused
 * @param {"all"|"unsuccessful"|false} [props.showRun] which run is drawn under the head: any, only
 *   one in flight or not successful, or none (the page draws its own)
 * @param {object|null} [props.runInput] what Run now sends as the run's input
 * @param {React.ReactNode} [props.runControls] the control that input is chosen with
 * @param {React.ReactNode} [props.actions] further buttons, after the agent's own
 * @param {React.ReactNode} [props.status] pills in place of the computed ones
 * @param {React.ReactNode} [props.meta] further items for the meta line
 * @param {{summary: string, finishedAt?: string|null, note?: React.ReactNode}|null} [props.lastResult]
 *   what the agent's last finished run reported, from the dashboard's own read
 * @param {string|null} [props.error] a failure of the dashboard's own read, said with the agent's
 */
export function AgentHeadView({
  work,
  workspaceId,
  agentSlug,
  fallbackName,
  fallbackSummary,
  cadence = "once a week",
  ready = true,
  notReadyMessage = "This agent needs a crawl of your site before it can run.",
  notReadyLabel = "Not set up",
  notReadyAction = null,
  manual = true,
  switchable = true,
  workingMessage,
  pausedMessage,
  showRun = "all",
  runInput = null,
  runControls = null,
  actions = null,
  status = null,
  meta = null,
  lastResult = null,
  error = null,
}) {
  const canRun = useCan("member", workspaceId);
  const identity = agentIdentity(agentSlug);
  const { agent, setup, run, events, complete, busy, inFlight, working } = work;
  const runs = work.runs ?? [];
  const lastFinished = runs.find((entry) => TERMINAL_RUN_STATUSES.includes(entry.status)) ?? null;
  const lastRunAt = lastFinished?.finishedAt ?? lastFinished?.startedAt ?? lastResult?.finishedAt ?? null;
  const failures = [error, work.error].filter(Boolean);
  // The run under the head: one in flight, failed or stopped is drawn open; one that finished
  // cleanly is folded into the strip with the last result.
  const visibleRun = Boolean(showRun && run && (showRun === "all" || run.status !== "succeeded"));
  const foldedRun = visibleRun && complete && run.status === "succeeded";
  const result = ready && lastResult?.summary ? lastResult : null;

  const sentence = !ready
    ? null
    : working
      ? workingMessage ?? `Runs ${cadence} in Orbik Cloud, and only rewrites what your site actually changed.`
      : pausedMessage ?? `Set it to work and it runs ${cadence}, updating only what changed. Or run it now.`;

  const metaItems = [
    lastRunAt ? (
      <span key="last">
        Last run {ago(lastRunAt)}
        {lastFinished && lastFinished.status !== "succeeded" && (
          <span className={lastFinished.status === "failed" ? "text-orb-coral" : undefined}> · {(RUN_STATUS_LABELS[lastFinished.status] ?? lastFinished.status).toLowerCase()}</span>
        )}
      </span>
    ) : !work.loading && !inFlight ? <span key="last">Never run</span> : null,
    working && setup?.nextRunAt && !inFlight ? <span key="next">Next run {fromNow(setup.nextRunAt)}</span> : null,
    meta ? <span key="extra" className="contents">{meta}</span> : null,
  ].filter(Boolean);

  return (
    <div className="space-y-4">
      <PageHeader
        className={HEAD_WRAP}
        icon={identity?.icon}
        title={agent?.name ?? fallbackName ?? identity?.name ?? "Agent"}
        description={agent?.summary ?? fallbackSummary}
        status={status ?? (work.loading ? <Skeleton className="h-5 w-20 rounded-full bg-orb-raised/70" /> : (
          <AgentStatus ready={ready} notReadyLabel={notReadyLabel} working={working} inFlight={inFlight} failed={lastFinished?.status === "failed"} switchable={switchable} />
        ))}
        meta={metaItems.length ? interleave(metaItems) : null}
        actions={canRun && (manual || switchable || actions) ? (
          <>
            {manual && runControls}
            {manual && (
              <Button type="button" size="sm" variant="outline" onClick={runInput ? () => work.runWith(runInput) : work.runNow} disabled={busy || inFlight || !ready}>
                <RefreshCw className={inFlight ? "size-3.5 animate-spin" : "size-3.5"} />
                {inFlight ? "Running…" : "Run now"}
              </Button>
            )}
            {switchable && (
              <Button type="button" size="sm" variant={working ? "outline" : "default"} onClick={work.toggleWorking} disabled={busy || !ready}>
                {working ? <><Pause className="size-3.5" /> Pause</> : <><Play className="size-3.5" /> Set to work</>}
              </Button>
            )}
            {actions}
          </>
        ) : actions}
      >
        {sentence && <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-orb-muted">{sentence}</p>}
      </PageHeader>

      {failures.map((message) => (
        <Alert key={message} variant="destructive" role="alert">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ))}

      {!ready && notReadyMessage && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-dashed border-orb-line px-4 py-3 text-sm text-orb-gray">
          <span className="min-w-[11rem] flex-1">{notReadyMessage}</span>
          {notReadyAction}
        </div>
      )}

      {(result || foldedRun) && (
        <LastRunStrip result={result} run={foldedRun ? run : null}>
          {foldedRun && <RunProgress run={run} events={events} complete={complete} onCancel={canRun ? work.stop : undefined} />}
        </LastRunStrip>
      )}

      {visibleRun && !foldedRun && (
        <Panel className={cn(run.status === "failed" && "border-orb-coral/40")}>
          <RunProgress run={run} events={events} complete={complete} onCancel={canRun ? work.stop : undefined} />
        </Panel>
      )}
    </div>
  );
}

/**
 * How the agent stands, in a pill: running while a run is in flight, otherwise set to work or
 * paused (or not set up, when it has nothing to work from), and a second pill when the newest
 * finished run failed — the one thing that should catch the eye from across the room.
 */
export function AgentStatus({ ready, notReadyLabel, working, inFlight, failed, switchable }) {
  return (
    <span role="status" className="flex flex-wrap items-center gap-1.5">
      {inFlight ? (
        <Pill tone="lime" dot pulse>Running</Pill>
      ) : !ready ? (
        <Pill tone="muted">{notReadyLabel}</Pill>
      ) : switchable ? (
        working ? <Pill tone="lime" dot>Set to work</Pill> : <Pill tone="neutral" dot>Paused</Pill>
      ) : null}
      {failed && !inFlight && <Pill tone="coral" dot>Last run failed</Pill>}
    </span>
  );
}

/**
 * What the last run said, in one quiet strip under the head, with its log folded behind it.
 *
 * A run in flight, or one that failed or was stopped, is drawn open in a panel instead; one that
 * finished cleanly is folded here, because its output is already the page and its log is a
 * question asked now and then.
 *
 * @param {object} props
 * @param {{summary: string, finishedAt?: string|null, note?: React.ReactNode}|null} props.result
 * @param {object|null} props.run the finished run whose log is folded in, if any
 */
function LastRunStrip({ result, run, children }) {
  const line = result ? (
    <span className="min-w-0 flex-1">
      <span className="text-orb-muted">Last result{result.finishedAt ? `, ${formatDate(result.finishedAt)}` : ""}:</span> {result.summary}
      {result.note && <span className="mt-1 block">{result.note}</span>}
    </span>
  ) : (
    <span className="min-w-0 flex-1 text-orb-muted">Last run{run?.finishedAt ? `, ${formatDate(run.finishedAt)}` : ""}: finished</span>
  );
  // Joined by hand rather than with `cn`, which reads the size and the colour as two `text-`
  // classes in conflict and keeps only the second.
  const frame = "rounded-lg border border-orb-line bg-orb-space/50 text-compact text-orb-gray";
  if (!run) return <div className={`${frame} px-4 py-2.5`} data-testid="last-result">{line}</div>;
  return (
    <details className={`group ${frame}`} data-testid={result ? "last-result" : undefined}>
      <summary className="flex cursor-pointer list-none flex-wrap items-start gap-x-4 gap-y-1 px-4 py-2.5 [&::-webkit-details-marker]:hidden">
        {line}
        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-orb-muted group-hover:text-orb-white">
          Run log <ChevronDown aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-180" />
        </span>
      </summary>
      <div className="border-t border-orb-line/60 px-4 py-3">{children}</div>
    </details>
  );
}

/** Puts a quiet dot between the items of a meta line. */
function interleave(items) {
  return items.flatMap((item, index) => (index === 0 ? [item] : [<span key={`dot-${index}`} aria-hidden="true">·</span>, item]));
}

/**
 * The headline figures under the head: two to four `StatTile`s in a grid (docs/ui.md).
 *
 * @param {object} props
 * @param {2|3|4} [props.columns] how many sit in a row on a wide screen
 */
export function AgentStats({ columns = 4, className, children, ...props }) {
  return (
    <div
      className={cn("grid grid-cols-2 gap-3", columns === 3 && "lg:grid-cols-3", columns === 4 && "lg:grid-cols-4", className)}
      {...props}
    >
      {children}
    </div>
  );
}

/**
 * What the agent can and cannot do, at the foot of its page, folded to one line.
 *
 * Every agent says the same kind of thing here — what it reads, what it never promises, that
 * Orbik never edits the site — and it matters, but it is read once, so it waits behind a click
 * rather than standing in a card as loud as the findings.
 *
 * @param {object} props
 * @param {string[]} props.items the sentences, from the agent's own module
 * @param {string} [props.title]
 * @param {string} [props.testId] the list's test id, where the page had one
 */
export function AgentLimits({ items, title = "What this agent can and cannot do", testId }) {
  if (!items?.length) return null;
  return (
    <details className="group rounded-xl border border-orb-line/80 bg-orb-raised/20">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm text-orb-gray hover:text-orb-white [&::-webkit-details-marker]:hidden">
        <Info aria-hidden="true" className="size-4 shrink-0 text-orb-muted" />
        <span className="flex-1">{title}</span>
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-orb-muted transition-transform group-open:rotate-180" />
      </summary>
      <ul className="list-disc space-y-1.5 border-t border-orb-line/60 py-3 pl-10 pr-4 text-sm text-orb-gray" data-testid={testId}>
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </details>
  );
}

/**
 * The sentence an agent's page shows when its read found nothing to do: said plainly, with a lime
 * tick, because "nothing wrong" is news and a blank page is not.
 */
export function AllClear({ testId, children }) {
  return (
    <div role="status" data-testid={testId} className="flex items-start gap-3 rounded-lg border border-orb-lime/25 bg-orb-lime/5 px-4 py-3 text-sm text-orb-gray">
      <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-orb-lime" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * The way to the crawler, beside the sentence that says an agent is waiting for a crawl: the one
 * thing a person can do about it, a click away.
 */
export function CrawlerLink({ workspaceId, children = "Go to the crawler" }) {
  return (
    <Link
      href={`/workspaces/${workspaceId}/agents/crawler`}
      className="inline-flex items-center gap-1 text-sm font-medium text-orb-cyan underline-offset-4 hover:text-orb-white hover:underline"
    >
      {children} <ArrowUpRight aria-hidden="true" className="size-3.5" />
    </Link>
  );
}

/**
 * The line about the search index, on the pages whose agent finds related pages through it: what
 * it is used for, and the index's own status, the one the Library and Ask pages show.
 */
export function IndexNote({ note, index, failed = false, testId, children }) {
  return (
    <div className="space-y-1.5 rounded-lg border border-orb-line/70 bg-orb-space/40 px-4 py-3" data-testid={testId}>
      <p className="text-xs text-orb-muted">{note}</p>
      <IndexStatus index={index} />
      {failed && <p role="status" className="text-xs text-orb-coral">The search index&apos;s status could not be read.</p>}
      {children}
    </div>
  );
}

/**
 * An agent page while its first read is on the way, shaped like the page it becomes: the head,
 * the figures and a panel, so nothing jumps when the content arrives.
 *
 * @param {object} props
 * @param {string} props.label what is loading, read out instead of the shapes
 * @param {number} [props.stats] how many figure tiles to draw, or 0
 */
export function AgentPageSkeleton({ label, stats = 4 }) {
  const shape = "bg-orb-raised/60";
  return (
    <div className="space-y-6" role="status" aria-label={label}>
      <div className="flex items-start gap-4">
        <Skeleton className={cn("size-11 shrink-0 rounded-xl", shape)} />
        <div className="min-w-0 flex-1 space-y-2.5">
          <Skeleton className={cn("h-7 w-full max-w-72 rounded-lg", shape)} />
          <Skeleton className={cn("h-4 w-full max-w-xl rounded-md", shape)} />
          <Skeleton className={cn("h-3 w-40 rounded-md", shape)} />
        </div>
        <Skeleton className={cn("hidden h-8 w-48 rounded-full sm:block", shape)} />
      </div>
      {stats > 0 && (
        <div className={cn("grid grid-cols-2 gap-3", stats === 3 ? "lg:grid-cols-3" : "lg:grid-cols-4")}>
          {Array.from({ length: stats }, (_, index) => <Skeleton key={index} className={cn("h-[6.75rem] rounded-xl", shape)} />)}
        </div>
      )}
      <Skeleton className={cn("h-72 rounded-xl", shape)} />
      <span className="sr-only">{label}</span>
    </div>
  );
}
