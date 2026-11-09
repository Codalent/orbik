"use client";

import { useEffect, useRef } from "react";
import useSWR from "swr";

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { crawlRunsPath } from "@/lib/api/crawl";
import { describeDuration, describeRunTiming, formatDateTime } from "@/lib/crawl/format";
import { cn } from "@/lib/utils";
import { CrawlActivityLog } from "./CrawlActivityLog";
import { RUN_PRESENTATION, RunBeacon } from "./runPresentation";

/** How a run came to be started, in the words a person would use for it. */
const TRIGGER_LABELS = Object.freeze({
  schedule: "Scheduled",
  manual: "Started by you",
  api: "Started by the API",
});

/**
 * The crawl's record: what it is doing now, and every run before it.
 *
 * This is behind a button rather than on the page because it is what somebody opens when they
 * have a question — why is this slower than last week, did the run that ended at four actually
 * finish, why does the page count keep changing — and none of those are asked on a normal visit.
 * The page itself keeps only the live log, which is feedback rather than history.
 *
 * @param {object} props
 * @param {string} props.workspaceId workspace whose crawl is shown
 * @param {boolean} props.open whether the panel is showing
 * @param {() => void} props.onClose closes the panel
 * @param {object} props.activity the shared activity read, so the panel does not poll a second time
 * @param {boolean} props.live whether a crawl is running
 * @param {(urlHash: string) => void} props.onSelect opens a page's detail panel
 */
export function CrawlLogsSheet({
  workspaceId,
  open,
  onClose,
  activity,
  live,
  onSelect,
}) {
  // Runs are read while the panel is open, and nothing is asked for while it is shut.
  const { data, error, mutate } = useSWR(open ? crawlRunsPath(workspaceId, 20) : null);
  const runs = data?.items ?? null;
  const failed = Boolean(error) && !data;

  // A crawl starting or finishing is the only thing that adds a run or changes how one ended, so
  // that is when the list is read again.
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current === live) return;
    wasLive.current = live;
    if (open) mutate();
  }, [live, open, mutate]);

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-y-auto border-orb-line bg-orb-space p-0 sm:w-[42%] sm:min-w-[28rem] data-[side=right]:sm:max-w-[48rem]"
      >
        <SheetHeader className="gap-1 border-b border-orb-line p-5 pr-14">
          <SheetTitle className="font-display text-base font-bold text-orb-white">Crawl logs</SheetTitle>
          <SheetDescription className="text-orb-muted">
            Every crawl of this site, newest first, and what the one in progress is doing.
          </SheetDescription>
        </SheetHeader>

        {activity.run && (
          <div className="border-b border-orb-line p-5">
            <CrawlActivityLog
              entries={activity.entries}
              logs={activity.logs}
              progress={activity.progress}
              live={live}
              onSelect={(urlHash) => { onClose(); onSelect(urlHash); }}
            />
          </div>
        )}

        <div className="p-5">
          <h3 className="font-display text-sm font-bold text-orb-white">Runs</h3>

          {failed && <p className="mt-3 text-sm text-orb-coral">The crawl history could not be loaded.</p>}
          {!failed && runs === null && <p className="mt-3 text-sm text-orb-muted">Loading…</p>}
          {!failed && runs?.length === 0 && (
            <p className="mt-3 text-sm text-orb-muted">This site has not been crawled yet.</p>
          )}

          {runs?.length > 0 && (
            // A rail rather than a list of cards: runs are a sequence, one after another over
            // time, and the line is what says so without a single word of explanation.
            <ol className="mt-4">
              {runs.map((run, index) => (
                <RunRow key={run.id} run={run} last={index === runs.length - 1} />
              ))}
            </ol>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** One crawl: how it ended, when, and what it cost. */
function RunRow({ run, last }) {
  const presentation = RUN_PRESENTATION[run.status] ?? RUN_PRESENTATION.cancelled;
  const counters = run.counters ?? {};
  const running = run.status === "running";
  const cutShort = (counters.pagesSkippedNoBudget ?? 0) > 0;

  const facts = [
    TRIGGER_LABELS[run.trigger] ?? "Started",
    run.durationMs ? describeDuration(run.durationMs) : null,
    `${(counters.pagesFetched ?? 0).toLocaleString()} fetched`,
    (counters.pagesBroken ?? 0) > 0 ? `${counters.pagesBroken.toLocaleString()} broken` : null,
    (counters.urlsDiscovered ?? 0) > 0 ? `${counters.urlsDiscovered.toLocaleString()} URLs known` : null,
  ].filter(Boolean);

  return (
    <li className="relative pb-5 pl-6 last:pb-0">
      {!last && <span aria-hidden="true" className="absolute bottom-0 left-[3px] top-4 w-px bg-orb-line" />}
      <span className="absolute left-0 top-1.5">
        <RunBeacon tone={presentation.dot} live={running} />
      </span>

      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className={cn("font-medium", presentation.tone)}>{presentation.label}</span>
        <span className="text-orb-muted">{describeRunTiming(run)}</span>
        <span className="text-xs text-orb-muted">{formatDateTime(run.startedAt)}</span>
      </p>

      <p className="mt-0.5 text-xs text-orb-muted">{facts.join(" · ")}</p>

      {cutShort && (
        // The one counter worth a sentence of its own: a run that stopped because the month's
        // budget ran out looks identical to a small site otherwise.
        <p className="mt-1 text-xs text-orb-orange">
          Stopped early — {counters.pagesSkippedNoBudget.toLocaleString()} pages were left unfetched when the
          month&rsquo;s crawl budget ran out.
        </p>
      )}

      {run.error && <p className="mt-1 text-xs text-orb-coral">{run.error.message}</p>}
    </li>
  );
}
