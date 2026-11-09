"use client";

import { useEffect, useState } from "react";
import { CalendarClock, RefreshCw, ScrollText, Settings, Trash2, Waypoints } from "lucide-react";

import { HEAD_WRAP } from "@/components/agents/AgentPage";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Pill } from "@/components/ui/pill";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { describeNextCrawl, describeRunTiming } from "@/lib/crawl/format";
import { hostOf } from "@/lib/format";
import { QUEUED_PRESENTATION, RUN_PRESENTATION } from "./runPresentation";

/**
 * The one part of the crawl view that never scrolls away, drawn as every agent's head is
 * (`PageHeader`): the Crawler's icon and name, how the crawl stands in a pill, the site and when
 * it was last and is next crawled, and the buttons on the right.
 *
 * It carries the four things that stay true wherever somebody is in a fifty-thousand page tree:
 * which site this is, whether a crawl is running, how to change the settings, and how to start
 * one. Everything else — the figures, the log, the tree — is below and moves.
 *
 * Live progress is here rather than only in the logs panel because a crawl that has been asked
 * for and shows nothing reads as broken, and the panel is a click away.
 *
 * @param {object} props
 * @param {object} props.site crawl configuration
 * @param {object|null} props.activeRun the run in progress, if any
 * @param {object|null} props.latestRun the most recently started run
 * @param {{fetched: number, outstanding: number}|null} props.progress live counts, while crawling
 * @param {boolean} [props.queued] a crawl has been asked for and the scheduler has not started it
 * Every action but the logs is optional: one left out is not drawn, which is how a person whose
 * role may not crawl sees the bar with nothing to press but the logs.
 *
 * @param {() => void} [props.onCrawlNow] asks for a crawl of the pages that are due
 * @param {() => void} [props.onFreshCrawl] asks for every page in full, ignoring frequencies
 * @param {() => void} [props.onSetFrequencies] opens the frequency picker
 * @param {() => void} [props.onClearData] deletes everything crawled, keeping the settings
 * @param {() => void} [props.onEditSettings] opens the settings form
 * @param {() => void} props.onOpenLogs opens the crawl logs panel
 * @param {boolean} props.busy whether a request is in flight
 */
export function CrawlTopBar({ site, activeRun, latestRun, progress, queued: requested = false, onCrawlNow, onFreshCrawl, onSetFrequencies, onClearData, onEditSettings, onOpenLogs, busy }) {
  // A fresh crawl fetches every page, which on a large site is a real spend of the monthly
  // budget, so it takes two presses: the first turns the button into the question, the second
  // answers it. The question expires on its own rather than sitting armed under a stray click.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(false), 6000);
    return () => clearTimeout(timer);
  }, [armed]);
  // Clearing cannot be undone, so it asks the same way.
  const [clearArmed, setClearArmed] = useState(false);
  useEffect(() => {
    if (!clearArmed) return undefined;
    const timer = setTimeout(() => setClearArmed(false), 6000);
    return () => clearTimeout(timer);
  }, [clearArmed]);
  const run = activeRun ?? latestRun;
  const presentation = run ? RUN_PRESENTATION[run.status] : null;
  const live = Boolean(activeRun);
  // Queued is either a run that exists but has not begun, or a request the scheduler has not
  // yet turned into a run. Both mean "it is coming", and both keep the button honest.
  const queued = (live && (progress?.phase ?? run?.phase) === "queued") || (!live && requested);

  const host = hostOf(site.seedUrl);
  // The status pill, in the tones every agent's head uses: lime while a crawl moves and once one
  // has completed, orange while one waits its turn, coral when the last one ended with errors.
  const status = queued
    ? <Pill tone="orange" dot pulse aria-live="polite">{QUEUED_PRESENTATION.label}</Pill>
    : presentation
      ? <Pill tone={PILL_TONE[run.status] ?? "neutral"} dot pulse={live} aria-live={live ? "polite" : undefined}>{presentation.label}</Pill>
      : <Pill tone="muted">{site.enabled ? "Not crawled yet" : "Paused"}</Pill>;

  return (
    // Held at the top from a tablet's width up. On a phone the head, with its buttons wrapped under
    // it, would cover a third of the screen, so there it scrolls away with the rest.
    <div className="z-20 border-b border-orb-line bg-orb-space px-6 py-4 md:sticky md:top-0 md:py-5">
      <PageHeader
        id="crawl-heading"
        className={HEAD_WRAP}
        icon={Waypoints}
        title="Crawler"
        description="Reads your site page by page. Every other agent, and the Library, works from what it keeps."
        status={<span role="status" className="flex items-center">{status}</span>}
        meta={(
          <>
            <a href={site.seedUrl} target="_blank" rel="noreferrer" className="truncate text-orb-gray underline-offset-4 hover:text-orb-white hover:underline">{host}</a>
            {/* While crawling, the count replaces "4 minutes ago": how far along it is answers the
                question somebody watching is actually asking. */}
            {live && progress ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">
                  {progress.fetched.toLocaleString()}
                  {progress.outstanding > 0 && ` of about ${(progress.fetched + progress.outstanding).toLocaleString()}`}
                  {" pages"}
                </span>
              </>
            ) : (
              // Not while queued: the timing is the previous run's, and beside "Queued" it would
              // read as how long this one has been waiting.
              presentation && !queued && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{live ? describeRunTiming(run) : `Last crawl ${describeRunTiming(run)}`}</span>
                </>
              )
            )}
            {site.nextCrawlAt && !live && !queued && (
              <>
                <span aria-hidden="true">·</span>
                <span>Next {describeNextCrawl(site.nextCrawlAt)}</span>
              </>
            )}
          </>
        )}
        actions={<CrawlActions {...{ latestRun, live, queued, armed, setArmed, clearArmed, setClearArmed, onCrawlNow, onFreshCrawl, onSetFrequencies, onClearData, onEditSettings, onOpenLogs, busy }} />}
      />
    </div>
  );
}

/** Each run status's pill tone; the words stay `RUN_PRESENTATION`'s, which the logs panel shares. */
const PILL_TONE = Object.freeze({ running: "lime", succeeded: "lime", failed: "coral", cancelled: "neutral" });

/**
 * The crawl's buttons, on the right of the head: logs, settings, frequencies, clearing, a fresh
 * crawl and Crawl now. The two that cannot be undone or that spend the whole budget ask twice.
 */
function CrawlActions({ latestRun, live, queued, armed, setArmed, clearArmed, setClearArmed, onCrawlNow, onFreshCrawl, onSetFrequencies, onClearData, onEditSettings, onOpenLogs, busy }) {
  return (
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onOpenLogs}>
          <ScrollText aria-hidden="true" className="size-4" />
          Crawl logs
        </Button>

        {/*
          An icon rather than the word: this button is pressed once when a site is set up and
          rarely again, and the gear is the most universally read glyph in software. The tooltip
          and the accessible name still say "Crawl settings", so nothing is lost to anybody who
          cannot or does not read the glyph.
        */}
        {onEditSettings && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={onEditSettings}
                  disabled={busy}
                  aria-label="Crawl settings"
                />
              }
            >
              <Settings aria-hidden="true" className="size-4" />
            </TooltipTrigger>
            <TooltipContent>Crawl settings</TooltipContent>
          </Tooltip>
        )}

        {/*
          Offered only once there are pages to choose for: the list exists after the first crawl
          has finished, and before that the button could only say "crawl first". Choosing fetches
          nothing, so it is not disabled while a crawl runs.
        */}
        {onSetFrequencies && latestRun && (
          <Button type="button" variant="outline" size="sm" onClick={onSetFrequencies} disabled={busy}>
            <CalendarClock aria-hidden="true" className="size-4" />
            Set crawl frequencies
          </Button>
        )}

        {onClearData && latestRun && !live && !queued && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant={clearArmed ? "destructive" : "outline"}
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    if (clearArmed) { setClearArmed(false); onClearData(); } else setClearArmed(true);
                  }}
                />
              }
            >
              <Trash2 aria-hidden="true" className="size-4" />
              {clearArmed ? "Confirm: delete all crawl data" : "Clear crawl data"}
            </TooltipTrigger>
            <TooltipContent>Delete every crawled page, its history and the crawl logs. Settings are kept. This cannot be undone.</TooltipContent>
          </Tooltip>
        )}

        {onFreshCrawl && latestRun && !live && !queued && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant={armed ? "default" : "outline"}
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    if (armed) { setArmed(false); onFreshCrawl(); } else setArmed(true);
                  }}
                />
              }
            >
              <RefreshCw aria-hidden="true" className="size-4" />
              {armed ? "Confirm: crawl every page" : "Fresh crawl"}
            </TooltipTrigger>
            <TooltipContent>Fetch every page again in full, whatever its frequency. Uses crawl budget for the whole site.</TooltipContent>
          </Tooltip>
        )}

        {onCrawlNow && (
          <Button type="button" size="sm" onClick={onCrawlNow} disabled={busy || live || queued}>
            {queued ? "Queued…" : live ? "Crawling…" : "Crawl now"}
          </Button>
        )}
      </div>
  );
}
