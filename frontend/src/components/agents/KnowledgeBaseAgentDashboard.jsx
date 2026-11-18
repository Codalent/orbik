"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, BookMarked, Copy, FileText, FolderTree, History, Pause, Play, ScrollText } from "lucide-react";
import useSWR from "swr";

import { Button, buttonVariants } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/page-header";
import { EmptyState, Panel, RowList } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { Skeleton } from "@/components/ui/skeleton";
import { StatTile } from "@/components/ui/stat-tile";
import { AgentHeadView, AgentLimits, AgentPageSkeleton, AgentStats, AgentStatus, CrawlerLink } from "./AgentPage";
import { SourceLedger } from "./SourceLedger";
import { LibraryRunChanges } from "@/components/library/LibraryAgentBar";
import { useEdition } from "@/lib/api/edition";
import { libraryPath } from "@/lib/api/library";
import { useAuth } from "@/lib/auth/AuthProvider";
import { RUN_STATUS_LABELS, TERMINAL_RUN_STATUSES } from "@/lib/agents/runEvents";
import { useAgentWork } from "@/lib/agents/useAgentWork";
import { formatDate } from "@/lib/format";
import { ago, plural } from "@/lib/home/home";
import { libraryWait } from "@/lib/library/agentWait";
import { LIBRARY_AGENT_SLUG, coverageLine, coverageNote } from "@/lib/library/library";
import { changesOf } from "@/lib/library/runActivity";
import { VIEWS } from "@/lib/library/workspaceTabs";
import { useCan } from "@/lib/workspaces/roles";

/** When it writes, in one sentence: nobody starts it, and no clock does. */
const CADENCE = "Whenever a crawl finds that a page it writes from has changed, it rewrites what that change touches, and leaves the rest of the Library as it is.";

/** How often the Library's counts are re-read while the page is open. */
const REFRESH_MS = 15_000;

/** What the agent can and cannot do, folded at the foot of the page. */
const LIMITS = Object.freeze([
  "Every page of your site is copied into Sources, word for word, when a crawl finishes. That copy is made by code: no model reads a page to store it.",
  "It writes from up to 80 of your pages, chosen by how many of your other pages link to each. The source ledger says why each page was used or left out, and Include brings one in.",
  "It writes only inside the folders you chose; it never makes, renames or removes a top-level folder.",
  "A passage you wrote in a Library file is kept through every later run: the agent writes around it.",
  "It reads your site and never changes it.",
]);

/** How a run was started, in the words the runs list uses. */
const TRIGGERS = Object.freeze({ manual: "by hand", schedule: "on schedule", event: "after your site changed" });

/** The tone of each run status in the runs list. */
const RUN_TONES = Object.freeze({ succeeded: "neutral", failed: "coral", cancelled: "muted", running: "lime", queued: "lime" });

/**
 * The Knowledge base agent's own page: how it is set up, when it writes, and how its runs went.
 *
 * What the agent writes is the Library, which has a place of its own in the rail; this page links
 * there rather than drawing it again, as the Design system agent's page does for the Brand. What
 * is here is the agent: the switch that sets it to work, what it is waiting on, the folders it
 * writes into, the pages it writes from, and what its runs did.
 *
 * There is no Run now. Nobody starts this agent: it reads each page the crawl brings back and
 * rewrites the Library when what those pages say has changed, so a button would only ever start a
 * run with nothing new to read.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 */
export function KnowledgeBaseAgentDashboard({ workspaceId }) {
  const router = useRouter();
  const canEdit = useCan("member", workspaceId);
  const isAdmin = Boolean(useAuth().user?.isAdmin);
  const { edition } = useEdition();
  // The Library's own read, one level deep: its counts, its folders and what the agent is waiting
  // on, without the tree the Library page draws.
  const libraryRead = useSWR(libraryPath(workspaceId, { depth: 1 }), { refreshInterval: REFRESH_MS });
  const state = libraryRead.data ?? null;
  const work = useAgentWork({ workspaceId, agentSlug: LIBRARY_AGENT_SLUG, onFinished: libraryRead.mutate });

  if ((work.loading && !work.agent) || (!state && !libraryRead.error)) {
    return <AgentPageSkeleton label="Loading the Knowledge base agent" stats={4} />;
  }

  const { inFlight, working, busy } = work;
  const ready = (state?.readiness?.markdownPages ?? 0) > 0;
  const wait = libraryWait({ state, work, canEdit, isAdmin, edition });
  const runs = work.runs ?? [];
  const lastFinished = runs.find((entry) => TERMINAL_RUN_STATUSES.includes(entry.status)) ?? null;
  const lastWrite = work.setup?.lastRunAt ?? lastFinished?.finishedAt ?? null;
  const libraryHref = `/workspaces/${workspaceId}/library`;
  const viewHref = (view) => `${libraryHref}?view=${view}`;
  const structure = state?.structure ?? null;
  const folders = structure?.chosen?.groups ?? [];
  const stats = state?.stats ?? null;
  const sources = state?.sources ?? null;
  const coverage = state?.coverage ?? null;
  // What the last finished run changed, from the run on screen once it has finished.
  const shownRun = work.run && work.complete ? work.run : null;
  const changes = changesOf(shownRun);

  return (
    <div className="space-y-10">
      <AgentHeadView
        work={work}
        workspaceId={workspaceId}
        agentSlug={LIBRARY_AGENT_SLUG}
        fallbackName="Knowledge base"
        ready={ready}
        error={!state && libraryRead.error ? libraryRead.error.message ?? "The Library could not be read." : null}
        // Nobody starts it: the crawl does, when a page it writes from changed.
        manual={false}
        // The switch is in the "When it writes" section below, with what it means.
        switchable={false}
        status={work.loading ? <Skeleton className="h-5 w-20 rounded-full bg-orb-raised/70" /> : (
          <AgentStatus ready={ready} notReadyLabel="Not set up" working={working} inFlight={inFlight} failed={lastFinished?.status === "failed"} switchable />
        )}
        workingMessage={`Set to work. ${CADENCE}`}
        pausedMessage="Paused: your site is still crawled and copied into Sources, and the Library is left as it is."
        // Every file it writes is written by a model: without one it writes nothing.
        ai={{ need: "required", consequence: "the Library cannot be written or updated" }}
        notReadyMessage="This agent writes from the pages your crawler copies into Sources. Crawl your site first."
        notReadyAction={<CrawlerLink workspaceId={workspaceId} />}
        actions={(
          <Link href={libraryHref} className={buttonVariants({ size: "sm", variant: "ghost" })}>
            <BookMarked className="size-3.5" /> Open the Library
          </Link>
        )}
      />

      {/* What it is waiting on, when anything is: the same account the Library gives. A run in
          flight is drawn under the head already. */}
      {ready && wait && wait.kind !== "writing" && (
        <Panel role="status" className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <div className="min-w-[14rem] flex-1">
            <p className="text-sm font-medium text-orb-white">{wait.title}</p>
            <p className="mt-1 text-sm leading-relaxed text-orb-gray">{wait.detail}</p>
          </div>
          {wait.action === "structure" && (
            <Link href={viewHref(VIEWS.structure)} className={buttonVariants({ size: "sm" })}>Choose the folders</Link>
          )}
          {wait.action === "work" && canEdit && (
            <Button type="button" size="sm" onClick={work.toggleWorking} disabled={busy}>
              <Play aria-hidden="true" className="size-3.5" /> Set the agent to work
            </Button>
          )}
        </Panel>
      )}

      <AgentStats columns={4} data-testid="knowledge-base-headline">
        <StatTile
          href={libraryHref}
          icon={FileText}
          label="Library"
          value={stats ? plural(stats.files ?? 0, "file") : "…"}
          detail={stats?.updatedAt ? `In ${plural(stats.folders ?? 0, "folder")} · changed ${ago(stats.updatedAt)}` : "Nothing written yet"}
        />
        <StatTile
          icon={ScrollText}
          label="Written from"
          value={sources ? plural(sources.used ?? 0, "page") : "…"}
          detail={sources ? `${(sources.excluded ?? 0).toLocaleString()} left out, each with its reason` : "Not chosen yet"}
        />
        <StatTile
          icon={Copy}
          label="Sources"
          value={coverage?.pages ? (coverage.stored ?? 0).toLocaleString() : "—"}
          detail={<span title={coverageNote(coverage)}>{coverageLine(coverage) ?? "No pages copied yet"}</span>}
        />
        <StatTile
          icon={FolderTree}
          label="Folders"
          value={folders.length ? folders.length.toLocaleString() : "—"}
          tone={structure?.needsChoice ? "attention" : null}
          detail={structure?.needsChoice ? "Waiting for you to choose them" : structure?.chosen?.chosenAt ? `Chosen ${ago(structure.chosen.chosenAt)}` : "Not chosen yet"}
        />
      </AgentStats>

      <section aria-labelledby="kb-when" className="space-y-3">
        <SectionHeading id="kb-when">When it writes</SectionHeading>
        <Panel className="flex flex-wrap items-start gap-x-6 gap-y-4">
          <dl className="grid min-w-[14rem] flex-1 grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-orb-muted">State</dt>
            <dd className="text-orb-white">{inFlight ? "Writing now" : working ? "Set to work" : "Paused"}</dd>
            <dt className="text-orb-muted">When</dt>
            <dd className="text-orb-gray">{CADENCE}</dd>
            <dt className="text-orb-muted">Last write</dt>
            <dd className="text-orb-gray">
              {lastWrite ? formatDate(lastWrite) : "Never"}
              {lastFinished && lastFinished.status !== "succeeded" && ` · last run ${(RUN_STATUS_LABELS[lastFinished.status] ?? lastFinished.status).toLowerCase()}`}
            </dd>
          </dl>
          {canEdit ? (
            <Button
              type="button"
              size="sm"
              variant={working ? "outline" : "default"}
              onClick={work.toggleWorking}
              disabled={busy || !ready}
              title={working
                ? "Pause it: your site is still crawled, and the Library is left as it is."
                : "Set it to work: it rewrites the Library whenever a crawl finds a change."}
            >
              {working ? <><Pause className="size-3.5" /> Pause</> : <><Play className="size-3.5" /> Set to work</>}
            </Button>
          ) : (
            <p className="text-compact text-orb-muted">A member of this workspace sets it to work.</p>
          )}
        </Panel>
      </section>

      <section aria-labelledby="kb-folders" className="space-y-3">
        <SectionHeading
          id="kb-folders"
          aside={folders.length ? `${folders.length} at the top of the Library` : null}
          action={canEdit && ready ? (
            <Link href={viewHref(VIEWS.structure)} className={buttonVariants({ size: "sm", variant: "outline" })}>
              <FolderTree className="size-3.5" /> {folders.length ? "Change folders" : "Choose folders"}
            </Link>
          ) : null}
        >
          Folders it writes into
        </SectionHeading>
        {folders.length ? (
          <RowList>
            {folders.map((folder) => (
              <li key={folder.path} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2.5 sm:px-4">
                <span className="min-w-[11rem] text-sm text-orb-white">{folder.title}</span>
                {folder.start && <Pill tone="muted">Start here</Pill>}
                {folder.summary && <span className="min-w-[11rem] flex-1 text-xs text-orb-muted">{folder.summary}</span>}
              </li>
            ))}
          </RowList>
        ) : (
          <EmptyState icon={FolderTree}>
            No folders chosen yet. The top of the Library is yours: start from the standard folders, change them by
            hand, or describe what you want in words. The agent writes its first run once they are chosen.
          </EmptyState>
        )}
      </section>

      <section aria-labelledby="kb-changes" className="space-y-3">
        <SectionHeading
          id="kb-changes"
          action={(
            <Link href={viewHref(VIEWS.changes)} className="inline-flex items-center gap-1 text-sm font-medium text-orb-cyan underline-offset-4 hover:text-orb-white hover:underline">
              Open in the Library <ArrowUpRight aria-hidden="true" className="size-3.5" />
            </Link>
          )}
        >
          What the last run changed
        </SectionHeading>
        <LibraryRunChanges
          changes={changes}
          run={shownRun ?? lastFinished}
          onOpen={(path) => router.push(`${libraryHref}?path=${path}`)}
          className="rounded-xl border border-orb-line bg-orb-space/40 px-4 py-4 sm:px-5"
        />
      </section>

      {state && sources && (
        <SourceLedger workspaceId={workspaceId} agentSlug={LIBRARY_AGENT_SLUG} counts={sources} onIncluded={() => libraryRead.mutate()} />
      )}

      <section aria-labelledby="kb-runs" className="space-y-3">
        <SectionHeading id="kb-runs" aside={runs.length ? `the last ${plural(runs.length, "run")}` : null}>
          <span className="inline-flex items-center gap-2"><History aria-hidden="true" className="size-4 text-orb-muted" /> Recent runs</span>
        </SectionHeading>
        {runs.length ? (
          <RowList>
            {runs.map((entry) => <RunRow key={entry.id} run={entry} />)}
          </RowList>
        ) : (
          <EmptyState icon={History}>No runs yet. Once its folders are chosen and it is set to work, it writes after your next crawl.</EmptyState>
        )}
      </section>

      <AgentLimits items={LIMITS} />
    </div>
  );
}

/** One run in the recent-runs list: how it ended, and when and why it started. */
function RunRow({ run }) {
  const at = run.finishedAt ?? run.startedAt;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 sm:px-4">
      <Pill tone={RUN_TONES[run.status] ?? "neutral"} dot={run.status === "running" || run.status === "queued"} pulse={run.status === "running"}>
        {RUN_STATUS_LABELS[run.status] ?? run.status}
      </Pill>
      <p className="min-w-[11rem] flex-1 text-compact text-orb-gray">
        {run.status === "queued" ? "Waiting to start" : run.status === "running" ? "Writing the Library" : run.status === "failed" ? "Did not finish" : run.status === "cancelled" ? "Stopped before it finished" : "Finished"}
      </p>
      <p className="text-xs text-orb-muted">
        {at ? formatDate(at) : "Not started"}
        {TRIGGERS[run.trigger] && ` · ${TRIGGERS[run.trigger]}`}
      </p>
    </li>
  );
}
