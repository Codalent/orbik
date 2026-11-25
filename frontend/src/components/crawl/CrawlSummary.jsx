"use client";

import Link from "next/link";
import { Gauge } from "lucide-react";

import { StatTile } from "@/components/ui/stat-tile";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatBudgetDay } from "@/lib/crawl/format";
import { BUDGET_STATE, budgetStateOf, isUnlimited } from "@/lib/crawl/budget";
import { useExtensionSlots } from "@/lib/extensions/slots";
import { cn } from "@/lib/utils";

/**
 * Where more crawl pages are got, when an installed extension says (`crawlBudgetLink`): a path
 * inside the workspace or an https address. Null in the open-source edition, which has no limit.
 *
 * @returns {{label: string, href: string, external: boolean}|null}
 */
export function useCrawlBudgetLink(workspaceId) {
  const link = useExtensionSlots().crawlBudgetLink;
  if (!link) return null;
  const external = /^https:\/\//.test(link.path);
  return {
    label: link.label,
    external,
    href: external ? link.path : `/workspaces/${workspaceId}/${link.path.replace(/^\/+/, "")}`,
  };
}

/**
 * The five figures a crawl leaves, with the tone each one is shown in: the count of pages, what
 * the last crawl fetched, and the three findings a press lists (`kind`, the API's
 * `GET /crawl/findings?kind=`).
 *
 * The tones carry the colours' fixed meanings (docs/architecture/ui.md), so the row reads as the
 * site's health at a glance: lime for a crawl that finished, cyan for duplicate URLs (worth
 * knowing; they are folded into their page and cost nothing), orange for pages nothing links to
 * (worth a look), coral for broken pages. A finding of zero stays quiet: a clean site is not a
 * row of colour.
 *
 * @param {{total: number, pages?: number, duplicates?: number, orphans?: number, broken?: number}} urls registry totals
 * @param {object} counters the latest run's counters
 * @param {string|null} [runStatus] how the latest run ended, or `running`
 * @returns {Array<{label: string, kind?: string, value: number, detail: string, tone: string|null, live?: boolean}>}
 */
export function crawlFigures(urls, counters, runStatus = null) {
  // Counted over the pages as they stand, by the same filter as the list a press opens; an API
  // from before that count existed is read from the last run's counters instead.
  const broken = urls.broken ?? counters.pagesBroken ?? 0;
  const orphans = urls.orphans ?? 0;
  const duplicates = urls.duplicates ?? 0;
  const fetched = counters.pagesFetched ?? 0;
  return [
    { label: "Pages", value: urls.pages ?? urls.total, detail: "Distinct pages, duplicates folded in", tone: null },
    {
      label: "Crawled",
      value: fetched,
      detail: runStatus === "running" ? "Fetched so far by this crawl" : "Fetched by the last crawl",
      live: runStatus === "running",
      tone: runStatus === "failed" ? "failed" : runStatus === "succeeded" && fetched > 0 ? "good" : null,
    },
    { label: "Duplicate URLs", kind: "duplicates", value: duplicates, detail: "Lead to a page already counted", tone: duplicates > 0 ? "info" : null },
    { label: "Broken", kind: "broken", value: broken, detail: "Answered with an error when last fetched", tone: broken > 0 ? "failed" : null },
    { label: "Nothing links here", kind: "orphans", value: orphans, detail: "Reached by the sitemap alone", tone: orphans > 0 ? "attention" : null },
  ];
}

/**
 * What the crawl found, as the headline figures a source's overview opens with (`StatTile`).
 *
 * These five figures are the answer to "is my site healthy", the question the overview exists to
 * answer, and each is coloured by what it means (`crawlFigures`). A finding with pages in it is a
 * link to the Pages tab listing them.
 *
 * Every figure carries a line saying what it counts, because these counts are not
 * self-explanatory and guessing at them is worse than not reading them: "pages" and "crawled"
 * differ by duplicates and by budget, and nothing in the words says so.
 *
 * @param {object} props
 * @param {{total: number, pages: number, duplicates: number, orphans: number}} props.urls registry totals
 * @param {object} props.counters the latest run's counters
 * @param {string|null} [props.runStatus] how the latest run ended, or `running` while one is
 * @param {{state?: string, allowance: number|null, consumed: number, remaining: number|null, unlimited?: boolean,
 *   planAllowance?: number|null, resetsAt: string, resumesAt?: string|null}|null} props.budget
 *   the workspace's crawl budget for the current month; `allowance` and `remaining` are null when it
 *   is unlimited, and `state` says whether it is spent or includes no pages at all
 * @param {(kind: string) => string} [props.findingHref] where a finding's pages are listed
 * @param {{label: string, href: string, external: boolean}|null} [props.budgetLink] where more crawl
 *   pages are got, when the install offers somewhere
 */
export function CrawlSummary({ urls, counters, runStatus = null, budget, findingHref, budgetLink = null, className }) {
  const figures = crawlFigures(urls, counters, runStatus);

  return (
    <section aria-label="Crawl summary" className={cn("space-y-3", className)}>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {figures.map((figure) => (
          <li key={figure.label} className="flex min-w-0">
            <StatTile
              className="flex-1"
              // A figure of zero has nothing to list, and a count is not a link.
              href={figure.kind && findingHref && figure.value > 0 ? findingHref(figure.kind) : undefined}
              label={figure.label}
              value={figure.value.toLocaleString()}
              detail={figure.detail}
              tone={figure.tone}
              live={figure.live}
            />
          </li>
        ))}
      </ul>

      {budget && <BudgetRow budget={budget} link={budgetLink} />}
    </section>
  );
}

/** How much of the month's budget is spent before the gauge turns orange, in per cent. */
const LOW_BUDGET_SHARE = 80;

/**
 * The month's crawl budget, read as a fuel gauge rather than a progress bar.
 *
 * It sits under the figures because it is the constraint they are measured against: how much of
 * the site got crawled and how much budget is left are one story. The gauge is lime while most of
 * the month is left, orange once four fifths are spent, and the row turns coral when nothing is.
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
  const low = used >= LOW_BUDGET_SHARE;
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
    <div className={cn(frame, exhausted ? "border-orb-coral/40 bg-orb-coral/5" : low && "border-orb-orange/35")}>
      <Gauge aria-hidden="true" className={cn("size-4 shrink-0", exhausted ? "text-orb-coral" : low ? "text-orb-orange" : "text-orb-lime")} />

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
              <span className={cn("font-medium tabular-nums", low ? "text-orb-orange" : "text-orb-white")}>
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
            {/* At least a sliver once anything is spent, so a month that has fetched a page or two
                does not look untouched. */}
            <span className={cn("block h-full rounded-full", low ? "bg-orb-orange" : "bg-orb-lime")} style={{ width: consumed > 0 ? `max(${used}%, 0.375rem)` : "0" }} />
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
