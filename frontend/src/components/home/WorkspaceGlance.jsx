"use client";

import Link from "next/link";
import { Activity, ArrowRight, BookMarked, Bot, CircleAlert, CircleCheck, Globe } from "lucide-react";

import { buildAgentRows } from "@/lib/agents/registry";
import { humanize } from "@/lib/aiCalls/describe";
import { ago, fromNow, personName, plural } from "@/lib/home/home";
import { budgetUsedLine } from "@/lib/crawl/budget";
import { useAskPanel } from "@/lib/ask/askPanel";
import { Panel, PanelTitle } from "@/components/ui/panel";
import { StatTile } from "@/components/ui/stat-tile";
import { cn } from "@/lib/utils";

/** What a run's status reads as in the activity list. */
const RUN_STATUS = Object.freeze({
  queued: "queued",
  running: "running",
  succeeded: "finished",
  failed: "failed",
  cancelled: "stopped",
});

/**
 * The workspace at a glance: four figures across the top, then what needs attention and the
 * Library on the left, and the website, the person's own AI and what happened lately on the right.
 *
 * The figures are the page's headline — the numbers somebody opening Home wants first — and each
 * opens the page it counts. Under them the left column is what to act on and the right what to
 * keep an eye on, so the two read differently at a glance rather than as five equal boxes.
 *
 * Shown from the first visit, each card saying what will appear and when while it is empty, so a
 * new workspace's Home is not a page of zeroes. Every figure is from the same Home read as the
 * checklist. "Orbik MCP" is the signed-in person's connections and nobody else's, by the owner's
 * decision.
 *
 * @param {object} props
 * @param {object} props.home the Home read
 * @param {string|null} props.myEmail the signed-in person's address
 */
export function WorkspaceGlance({ home, myEmail }) {
  const id = home.workspace.id;
  const { library, website, ai, attention, activity } = home.glance;
  const totals = home.glance.attentionTotals ?? {
    agents: attention.length,
    failed: attention.filter((row) => row.failedRun).length,
  };
  const agents = agentDirectory(id);
  const lastCall = newest(ai.credentials.map((credential) => credential.lastUsedAt));

  return (
    <section aria-labelledby="home-glance-title" className="space-y-4">
      <h2 id="home-glance-title" className="sr-only">Workspace at a glance</h2>

      <div className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          href={`/workspaces/${id}/agents/crawler`}
          icon={Globe}
          label="Pages crawled"
          value={website.configured ? website.pages.toLocaleString() : "—"}
          detail={website.crawling
            ? "crawling now"
            : website.lastCrawl
              ? `last crawl ${ago(website.lastCrawl.finishedAt ?? website.lastCrawl.startedAt)}`
              : "not crawled yet"}
          live={website.crawling}
        />
        <StatTile
          href={`/workspaces/${id}/library`}
          icon={BookMarked}
          label="Library files"
          value={library.files ? library.files.toLocaleString() : "—"}
          detail={library.writing ? "being written now" : library.files ? `in ${plural(library.folders, "folder")}` : "not written yet"}
          live={library.writing}
        />
        <StatTile
          href="#home-attention"
          icon={CircleAlert}
          label="Failed last runs"
          value={totals.failed.toLocaleString()}
          detail={totals.failed ? `across ${plural(totals.failed, "agent")}` : "no failures"}
          tone={totals.failed ? "failed" : null}
        />
        <StatTile
          href={`/workspaces/${id}/settings/ai`}
          icon={Bot}
          label="AI connections"
          value={ai.credentials.length.toLocaleString()}
          detail={lastCall ? `last call ${ago(lastCall)}` : ai.credentials.length ? "never called" : "none connected"}
        />
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <Card id="home-attention" icon={CircleAlert} title="Needs attention" meta={totals.agents ? plural(totals.agents, "agent") : null}>
            {attention.length ? (
              <AttentionList rows={attention} agents={agents} />
            ) : (
              <Empty icon={CircleCheck}>Nothing waiting on you. Agents whose last run failed appear here.</Empty>
            )}
          </Card>

          <LibraryCard id={id} library={library} />
        </div>

        <div className="min-w-0 space-y-4">
          <WebsiteCard id={id} website={website} />

          <Card icon={Bot} title="Orbik MCP" href={`/workspaces/${id}/settings/ai`} action="Settings">
            {ai.credentials.length ? (
              <ul className="space-y-2.5">
                {ai.credentials.slice(0, 4).map((credential) => (
                  <li key={credential.id} className="flex min-w-0 items-center gap-2.5 text-sm">
                    <span
                      aria-hidden="true"
                      className={cn("size-2 shrink-0 rounded-full", credential.lastUsedAt ? "bg-orb-lime" : "border border-orb-muted")}
                    />
                    <span className="min-w-0 flex-1 truncate text-orb-white">{credential.name}</span>
                    <span className="shrink-0 text-xs text-orb-muted">{credential.lastUsedAt ? `called ${ago(credential.lastUsedAt)}` : "never called"}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No AI of yours reads this workspace yet. Each client you connect, and when it last called, appears here — only you see yours.</Empty>
            )}
          </Card>

          <Card icon={Activity} title="Recent activity">
            {activity.length ? (
              <ActivityTimeline runs={activity} agents={agents} myEmail={myEmail} />
            ) : (
              <Empty>Crawls and agent runs, and who started them, appear here.</Empty>
            )}
          </Card>
        </div>
      </div>
    </section>
  );
}

/**
 * The agents that want somebody, each with its own icon and its failed run said in coral.
 */
function AttentionList({ rows, agents }) {
  return (
    <ul className="-mx-2 space-y-0.5">
      {rows.map((row) => {
        const agent = agents.get(row.agentSlug);
        const Icon = agent?.icon ?? CircleAlert;
        const body = (
          <>
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg border",
                row.failedRun ? "border-orb-coral/40 bg-orb-coral/10 text-orb-coral" : "border-orb-line bg-orb-space/70 text-orb-gray group-hover:text-orb-white",
              )}
            >
              <Icon aria-hidden="true" className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-sm font-medium text-orb-white">{agent?.name ?? humanize(row.agentSlug)}</span>
                <span className={cn("shrink-0 text-xs tabular-nums", row.failedRun ? "text-orb-coral" : "text-orb-gray")}>
                  {row.failedRun ? "last run failed" : null}
                </span>
              </span>
              <span aria-hidden="true" className="mt-1.5 block h-1 overflow-hidden rounded-full bg-orb-line">
                <span className={cn("block h-full w-full rounded-full", row.failedRun ? "bg-orb-coral/70" : "bg-orb-orange/80")} />
              </span>
            </span>
            {agent && <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-orb-muted opacity-0 transition-opacity group-hover:opacity-100" />}
          </>
        );
        return (
          <li key={row.agentSlug}>
            {agent ? (
              <Link href={agent.href} className="group flex min-w-0 items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-orb-raised/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70">
                {body}
              </Link>
            ) : (
              <div className="group flex min-w-0 items-center gap-3 px-2 py-2">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The Library: how big it is, and the overview's opening paragraph set as a quote from the
 * document it is, with ways to open it or ask about it.
 */
function LibraryCard({ id, library }) {
  const ask = useAskPanel();
  const overviewHref = library.overview?.path
    ? `/workspaces/${id}/library?path=${encodeURIComponent(library.overview.path)}`
    : `/workspaces/${id}/library`;

  return (
    <Card
      icon={BookMarked}
      title="Library"
      href={`/workspaces/${id}/library`}
      action="Open"
      meta={library.updatedAt ? `updated ${ago(library.updatedAt)}` : null}
    >
      {library.overview ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Chip>{plural(library.files, "file")}</Chip>
            <Chip>{plural(library.folders, "folder")}</Chip>
            {library.sources > 0 && <Chip>{plural(library.sources, "source page")}</Chip>}
            {library.writing && <Chip live>being written</Chip>}
          </div>
          {library.overview.excerpt && (
            <figure className="rounded-lg border border-orb-line bg-orb-space/60 px-4 py-3.5">
              <figcaption className="mb-1.5 text-2xs font-medium uppercase tracking-[0.12em] text-orb-muted">Overview</figcaption>
              <blockquote className="border-l-2 border-orb-lime/60 pl-3 text-[0.9375rem] leading-relaxed text-orb-gray">
                <p className="line-clamp-4">{library.overview.excerpt}</p>
              </blockquote>
            </figure>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <Link href={overviewHref} className="inline-flex items-center gap-1 font-medium text-orb-lime underline-offset-4 hover:underline">
              Read the overview <ArrowRight aria-hidden="true" className="size-3.5" />
            </Link>
            {ask && (
              <button type="button" onClick={() => ask.setOpen(true)} className="text-orb-gray underline-offset-4 hover:text-orb-white hover:underline">
                Ask the Library
              </button>
            )}
          </div>
        </div>
      ) : (
        <Empty>
          {library.writing
            ? "Being written now. The overview appears here when it is done."
            : "Written by Orbik once your site is crawled and the folders are chosen. Its overview appears here."}
        </Empty>
      )}
    </Card>
  );
}

/**
 * The website: where the crawl cycle stands, drawn as a line from the last crawl to the next, and
 * the month's budget.
 */
function WebsiteCard({ id, website }) {
  const last = website.lastCrawl;
  const lastAt = last ? last.finishedAt ?? last.startedAt : null;
  const cycle = !website.crawling && lastAt && website.nextCrawlAt ? progressBetween(lastAt, website.nextCrawlAt) : null;

  return (
    <Card icon={Globe} title="Website" href={`/workspaces/${id}/agents/crawler`} action="Crawler">
      {website.configured ? (
        <div className="space-y-4">
          <div>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className={cn("text-orb-muted", last?.status === "failed" && "text-orb-coral")}>
                {website.crawling ? "Crawling now" : last ? `Last crawl ${last.status === "failed" ? "failed" : "finished"} ${ago(lastAt)}` : "Not crawled yet"}
              </span>
              {website.nextCrawlAt && !website.crawling && <span className="text-orb-gray">next {fromNow(website.nextCrawlAt)}</span>}
            </div>
            {/* The line is the same fact as the words above it, drawn: it adds nothing for a screen reader. */}
            <div aria-hidden="true" className="relative mt-2 h-1.5 overflow-hidden rounded-full bg-orb-line">
              {website.crawling ? (
                <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-orb-lime motion-safe:animate-pulse" />
              ) : cycle !== null ? (
                <div className="h-full rounded-full bg-gradient-to-r from-orb-lime/30 to-orb-lime" style={{ width: `${Math.max(3, cycle * 100)}%` }} />
              ) : null}
            </div>
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
            <Fact label="Pages">{website.pages.toLocaleString()}</Fact>
            {website.budget && <Fact label="Budget">{budgetUsedLine(website.budget)}</Fact>}
          </dl>
        </div>
      ) : (
        <Empty>Nothing crawled yet. Pages, the last and next crawl, and this month&apos;s budget appear here after the first crawl.</Empty>
      )}
    </Card>
  );
}

/**
 * What happened lately, as a timeline: a dot per run in the colour of how it ended. Runs of the
 * same agent one after another, ending the same way and started the same way, are one line with
 * a count, so five crawls in a row do not fill the list.
 */
function ActivityTimeline({ runs, agents, myEmail }) {
  const groups = groupRuns(runs, myEmail);
  return (
    <ol className="relative">
      {groups.map((group, index) => {
        const run = group.latest;
        const agent = agents.get(run.agentSlug);
        const failed = run.status === "failed";
        const moving = run.status === "running" || run.status === "queued";
        return (
          <li key={run.id} className="relative flex gap-3 pb-3.5 last:pb-0">
            {index < groups.length - 1 && <span aria-hidden="true" className="absolute left-[3.5px] top-3.5 h-full w-px bg-orb-line" />}
            <span
              aria-hidden="true"
              className={cn(
                "relative mt-1.5 size-2 shrink-0 rounded-full ring-4 ring-[color-mix(in_oklab,var(--color-orb-raised)_40%,var(--color-orb-space))]",
                failed ? "bg-orb-coral" : moving ? "bg-orb-lime motion-safe:animate-pulse" : run.status === "succeeded" ? "bg-orb-lime/70" : "bg-orb-muted",
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-sm text-orb-white">
                  {agent?.name ?? humanize(run.agentSlug)}
                  {group.count > 1 && <span className="ml-1.5 rounded-full bg-orb-line px-1.5 py-px text-2xs tabular-nums text-orb-gray">×{group.count}</span>}
                </span>
                <span className="shrink-0 text-xs text-orb-muted">{ago(run.finishedAt ?? run.startedAt)}</span>
              </div>
              <p className={cn("text-xs text-orb-muted", failed && "text-orb-coral")}>
                {RUN_STATUS[run.status] ?? run.status}
                {group.who ? ` · started by ${group.who}` : run.trigger === "manual" ? "" : " · on its own"}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * One card: a Panel with its icon and title, a quiet figure beside them, a link to the page it
 * summarises on the right, and its body. A named region, so each card is a landmark as before.
 */
function Card({ id, icon: Icon, title, meta, href, action = "Open", className, children }) {
  return (
    <Panel id={id} role="region" aria-label={title} className={cn("scroll-mt-20", className)}>
      <PanelTitle
        aside={
          <>
            {meta && <span className="mr-auto min-w-0 truncate text-xs text-orb-muted">· {meta}</span>}
            {href && action && (
              <Link href={href} className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-xs text-orb-muted underline-offset-4 hover:text-orb-white hover:underline">
                {action} <ArrowRight aria-hidden="true" className="size-3" />
              </Link>
            )}
          </>
        }
      >
        <span className="flex items-center gap-2">
          <Icon aria-hidden="true" className="size-4 text-orb-muted" />
          {title}
        </span>
      </PanelTitle>
      {children}
    </Panel>
  );
}

/** A small rounded figure: "20 files". Pulses lime while the thing it counts is moving. */
function Chip({ live = false, children }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs",
      live ? "border-orb-lime/40 bg-orb-lime/10 text-orb-lime" : "border-orb-line bg-orb-space/60 text-orb-gray",
    )}>
      {live && <span aria-hidden="true" className="size-1.5 rounded-full bg-orb-lime motion-safe:animate-pulse" />}
      {children}
    </span>
  );
}

/** One figure of a card, as a term and its value. */
function Fact({ label, children }) {
  return (
    <>
      <dt className="text-orb-muted">{label}</dt>
      <dd className="min-w-0 text-orb-white [overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}

/** What an empty card says will appear, and when. */
function Empty({ icon: Icon, children }) {
  return (
    <p className="flex gap-2 text-sm leading-relaxed text-orb-muted">
      {Icon && <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-orb-lime" />}
      <span>{children}</span>
    </p>
  );
}

/** How close together runs must be to be read as one line: a day. */
const GROUP_WITHIN_MS = 86_400_000;

/**
 * Runs one after another that read the same — same agent, same ending, started by the same person
 * or on their own, within a day of each other — as one group with a count, newest first as the API
 * sends them. Runs further apart stay separate lines, so a count never hides when something ran.
 */
function groupRuns(runs, myEmail) {
  const groups = [];
  for (const run of runs) {
    const who = personName(run.startedBy, myEmail);
    const key = [run.agentSlug, run.status, who ?? "", who ? "" : run.trigger === "manual" ? "manual" : "auto"].join("|");
    const at = new Date(run.finishedAt ?? run.startedAt ?? 0).getTime();
    const previous = groups[groups.length - 1];
    if (previous && previous.key === key && Math.abs(previous.oldestAt - at) <= GROUP_WITHIN_MS) {
      previous.count += 1;
      previous.oldestAt = at;
    } else {
      groups.push({ key, latest: run, who, count: 1, oldestAt: at });
    }
  }
  return groups;
}

/** How far now is from one moment to the next, from 0 to 1, or null when the span is not forward. */
function progressBetween(fromIso, toIso, now = Date.now()) {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  return Math.min(1, Math.max(0, (now - from) / (to - from)));
}

/** The latest of some moments, or null. */
function newest(moments) {
  return moments.filter(Boolean).sort().at(-1) ?? null;
}

/**
 * Every agent's name, icon and page, by slug, from the sidebar's own list, so Home names and links
 * them as the sidebar does. The Library's agent is called the Library here, because that is the
 * page its runs are read on.
 */
function agentDirectory(workspaceId) {
  const rows = new Map(buildAgentRows(workspaceId, null).map((row) => [row.id, { name: row.name, icon: row.icon, href: row.href }]));
  rows.set("business-knowledge-base", { name: "Library", icon: BookMarked, href: `/workspaces/${workspaceId}/library` });
  return rows;
}
