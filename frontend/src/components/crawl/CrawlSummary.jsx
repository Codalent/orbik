"use client";

import Link from "next/link";
import { Gauge } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { StatTile } from "@/components/ui/stat-tile";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatBudgetDay } from "@/lib/crawl/format";
import { BUDGET_STATE, budgetStateOf, isUnlimited } from "@/lib/crawl/budget";
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
 * @param {{state?: string, allowance: number|null, consumed: number, remaining: number|null, unlimited?: boolean,
 *   planAllowance?: number|null, resetsAt: string, resumesAt?: string|null}|null} props.budget
 *   the workspace's crawl budget for the current month; `allowance` and `remaining` are null when it
 *   is unlimited, and `state` says whether it is spent or includes no pages at all
 * @param {string|null} props.notice transient message about the last action
 * @param {string|null} props.error a message about something that failed
 * @param {string|null} props.runError the reason the last run ended badly
 * @param {string|null} [props.runNote] something about the last run worth a look that is not a
 *   failure, such as pages it left for want of crawl pages
 * @param {"broken"|"orphans"|"duplicates"|null} [props.finding] the figure whose pages are listed
 * @param {(kind: string|null) => void} [props.onFinding] lists one figure's pages, or the tree again
 * @param {{label: string, href: string, external: boolean}|null} [props.budgetLink] where more crawl
 *   pages are got, when the install offers somewhere
 */
export function CrawlSummary({ urls, counters, budget, notice, error, runError, runNote = null, finding = null, onFinding, budgetLink = null }) {
  // Counted over the pages as they stand, by the same filter as the list a press opens; an API
  // from before that count existed is read from the last run's counters instead.
  const broken = urls.broken ?? counters.pagesBroken ?? 0;
  const orphans = urls.orphans ?? 0;
  const figures = [
    { label: "Pages", value: urls.pages ?? urls.total, detail: "Distinct pages, duplicates folded in" },
    { label: "Crawled", value: counters.pagesFetched ?? 0, detail: "Fetched by the last crawl" },
    { label: "Duplicate URLs", kind: "duplicates", value: urls.duplicates ?? 0, detail: "Lead to a page already counted" },
    { label: "Broken", kind: "broken", value: broken, detail: "Answered with an error when last fetched", tone: broken > 0 ? "failed" : null },
    { label: "Nothing links here", kind: "orphans", value: orphans, detail: "Reached by the sitemap alone", tone: orphans > 0 ? "attention" : null },
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
      {runNote && <p role="status" className="text-sm text-orb-orange">{runNote}</p>}

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {figures.map((figure) => {
          const pressed = Boolean(figure.kind) && finding === figure.kind;
          // A finding with something in it opens its pages below; pressed again, the tree comes
          // back. A figure of zero has nothing to list, and a count is not a button.
          const actionable = Boolean(figure.kind && onFinding) && (figure.value > 0 || pressed);
          const tile = (
            <StatTile
              className={cn("flex-1", actionable && "transition-colors group-hover/tile:border-orb-muted/50 group-hover/tile:bg-orb-raised/70", pressed && "border-orb-muted bg-orb-raised/70")}
              label={figure.label}
              value={figure.value.toLocaleString()}
              detail={pressed ? "Listed below. Press again for every page." : figure.detail}
              tone={figure.tone}
            />
          );
          return (
            <li key={figure.label} className="flex min-w-0">
              {actionable ? (
                <button
                  type="button"
                  aria-pressed={pressed}
                  title={pressed ? "Show every page" : `List these ${figure.value.toLocaleString()} pages`}
                  onClick={() => onFinding(pressed ? null : figure.kind)}
                  className="group/tile flex min-w-0 flex-1 cursor-pointer rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                >
                  {tile}
                </button>
              ) : tile}
            </li>
          );
        })}
      </ul>

      {budget && <BudgetRow budget={budget} link={budgetLink} />}
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
function BudgetRow({ budget, link }) {
  const { allowance, consumed, remaining, resetsAt } = budget;
  const state = budgetStateOf(budget);
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
  const exhausted = state === BUDGET_STATE.spent || state === BUDGET_STATE.notIncluded;
  // Only a date that is true: the API gives one when the next month will have pages to fetch.
  const resumes = budget.resumesAt ? formatBudgetDay(budget.resumesAt) : null;
  // Somewhere to get more pages, when the install has one; otherwise nothing is offered.
  const more = link
    ? (
      <Link
        href={link.href}
        {...(link.external ? { target: "_blank", rel: "noreferrer" } : {})}
        className="font-medium text-orb-cyan underline-offset-4 hover:underline"
      >
        {link.label}
      </Link>
    )
    : null;

  return (
    <div className={cn(frame, exhausted && "border-orb-coral/40")}>
      <Gauge aria-hidden="true" className={exhausted ? "size-4 shrink-0 text-orb-coral" : "size-4 shrink-0 text-orb-muted"} />

      {state === BUDGET_STATE.notIncluded ? (
        // Nothing was spent: the plan has no crawl pages. No "resumes" unless a month with pages
        // is coming.
        <p className="text-sm text-orb-coral">
          This workspace&apos;s plan includes no crawl pages, so nothing can be fetched.
          {resumes && ` Crawling can start ${resumes}.`}
          {more && <> {more}</>}
        </p>
      ) : exhausted ? (
        <p className="text-sm text-orb-coral">
          All {(allowance ?? 0).toLocaleString()} crawl pages this month are spent.
          {resumes && ` Crawling resumes ${resumes}.`}
          {more && <> {more}</>}
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
              One page fetched spends one page of this workspace&apos;s budget, whichever site it is on. Finding URLs costs nothing.
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
            <span className="tabular-nums">{consumed.toLocaleString()}</span> used
            {/* A plan that has stopped including pages does not renew them. */}
            {budget.planAllowance === 0 ? " · none next month" : ` · renews ${formatBudgetDay(resetsAt)}`}
          </p>
        </>
      )}
    </div>
  );
}
