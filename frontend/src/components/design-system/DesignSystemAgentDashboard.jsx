"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight, CalendarClock, History, Layers, ListChecks, Palette, Pause, Play } from "lucide-react";
import useSWR from "swr";

import { Button, buttonVariants } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/page-header";
import { EmptyState, Panel, RowList } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { StatTile } from "@/components/ui/stat-tile";
import { AgentHeadView, AgentLimits, AgentPageSkeleton, AgentStats, AgentStatus, CrawlerLink } from "@/components/agents/AgentPage";
import { PagePicker } from "@/components/brand/PagePicker";
import * as setupApi from "@/lib/api/agentSetup";
import { brandPath } from "@/lib/api/brand";
import { RUN_STATUS_LABELS, TERMINAL_RUN_STATUSES } from "@/lib/agents/runEvents";
import { useAgentWork } from "@/lib/agents/useAgentWork";
import { DESIGN_SYSTEM_AGENT_SLUG, MAX_DESIGN_PAGES } from "@/lib/brand/brand";
import { formatDate, pathOf } from "@/lib/format";
import { ago, fromNow, plural } from "@/lib/home/home";
import { useCan } from "@/lib/workspaces/roles";

/** What setting the agent to work means, in one sentence: the cadence is the agent's own, not a choice. */
const CADENCE = "Once a week it checks whether your site's styling changed, and derives the system again only if it did.";

/** What the agent can and cannot do, folded at the foot of the page. */
const LIMITS = Object.freeze([
  `It renders up to ${MAX_DESIGN_PAGES} of your crawled pages in a real browser, at desktop and phone widths, and measures what is painted.`,
  "Every value it writes says whether it was observed on your site, derived from several values, or proposed to fill a gap.",
  "A value you correct on the Brand page is pinned, and kept through every later derivation.",
  "The weekly check fingerprints your styling first; when nothing changed it stops in seconds without rendering or asking a model.",
  "It reads your site and never changes it.",
]);

/** How a run was started, in the words the runs list uses. */
const TRIGGERS = Object.freeze({ manual: "by hand", schedule: "on schedule", event: "after a crawl" });

/** The tone of each run status in the runs list. */
const RUN_TONES = Object.freeze({ succeeded: "neutral", failed: "coral", cancelled: "muted", running: "lime", queued: "lime" });

/**
 * The Design system agent's own page: how it is set up, when it runs, and how its runs went.
 *
 * What the agent produces — the design system — is the Brand page, where a person reads, corrects
 * and copies it out; this page links there rather than drawing it again. What is here is the agent:
 * the pages it renders (the one setting it has), whether it is set to work and when it next checks,
 * and its recent runs.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 */
export function DesignSystemAgentDashboard({ workspaceId }) {
  const [editingPages, setEditingPages] = useState(false);
  const canEdit = useCan("member", workspaceId);
  const brandRead = useSWR(brandPath(workspaceId));
  const work = useAgentWork({
    workspaceId,
    agentSlug: DESIGN_SYSTEM_AGENT_SLUG,
    // A finished run replaced the system the stats and the Brand page show.
    onFinished: brandRead.mutate,
  });

  if (work.loading && !work.agent) return <AgentPageSkeleton label="Loading the Design system agent" stats={3} />;

  const { readiness, setup, inFlight, working, busy } = work;
  const brand = brandRead.data?.brand ?? null;
  const ready = Boolean(readiness?.crawled && readiness.markdownPages > 0);
  const chosen = setup?.pages ?? [];
  const runs = work.runs ?? [];
  const lastFinished = runs.find((entry) => TERMINAL_RUN_STATUSES.includes(entry.status)) ?? null;
  const brandHref = `/workspaces/${workspaceId}/brand`;

  async function savePages(pages) {
    const response = await setupApi.saveAgentSetup(workspaceId, DESIGN_SYSTEM_AGENT_SLUG, { pages });
    await work.adoptSetup(response.setup);
    setEditingPages(false);
  }

  return (
    <div className="space-y-10">
      <AgentHeadView
        work={work}
        workspaceId={workspaceId}
        agentSlug={DESIGN_SYSTEM_AGENT_SLUG}
        fallbackName="Design system"
        ready={ready}
        // Started by hand, a run skips the weekly "has the styling changed" check: somebody asking
        // for a derivation wants one, not a second's answer that nothing moved.
        runInput={{ force: true }}
        // The switch is in the Schedule section below, with what it means.
        switchable={false}
        status={work.loading ? <Skeleton className="h-5 w-20 rounded-full bg-orb-raised/70" /> : (
          <AgentStatus ready={ready} notReadyLabel="Not set up" working={working} inFlight={inFlight} failed={lastFinished?.status === "failed"} switchable />
        )}
        workingMessage={CADENCE}
        pausedMessage="Paused: the system is left as it is until you run it or set it to work."
        notReadyMessage="This agent renders pages your crawler found. Crawl your site first, then run it."
        notReadyAction={<CrawlerLink workspaceId={workspaceId} />}
        actions={(
          <Link href={brandHref} className={buttonVariants({ size: "sm", variant: "ghost" })}>
            <Palette className="size-3.5" /> Open the brand
          </Link>
        )}
      />

      <AgentStats columns={3} data-testid="design-system-headline">
        <StatTile
          href={brand?.system ? brandHref : undefined}
          icon={Palette}
          label="Design system"
          value={brandRead.data ? (brand?.system ? `v${brand.revision}` : "—") : "…"}
          detail={brand?.system ? `Derived ${ago(brand.derivedAt)} from ${plural(brand.pages?.length ?? 0, "page")}` : brandRead.error ? "Could not be read" : "Not derived yet"}
        />
        <StatTile
          icon={Layers}
          label="Pages to render"
          value={chosen.length ? chosen.length.toLocaleString() : "Auto"}
          detail={chosen.length ? `Chosen by you, of ${MAX_DESIGN_PAGES} at most` : `The agent picks up to ${MAX_DESIGN_PAGES}`}
        />
        <StatTile
          icon={CalendarClock}
          label="Schedule"
          value={working ? "Weekly" : "Paused"}
          tone={working ? "good" : null}
          detail={working ? (setup?.nextRunAt ? `Next check ${fromNow(setup.nextRunAt)}` : "Checks once a week") : "Runs only when started by hand"}
        />
      </AgentStats>

      <section aria-labelledby="ds-schedule" className="space-y-3">
        <SectionHeading id="ds-schedule">Schedule</SectionHeading>
        <Panel className="flex flex-wrap items-start gap-x-6 gap-y-4">
          <dl className="grid min-w-[14rem] flex-1 grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-orb-muted">State</dt>
            <dd className="text-orb-white">{working ? "Set to work" : "Paused"}</dd>
            <dt className="text-orb-muted">How often</dt>
            <dd className="text-orb-gray">{CADENCE}</dd>
            <dt className="text-orb-muted">Next check</dt>
            <dd className="text-orb-gray">{working && setup?.nextRunAt ? `${formatDate(setup.nextRunAt)} (${fromNow(setup.nextRunAt)})` : working ? "At the scheduler's next pass" : "None while paused"}</dd>
            <dt className="text-orb-muted">Last run</dt>
            <dd className="text-orb-gray">
              {lastFinished ? `${formatDate(lastFinished.finishedAt ?? lastFinished.startedAt)} · ${(RUN_STATUS_LABELS[lastFinished.status] ?? lastFinished.status).toLowerCase()}` : "Never run"}
            </dd>
          </dl>
          {canEdit ? (
            <Button type="button" size="sm" variant={working ? "outline" : "default"} onClick={work.toggleWorking} disabled={busy || !ready}>
              {working ? <><Pause className="size-3.5" /> Pause</> : <><Play className="size-3.5" /> Set to work</>}
            </Button>
          ) : (
            <p className="text-compact text-orb-muted">A member of this workspace sets it to work.</p>
          )}
        </Panel>
      </section>

      <section aria-labelledby="ds-pages" className="space-y-3">
        <SectionHeading
          id="ds-pages"
          aside={chosen.length ? `${chosen.length} of ${MAX_DESIGN_PAGES}` : "chosen by the agent"}
          action={canEdit ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setEditingPages(true)} disabled={busy || inFlight || !ready}>
              <ListChecks className="size-3.5" /> Edit pages
            </Button>
          ) : null}
        >
          Pages to render
        </SectionHeading>
        {chosen.length ? (
          <RowList>
            {chosen.map((page) => (
              <li key={page.key ?? page.url} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2.5 sm:px-4">
                <span className="min-w-[11rem] flex-1 text-sm text-orb-white">{page.label || pathOf(page.url)}</span>
                {page.pattern && <span className="font-mono text-xs text-orb-muted">{page.pattern}</span>}
                <a href={page.url} target="_blank" rel="noreferrer" className="break-all font-mono text-xs text-orb-gray hover:text-orb-cyan hover:underline">{pathOf(page.url)}</a>
              </li>
            ))}
          </RowList>
        ) : (
          <EmptyState icon={Layers}>
            No pages chosen, so the agent picks its own: your home page and the most linked-to page of each of your
            main route patterns, up to {MAX_DESIGN_PAGES}. Choose pages that look different from each other — a
            landing page, a page with a form, an article — to steer what it measures.
          </EmptyState>
        )}
      </section>

      <section aria-labelledby="ds-runs" className="space-y-3">
        <SectionHeading id="ds-runs" aside={runs.length ? `the last ${plural(runs.length, "run")}` : null}>
          <span className="inline-flex items-center gap-2"><History aria-hidden="true" className="size-4 text-orb-muted" /> Recent runs</span>
        </SectionHeading>
        {runs.length ? (
          <RowList>
            {runs.map((entry) => <RunRow key={entry.id} run={entry} ready={ready} />)}
          </RowList>
        ) : (
          <EmptyState icon={History}>No runs yet. Run it now, or set it to work and it runs within the scheduler&apos;s next pass.</EmptyState>
        )}
      </section>

      <Panel className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-orb-line bg-orb-space/70 text-orb-lime">
          <Palette className="size-4" />
        </span>
        <p className="min-w-[11rem] flex-1 text-sm text-orb-gray">
          What this agent derives is your <span className="text-orb-white">Brand</span>: colours, type, logos, imagery and components, to read,
          correct and copy out. Earlier versions are kept there, under History.
        </p>
        <Link href={brandHref} className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-orb-cyan underline-offset-4 hover:text-orb-white hover:underline">
          Open the brand <ArrowUpRight aria-hidden="true" className="size-3.5" />
        </Link>
      </Panel>

      <AgentLimits items={LIMITS} />

      <Sheet open={editingPages && canEdit} onOpenChange={(next) => { if (!next) setEditingPages(false); }}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 border-orb-line bg-orb-space p-0 sm:w-[75%] sm:min-w-[44rem] data-[side=right]:sm:max-w-[80rem]">
          <SheetHeader className="gap-1 border-b border-orb-line p-5 pr-14">
            <SheetTitle className="font-display text-base font-bold text-orb-white">Pages to render</SheetTitle>
            <SheetDescription className="text-orb-muted">
              Choose up to {MAX_DESIGN_PAGES} pages, or none. Pick pages that show different things: a landing page, a page with a form, an article.
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-5">
            {editingPages && (
              <PagePicker
                workspaceId={workspaceId}
                initialPages={chosen}
                readiness={readiness}
                onSave={savePages}
                onCancel={() => setEditingPages(false)}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** One run in the recent-runs list: how it ended, when and how it started, and what it rendered. */
function RunRow({ run, ready }) {
  const at = run.finishedAt ?? run.startedAt;
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2.5 sm:px-4">
      <Pill tone={RUN_TONES[run.status] ?? "neutral"} dot={run.status === "running" || run.status === "queued"} pulse={run.status === "running"}>
        {RUN_STATUS_LABELS[run.status] ?? run.status}
      </Pill>
      <div className="min-w-[11rem] flex-1">
        <p className="text-compact text-orb-gray">{outcomeLine(run, ready)}</p>
        {run.status === "failed" && run.error?.message && <p className="mt-0.5 text-xs text-orb-coral">{run.error.message}</p>}
      </div>
      <p className="text-xs text-orb-muted">
        {at ? formatDate(at) : "Not started"}
        {TRIGGERS[run.trigger] && ` · ${TRIGGERS[run.trigger]}`}
        {run.input?.force && " · forced"}
        {Number.isFinite(run.durationMs) && ` · ${duration(run.durationMs)}`}
      </p>
    </li>
  );
}

/** What a run came to, from the counts its result carries. */
function outcomeLine(run, ready) {
  if (run.status === "queued") return "Waiting to start";
  if (run.status === "running") return "Rendering and measuring your pages";
  if (run.status === "cancelled") return "Stopped before it finished";
  if (run.status === "failed") return "Did not finish";
  const summary = run.outcome?.summary;
  if (!summary) return "Finished";
  if (!summary.pages) return ready ? "Nothing rendered: the site's styling had not changed" : "Nothing rendered: no crawled pages";
  const parts = [`Rendered ${summary.rendered} of ${plural(summary.pages, "page")}`];
  if (summary.blocked) parts.push(`${summary.blocked} blocked`);
  if (summary.colors) parts.push(plural(summary.colors, "colour"));
  if (summary.families) parts.push(plural(summary.families, "typeface"));
  if (summary.logos) parts.push(plural(summary.logos, "logo"));
  return parts.join(" · ");
}

/** A run's length, to the second under a minute and to the minute above. */
function duration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}
