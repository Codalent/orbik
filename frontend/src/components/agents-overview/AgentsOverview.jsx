"use client";

import Link from "next/link";
import useSWR from "swr";
import { ArrowRight, Bot, CalendarClock, CircleAlert, Loader, Waypoints } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageHeader, SectionHeading } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { StatTile } from "@/components/ui/stat-tile";
import { AGENT_STATUS, buildAgentRows } from "@/lib/agents/registry";
import { agentOverviewPath } from "@/lib/api/agentOverview";
import { AGENTS_PATH } from "@/lib/api/runs";
import { useCrawlOverview } from "@/lib/crawl/useCrawlOverview";
import { useExtensionSlots } from "@/lib/extensions/slots";
import { fromNow, plural } from "@/lib/home/home";
import { useCan } from "@/lib/workspaces/roles";
import { AgentCard } from "./AgentCard";

/** How often the overview is read again while something is running, and otherwise. */
const LIVE_MS = 5000;
const IDLE_MS = 30_000;

/**
 * The Crawler's one line. It is not in the agent catalog — it is the crawl itself, not a
 * definition a run follows — so the overview words it here.
 */
const CRAWLER_SUMMARY = "Fetches every page of your site on a schedule and keeps each one as Markdown: what every other agent, and the Library, read.";

/**
 * What a card says in place of a last run while its agent is not set up: what it is waiting for.
 * The state itself is the registry's; this only words what that state means for each agent.
 */
const UNCONFIGURED_HINT = Object.freeze({
  crawler: "Set up the crawl of your site to start",
});
const DEFAULT_HINT = "Starts once your site has been crawled";

/**
 * The Agents overview: every agent in the workspace on one page — what each does, whether it is
 * working, how its last run went and when it runs next.
 *
 * The agents are the sidebar's (`buildAgentRows`), built from the same read the shell makes for
 * it — the crawl — from the same cache, so a card's state and the sidebar row beside it are one
 * answer. The rest is one read for every agent (`GET …/agents`: newest run, schedule) and the agent
 * catalog for each line of what it does. The Crawler's last and next crawl come from the crawl
 * overview, which is where crawls are recorded.
 *
 * Cards are grouped by what somebody should do about them: agents whose last run failed first,
 * then the ones that are ready, then the ones not set up yet. The page
 * has no buttons that start or switch anything: each card opens its agent's page, where those are,
 * so a read-only person sees exactly what everybody else does.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 */
export function AgentsOverview({ workspaceId }) {
  const canEdit = useCan("member", workspaceId);
  const { crawl, failed: crawlFailed } = useCrawlOverview(workspaceId);
  const catalog = useSWR(AGENTS_PATH);
  const { agentPages } = useExtensionSlots();
  const overview = useSWR(agentOverviewPath(workspaceId), {
    refreshInterval: (latest) => (latest?.items?.some((item) => ["queued", "running"].includes(item.latestRun?.status)) ? LIVE_MS : IDLE_MS),
  });

  const settled = (crawl || crawlFailed) && (overview.data || overview.error);
  const rows = buildAgentRows(workspaceId, crawl, agentPages);
  const agents = rows.map((row) => withFigures(row, { crawl, catalog: catalog.data, overview: overview.data, overviewFailed: Boolean(overview.error) && !overview.data }));
  const groups = groupAgents(agents);
  const totals = headline(agents);
  const noCrawl = crawl && !crawl.site;
  const firstCrawl = crawl?.site && !crawl.latestRun;

  return (
    <main aria-labelledby="agents-title" className="mx-auto w-full max-w-6xl min-w-0 space-y-8 px-4 pb-14 pt-6 md:px-8 md:pt-8">
      <PageHeader
        id="agents-title"
        icon={Bot}
        title="Agents"
        description="Every agent working on this workspace: what each one does, how its last run went, and when it runs next. Open one to see its work."
        meta={settled ? <span>{plural(agents.length, "agent")} · {plural(totals.ready, "ready", "ready")} · {plural(totals.unconfigured, "not set up", "not set up")}</span> : null}
      />

      {overview.error && !overview.data && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>Last runs and schedules could not be read. Each agent&apos;s state below is still current; refresh to try again.</AlertDescription>
        </Alert>
      )}

      {!settled ? (
        <OverviewSkeleton />
      ) : (
        <>
          {/* Before the first crawl every figure would be a zero; the note below says why instead. */}
          {!noCrawl && <div className="grid min-w-0 gap-3 sm:grid-cols-3">
            <StatTile
              icon={Loader}
              label="Working now"
              value={totals.working.toLocaleString()}
              detail={totals.working ? names(totals.workingNames) : "nothing running"}
              live={totals.working > 0}
            />
            <StatTile
              href={totals.failed ? "#agents-attention" : undefined}
              icon={CircleAlert}
              label="Failed last runs"
              value={totals.failed.toLocaleString()}
              detail={totals.failed ? names(totals.failedNames) : "no failures"}
              tone={totals.failed ? "failed" : null}
            />
            <StatTile
              icon={CalendarClock}
              label="Set to work"
              value={totals.scheduled.toLocaleString()}
              detail={totals.soonest ? `next: ${totals.soonest.name} ${fromNow(totals.soonest.at)}` : totals.scheduled ? "nothing due" : "none on a schedule"}
            />
          </div>}

          {(noCrawl || firstCrawl) && <CrawlFirst workspaceId={workspaceId} crawling={Boolean(crawl?.activeRun || crawl?.queued)} canEdit={canEdit} />}

          {groups.attention.length > 0 && (
            <Group id="agents-attention" title="Needs a look" aside={`${plural(groups.attention.length, "agent")} with a failed run`} agents={groups.attention} />
          )}
          {groups.ready.length > 0 && (
            <Group id="agents-ready" title="Ready" aside={groups.attention.length ? "nothing waiting on you" : "nothing waiting on you from any agent"} agents={groups.ready} />
          )}
          {groups.unconfigured.length > 0 && (
            <Group id="agents-unconfigured" title="Not set up yet" aside={noCrawl ? "most agents read the crawl of your site" : null} agents={groups.unconfigured} />
          )}
        </>
      )}
    </main>
  );
}

/** One group of cards under its heading. */
function Group({ id, title, aside, agents }) {
  return (
    <section aria-labelledby={`${id}-title`} id={id} className="scroll-mt-20 space-y-3">
      <SectionHeading id={`${id}-title`} aside={aside}>{title}</SectionHeading>
      {/* Two columns on a phone turned sideways, one from `md` (where the sidebar takes its share), then two and three. */}
      <ul className="grid min-w-0 gap-3 sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2 xl:grid-cols-3">
        {agents.map((agent) => (
          <li key={agent.id} className="flex min-w-0">
            <AgentCard agent={agent} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Said above the cards while the site has never been crawled: nearly every agent reads the crawl,
 * so this is the one thing standing between the page and a page of results.
 */
function CrawlFirst({ workspaceId, crawling, canEdit }) {
  return (
    <Panel className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-orb-line bg-orb-space/70 text-orb-lime">
        <Waypoints className="size-4" />
      </span>
      <div className="min-w-[11rem] flex-1">
        <p className="text-sm font-medium text-orb-white">{crawling ? "The first crawl is under way" : "Your site has not been crawled yet"}</p>
        <p className="mt-0.5 text-compact text-orb-gray">
          {crawling
            ? "Most agents read what the crawler keeps. They can start as soon as it finishes."
            : canEdit
              ? "Most agents read what the crawler keeps, so they wait for the first crawl. Set it up and they can start."
              : "Most agents read what the crawler keeps, so they wait for the first crawl. Somebody with member access can set it up."}
        </p>
      </div>
      <Link
        href={`/workspaces/${workspaceId}/agents/crawler`}
        className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-orb-lime underline-offset-4 hover:underline"
      >
        {crawling || !canEdit ? "Open the Crawler" : "Set up the crawl"} <ArrowRight aria-hidden="true" className="size-3.5" />
      </Link>
    </Panel>
  );
}

/** Card-shaped placeholders while the reads are on their way. */
function OverviewSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading agents" className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((key) => <Skeleton key={key} className="h-[6.5rem] rounded-xl bg-orb-raised/50" />)}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((key) => <Skeleton key={key} className="h-36 rounded-xl bg-orb-raised/50" />)}
      </div>
    </div>
  );
}

/**
 * A sidebar row with what the overview adds to it: the catalog's line of what it does, its newest
 * run, its next run and, for the Crawler, its pages.
 */
function withFigures(row, { crawl, catalog, overview, overviewFailed }) {
  const hint = UNCONFIGURED_HINT[row.id] ?? DEFAULT_HINT;
  if (row.id === "crawler") {
    const active = crawl?.activeRun ?? null;
    const latest = active ?? crawl?.latestRun ?? null;
    return {
      ...row,
      summary: CRAWLER_SUMMARY,
      hint,
      run: crawl?.queued && !active ? { status: "queued" } : latest,
      runningWord: "Crawling",
      runNoun: "crawl",
      nextWord: "Next crawl",
      next: !active && crawl?.site?.enabled !== false ? crawl?.site?.nextCrawlAt ?? null : null,
      facts: crawl?.site && crawl.urls ? plural(crawl.urls.pages ?? crawl.urls.total ?? 0, "page") : null,
      scheduled: Boolean(crawl?.site && crawl.site.enabled !== false),
    };
  }
  const item = overview?.items?.find((entry) => entry.agentSlug === row.id) ?? null;
  const schedule = item?.schedule ?? null;
  return {
    ...row,
    summary: catalog?.items?.find((entry) => entry.slug === row.id)?.summary ?? null,
    hint,
    run: item?.latestRun ?? null,
    runUnknown: overviewFailed,
    next: schedule?.working ? schedule.nextRunAt : null,
    nextNote: scheduleNote(row, schedule),
    scheduled: Boolean(schedule?.working),
  };
}

/**
 * What a card says about its schedule when there is no next run to give: set to work but started by
 * the work before it rather than by a clock, or not set to work.
 * Nothing for an agent not set up, whose card says what it waits for instead.
 */
function scheduleNote(row, schedule) {
  if (row.status === AGENT_STATUS.unconfigured) return null;
  if (schedule?.working) return schedule.nextRunAt ? null : "Set to work";
  return "Not set to work";
}

/** The three groups, in the order the page shows them, each in the sidebar's order. */
function groupAgents(agents) {
  const attention = agents.filter(failedOf);
  const rest = agents.filter((agent) => !failedOf(agent));
  return {
    attention,
    ready: rest.filter((agent) => agent.status !== AGENT_STATUS.unconfigured),
    unconfigured: rest.filter((agent) => agent.status === AGENT_STATUS.unconfigured),
  };
}

/** Whether a card is a failure: of its state, or of its newest run. */
function failedOf(agent) {
  return agent.status === AGENT_STATUS.failed || agent.run?.status === "failed";
}

/** The headline figures, counted over the cards on the page. */
function headline(agents) {
  const working = agents.filter((agent) => agent.status === AGENT_STATUS.working || ["queued", "running"].includes(agent.run?.status));
  const failed = agents.filter(failedOf);
  const scheduled = agents.filter((agent) => agent.scheduled);
  const soonest = scheduled
    .filter((agent) => agent.next)
    .map((agent) => ({ name: agent.name, at: agent.next }))
    .sort((left, right) => new Date(left.at) - new Date(right.at))[0] ?? null;
  return {
    working: working.length,
    workingNames: working.map((agent) => agent.name),
    failed: failed.length,
    failedNames: failed.map((agent) => agent.name),
    scheduled: scheduled.length,
    soonest,
    ready: agents.filter((agent) => agent.status === AGENT_STATUS.idle || agent.status === AGENT_STATUS.working).length,
    unconfigured: agents.filter((agent) => agent.status === AGENT_STATUS.unconfigured).length,
  };
}

/** A short list of names for a tile's line: "Crawler", "Crawler and llms.txt", "Crawler and 2 more". */
function names(list) {
  if (list.length <= 2) return list.join(" and ");
  return `${list[0]} and ${list.length - 1} more`;
}
