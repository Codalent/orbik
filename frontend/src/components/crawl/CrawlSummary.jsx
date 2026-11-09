"use client";

import { Gauge } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { StatTile } from "@/components/ui/stat-tile";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDate } from "@/lib/crawl/format";
import { isUnlimited } from "@/lib/crawl/budget";
import { cn } from "@/lib/utils";

/**
 * What the crawl found, as the headline figures every agent page opens with (`StatTile`).
 *
 * These five figures are the answer to "is my site healthy", which is the question the whole
 * screen exists to answer. Two of them — broken pages and pages nothing links to — are findings
 * rather than statistics: their tile takes the colour of a failure or of something wanting a look
 * the moment the count is not zero, so a site with problems looks different from across the room
 * and a clean one stays quiet.
 *
 * Every figure carries a line saying what it counts, because these counts are not
 * self-explanatory and guessing at them is worse than not reading them: "pages" and "crawled"
 * differ by duplicates and by budget, and nothing in the words says so.
 *
 * @param {object} props
 * @param {{total: number, pages: number, duplicates: number, orphans: number}} props.urls registry totals
 * @param {object} props.counters the latest run's counters
 * @param {{allowance: number|null, consumed: number, remaining: number|null, unlimited?: boolean, resetsAt: string}|null} props.budget
 *   the account's crawl budget for the current month; `allowance` and `remaining` are null when it is unlimited
 * @param {string|null} props.notice transient message about the last action
 * @param {string|null} props.error a message about something that failed
 * @param {string|null} props.runError the reason the last run ended badly
 */
export function CrawlSummary({ urls, counters, budget, notice, error, runError }) {
  const broken = counters.pagesBroken ?? 0;
  const orphans = urls.orphans ?? 0;
  const figures = [
    { label: "Pages", value: urls.pages ?? urls.total, detail: "Distinct pages, duplicates folded in" },
    { label: "Crawled", value: counters.pagesFetched ?? 0, detail: "Fetched by the last crawl" },
    { label: "Duplicate URLs", value: urls.duplicates ?? 0, detail: "Lead to a page already counted" },
    { label: "Broken", value: broken, detail: "Answered with an error", tone: broken > 0 ? "failed" : null },
    { label: "Nothing links here", value: orphans, detail: "Reached by the sitemap alone", tone: orphans > 0 ? "attention" : null },
  ];

  return (
    <section aria-label="Crawl summary" className="space-y-3 px-6 pb-2 pt-5">
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && <p role="status" className="text-sm text-orb-cyan">{notice}</p>}
      {runError && <p role="status" className="text-sm text-orb-coral">{runError}</p>}

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {figures.map((figure) => (
          <li key={figure.label} className="flex min-w-0">
            <StatTile className="flex-1" label={figure.label} value={figure.value.toLocaleString()} detail={figure.detail} tone={figure.tone} />
          </li>
        ))}
      </ul>

      {budget && <BudgetRow budget={budget} />}
    </section>
  );
}

/**
 * The month's crawl budget, read as a fuel gauge rather than a progress bar.
 *
 * It sits under the figures because it is the constraint they are measured against: how much of
 * the site got crawled and how much budget is left are one story. It stays quieter than they are
 * — there is nothing to do about it from this screen — until it runs out, at which point it is the
 * only coloured thing on the panel.
 */
function BudgetRow({ budget }) {
  const { allowance, consumed, remaining, resetsAt } = budget;
  const frame = "flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-orb-line bg-orb-space/50 px-4 py-2.5";
  // With no monthly limit there is nothing to run out of, so the gauge would measure nothing: the
  // row says what this month has fetched, and that there is no ceiling.
  if (isUnlimited(budget)) {
    return (
      <div className={frame}>
        <Gauge aria-hidden="true" className="size-4 shrink-0 text-orb-muted" />
        <p className="text-compact text-orb-muted">
          <span className="font-medium tabular-nums text-orb-white">{consumed.toLocaleString()}</span>{" "}
          pages fetched this month · no monthly limit
        </p>
      </div>
    );
  }
  const used = allowance > 0 ? Math.min(100, (consumed / allowance) * 100) : 0;
  const exhausted = remaining <= 0;

  return (
    <div className={cn(frame, exhausted && "border-orb-coral/40")}>
      <Gauge aria-hidden="true" className={exhausted ? "size-4 shrink-0 text-orb-coral" : "size-4 shrink-0 text-orb-muted"} />

      {exhausted ? (
        <p className="text-sm text-orb-coral">
          Crawl budget spent. Crawling resumes {formatDate(resetsAt)}, or add more pages to continue now.
        </p>
      ) : (
        <>
          <Tooltip>
            <TooltipTrigger className="text-left text-compact text-orb-muted focus-visible:outline-2 focus-visible:outline-orb-lime">
              <span className="font-medium tabular-nums text-orb-white">
                {remaining.toLocaleString()}
              </span>{" "}
              <span className="border-b border-dotted border-orb-line">pages left this month</span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              One page fetched spends one page of budget, across every site in your account. Finding URLs costs nothing.
            </TooltipContent>
          </Tooltip>

          <span
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={allowance}
            aria-valuenow={consumed}
            aria-label="Crawl budget used this month"
            className="h-1.5 w-full min-w-32 max-w-64 flex-1 overflow-hidden rounded-full bg-orb-line"
          >
            <span className="block h-full rounded-full bg-orb-gray" style={{ width: `${used}%` }} />
          </span>

          <p className="text-xs text-orb-muted">
            <span className="tabular-nums">{consumed.toLocaleString()}</span> used · renews {formatDate(resetsAt)}
          </p>
        </>
      )}
    </div>
  );
}
