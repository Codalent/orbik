"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Waypoints } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { Skeleton } from "@/components/ui/skeleton";
import { CrawlActivityLog, useCrawlActivity } from "./CrawlActivityLog";
import { CrawlFindings } from "./CrawlFindings";
import { CrawlFrequencySheet } from "./CrawlFrequencySheet";
import { CrawlLogsSheet } from "./CrawlLogsSheet";
import { CrawlNextStep } from "./CrawlNextStep";
import { CrawlSettingsForm } from "./CrawlSettingsForm";
import { CrawlSummary } from "./CrawlSummary";
import { CrawlTopBar } from "./CrawlTopBar";
import { CrawlTree } from "./CrawlTree";
import { PageDetailSheet } from "./PageDetailSheet";
import { ranOutOfPages } from "./runPresentation";
import { clearCrawlData, crawlScope, requestCrawl, saveCrawlSite } from "@/lib/api/crawl";
import { useRevalidateWorkspace } from "@/lib/api/cache";
import { BUDGET_REFUSALS, crawlBlockedReason, isUnlimited } from "@/lib/crawl/budget";
import { useCrawlOverview } from "@/lib/crawl/useCrawlOverview";
import { useExtensionSlots } from "@/lib/extensions/slots";
import { useCan } from "@/lib/workspaces/roles";

/**
 * Where the crawl stands — which run is live, whether one is waiting, how the last one ended — as
 * one string. A notice about an action belongs to the stage it was given in: once the stage moves
 * on (the queued crawl starts, the running one finishes) the notice has been overtaken by what the
 * page itself now says, and is no longer shown.
 */
function stageOf(overview) {
  if (!overview) return "";
  return [overview.activeRun?.id ?? "", overview.queued ? "queued" : "", overview.latestRun?.id ?? "", overview.latestRun?.status ?? ""].join("|");
}

/**
 * One source's pages, as its crawl knows them: configure the website's crawl, run it, and read
 * what it found. Every source has this page under Sources (`…/sources/:sourceId/pages`); the
 * website's is the crawl page it always was.
 *
 * Crawl status is read through the same hook the sidebar uses. A crawl is asynchronous and can
 * take minutes, so that status is polled while one is running — but the read is cached by its
 * path, so the two can never disagree and an open tab makes one request rather than two.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 * @param {string} [props.sourceId] a source's id, or `website` (the default)
 */
export function CrawlDashboard({ workspaceId, sourceId = "website" }) {
  // Every crawl read below goes to this source's routes; the workspace itself is still what roles,
  // budgets and the cache are about.
  const scope = useMemo(() => crawlScope(workspaceId, sourceId), [workspaceId, sourceId]);
  const isWebsite = typeof scope === "string";
  const status = useCrawlOverview(scope);
  const overview = status.crawl;
  const revalidateWorkspace = useRevalidateWorkspace(workspaceId);
  // Crawling, its settings and frequencies are a member's; clearing everything crawled is an
  // admin's. A read-only member sees the crawl and its pages with none of the buttons.
  const canCrawl = useCan("member", workspaceId);
  const canClear = useCan("admin", workspaceId);
  const [selectedHash, setSelectedHash] = useState(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [frequenciesOpen, setFrequenciesOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // `{ text, stage }`: shown while the crawl is still at the stage it was given in (`stageOf`).
  const [notice, setNoticeState] = useState(null);
  // The figure whose pages are listed in place of the tree: broken, orphans or duplicates.
  const [finding, setFinding] = useState(null);
  const extensionSlots = useExtensionSlots();
  const mounted = useRef(true);

  // Set on mount as well as cleared on unmount. In development React mounts every component,
  // unmounts it and mounts it again, and a ref keeps its value across that: cleared once and
  // never set back, it would read "unmounted" for the life of the page, and every guarded
  // update below — the notice, the error, and `busy` going back to false — would be skipped.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /** Shows request failures; the shared API client handles session expiry. */
  const handleFailure = useCallback((failure, message) => {
    if (mounted.current) setError(message ?? failure?.message);
  }, []);

  const refreshOverview = status.refresh;

  /**
   * Shows a notice about the action just taken, tied to the crawl's stage as `latest` (the status
   * read again after the action) has it, or as the page has it when that read failed.
   */
  const setNotice = useCallback((text, latest) => {
    setNoticeState(text ? { text, stage: stageOf(latest ?? overview) } : null);
  }, [overview]);

  /**
   * Re-reads everything cached for this workspace, not just crawl status.
   *
   * For the two actions whose reach is the whole workspace: new crawl settings and cleared crawl
   * data change what the Library, the agents and the sidebar would each be told, and a person who
   * goes to one of those next should not find it describing the site as it was.
   */
  const refreshWorkspace = useCallback(async () => {
    try {
      await revalidateWorkspace();
    } catch {
      // The change that prompted this still happened; the next poll or focus corrects the rest.
    }
  }, [revalidateWorkspace]);

  const hasSite = Boolean(overview?.site);
  const runId = overview?.latestRun?.id ?? null;
  const live = Boolean(overview?.activeRun);
  const queued = overview?.queued === true;
  // Why no crawl can be asked for, when the workspace has no crawl pages to spend: the API refuses
  // such a crawl, and the buttons say so before anybody presses them.
  const blockedReason = crawlBlockedReason(overview?.budget);
  const shownNotice = notice && notice.stage === stageOf(overview) ? notice.text : null;
  const budgetLink = extensionSlots.crawlBudgetLink
    ? {
      label: extensionSlots.crawlBudgetLink.label,
      external: /^https:\/\//.test(extensionSlots.crawlBudgetLink.path),
      href: /^https:\/\//.test(extensionSlots.crawlBudgetLink.path)
        ? extensionSlots.crawlBudgetLink.path
        : `/workspaces/${workspaceId}/${extensionSlots.crawlBudgetLink.path.replace(/^\/+/, "")}`,
    }
    : null;

  // One read of the crawl's activity, shared by the live log on the page and the logs panel. It
  // runs while a crawl is in progress, and once more whenever the panel is opened on a finished
  // one; an idle page with the panel shut makes no request at all.
  const activity = useCrawlActivity({
    workspaceId: scope,
    enabled: Boolean(hasSite && !editing && (live || logsOpen)),
    live,
  });

  // The tree loads its own branches, so a finished crawl is picked up when a branch is next
  // opened rather than by refetching a whole listing nobody is looking at. Remounting on the run
  // and its status is what makes a crawl that starts or completes redraw the branches already on
  // screen; a run's identifier alone stays the same from start to finish, and the table used to
  // say "No pages have been discovered yet." beside a completed crawl of 68 pages.
  //
  // While the crawl runs, the top level is read again in place as the registry grows (the figures
  // poll every few seconds), in steps of pages rather than on every poll, so a large site's tree
  // is not aggregated over and over for one more page.
  const treeKey = `${runId ?? "no-run"}:${overview?.latestRun?.status ?? ""}`;
  const fetchedSoFar = overview?.latestRun?.counters?.pagesFetched ?? 0;
  const liveVersion = live ? `${overview?.urls?.total ?? 0}:${Math.floor(fetchedSoFar / 25)}` : 0;

  /**
   * Saves settings and returns to the status view.
   *
   * The first save is also what asks for the first crawl, so it says the crawl is queued rather
   * than that settings were saved: that is what the button promised.
   */
  async function save(values) {
    const firstSetup = !hasSite;
    setBusy(true);
    setError(null);
    try {
      await saveCrawlSite(workspaceId, values);
      await refreshWorkspace();
      const latest = await refreshOverview();
      if (mounted.current) {
        setEditing(false);
        setNotice(firstSetup
          ? "Crawl queued. It starts within a minute, and this page updates automatically."
          : "Settings saved.", latest);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  /**
   * Asks for a crawl and reports honestly that it is queued rather than already running.
   *
   * @param {{fresh?: boolean}} [options] a fresh crawl asks for every page in full
   */
  async function crawlNow({ fresh = false } = {}) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await requestCrawl(scope, { fresh });
      const latest = await refreshOverview();
      if (!mounted.current) return;
      setNotice(result.alreadyRunning
        ? "A crawl is already running."
        : result.fresh
          ? `Fresh crawl queued: ${result.pages.toLocaleString()} ${result.pages === 1 ? "page" : "pages"} will be fetched again in full. This page updates automatically.`
          : "Crawl queued. This page updates automatically as the sites ahead finish.", latest);
    } catch (failure) {
      // Refused for want of crawl pages: the API's reason is the answer, and "try again" is not.
      handleFailure(failure, BUDGET_REFUSALS.has(failure?.code) ? failure.message : "The crawl could not be started. Try again.");
      if (BUDGET_REFUSALS.has(failure?.code)) await refreshOverview();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  /** Deletes everything crawled for this workspace; its settings stay. */
  async function clearData() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await clearCrawlData(scope);
      await refreshWorkspace();
      const latest = await refreshOverview();
      if (!mounted.current) return;
      setSelectedHash(null);
      setFinding(null);
      setNotice(`Crawl data cleared: ${result.pages.toLocaleString()} ${result.pages === 1 ? "page" : "pages"} removed. Crawl now to read the site again.`, latest);
    } catch (failure) {
      handleFailure(failure, failure?.code === "CRAWL_RUNNING" ? failure.message : "The crawl data could not be cleared. Try again.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  /** Chooses what belongs inside the landmark for the state the view is in. */
  function renderBody() {
    // A failed first read must not leave a skeleton on screen forever: with nothing loaded there
    // is no interface to degrade, so the failure is the only thing worth showing.
    if (!overview) {
      if (!error && !status.failed) return <CrawlSkeleton />;
      return (
        <div className="p-6">
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error ?? "The crawl status could not be loaded. Refresh to try again."}</AlertDescription>
          </Alert>
        </div>
      );
    }

    if (!hasSite && !isWebsite) {
      return (
        <div className="p-6">
          <Alert variant="destructive" role="alert"><AlertDescription>This source is not in this workspace any more.</AlertDescription></Alert>
          <Link href={`/workspaces/${workspaceId}/sources`} className="mt-3 inline-block text-sm text-orb-cyan hover:underline">All sources</Link>
        </div>
      );
    }

    if (!hasSite && !canCrawl) {
      return (
        <div className="mx-auto w-full max-w-2xl space-y-6 p-6 md:p-8">
          <PageHeader
            icon={Waypoints}
            title="Crawling is not set up yet"
            description="A member of this workspace sets up the crawl of its site. Your role here is read-only."
            status={<Pill tone="muted">Not set up</Pill>}
          />
        </div>
      );
    }

    // Another source's settings are on its own page; only the website is set up here.
    if (isWebsite && (!hasSite || (editing && canCrawl))) {
      return (
        <div className="mx-auto w-full max-w-2xl space-y-6 p-6 md:p-8">
          <PageHeader
            icon={Waypoints}
            title={hasSite ? "Crawl settings" : "Set up crawling"}
            description={hasSite
              ? "Changes apply to the next crawl. The schedule is not reset."
              : "Orbik crawls this site and builds the dataset every other check reads from. It needs one address to start."}
            status={hasSite ? null : <Pill tone="muted">Not set up</Pill>}
          />
          <Panel>
            {error && (
              <Alert variant="destructive" role="alert" className="mb-5">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <CrawlSettingsForm
              site={overview.site}
              defaultSeedUrl={overview.defaults.seedUrl}
              onSave={save}
              onCancel={hasSite ? () => setEditing(false) : undefined}
              blockedReason={hasSite ? null : blockedReason}
            />
          </Panel>
        </div>
      );
    }

    return (
      <>
        <CrawlTopBar
          site={overview.site}
          activeRun={overview.activeRun}
          latestRun={overview.latestRun}
          progress={activity.progress}
          queued={queued}
          blockedReason={blockedReason}
          sitePages={overview.urls?.eligible ?? null}
          limited={Boolean(overview.budget) && !isUnlimited(overview.budget)}
          onCrawlNow={canCrawl ? () => crawlNow() : undefined}
          onFreshCrawl={canCrawl ? () => crawlNow({ fresh: true }) : undefined}
          onSetFrequencies={canCrawl ? () => { setNotice(null); setFrequenciesOpen(true); } : undefined}
          onClearData={canClear ? clearData : undefined}
          onEditSettings={canCrawl && isWebsite ? () => { setNotice(null); setEditing(true); } : undefined}
          source={overview.source}
          sourceHref={`/workspaces/${workspaceId}/sources/${isWebsite ? "website" : sourceId}`}
          onOpenLogs={() => setLogsOpen(true)}
          busy={busy}
        />

        <CrawlSummary
          urls={overview.urls}
          counters={overview.latestRun?.counters ?? {}}
          budget={overview.budget}
          notice={shownNotice}
          error={error}
          runError={overview.latestRun?.error?.message ?? null}
          runNote={!live && ranOutOfPages(overview.latestRun) ? ranOutNote(overview.latestRun.counters.pagesSkippedNoBudget) : null}
          finding={finding}
          onFinding={setFinding}
          budgetLink={budgetLink}
        />

        {/* The step after the first crawl, said here as well as on Home, once a crawl has
            finished and while nothing else is going on. */}
        {isWebsite && !live && !queued && overview.latestRun?.status === "succeeded" && <CrawlNextStep workspaceId={workspaceId} />}

        {/*
          The log is on the page only while a crawl is running, which is the one time it is
          feedback rather than history. A finished crawl's log is a question somebody asks
          occasionally, and it lives behind the Crawl logs button with the rest of the record.
        */}
        {live && (
          <CrawlActivityLog
            entries={activity.entries}
            logs={activity.logs}
            progress={activity.progress}
            live
            onSelect={setSelectedHash}
            className="border-y border-orb-line px-6 py-5"
          />
        )}

        {finding ? (
          <CrawlFindings
            key={`${finding}:${treeKey}`}
            workspaceId={scope}
            kind={finding}
            selectedHash={selectedHash}
            onSelect={setSelectedHash}
            onClear={() => setFinding(null)}
          />
        ) : (
          <CrawlTree
            key={treeKey}
            workspaceId={scope}
            selectedHash={selectedHash}
            onSelect={setSelectedHash}
            liveVersion={liveVersion}
          />
        )}

        <CrawlFrequencySheet
          open={frequenciesOpen && canCrawl}
          onClose={() => setFrequenciesOpen(false)}
          workspaceId={scope}
          onApplied={refreshOverview}
        />

        <CrawlLogsSheet
          workspaceId={scope}
          open={logsOpen}
          onClose={() => setLogsOpen(false)}
          activity={activity}
          live={live}
          onSelect={setSelectedHash}
        />

        <PageDetailSheet
          workspaceId={scope}
          canCrawl={canCrawl}
          urlHash={selectedHash}
          onClose={() => setSelectedHash(null)}
        />
      </>
    );
  }

  return (
    // One landmark for every state, and the page's scroll container. Everything below the topbar
    // moves together: the figures, the log and the tree used to sit still while the tree scrolled
    // inside its own box, which made the tree a window a third of the height of the screen it was
    // already on. The topbar stays put because what site this is and how to start a crawl are
    // still the questions in the room forty thousand pages down.
    <main aria-label="Crawl" className="flex min-h-0 flex-1 flex-col md:overflow-y-auto">
      {renderBody()}
    </main>
  );
}

/** What a crawl that ran out of crawl pages left behind, in a sentence. */
function ranOutNote(skipped) {
  const pages = `${skipped.toLocaleString()} ${skipped === 1 ? "page" : "pages"}`;
  return `The last crawl ran out of crawl pages: ${pages} it found ${skipped === 1 ? "was" : "were"} not fetched and wait for the next crawl.`;
}

/**
 * The crawl view while its first read is on the way, shaped like the head, the five figures and
 * the tree it becomes, so nothing jumps when they arrive.
 */
function CrawlSkeleton() {
  const shape = "bg-orb-raised/60";
  return (
    <div role="status" aria-label="Loading crawl status" className="space-y-6 p-6">
      <div className="flex items-start gap-4">
        <Skeleton className={`size-11 shrink-0 rounded-xl ${shape}`} />
        <div className="min-w-0 flex-1 space-y-2.5">
          <Skeleton className={`h-7 w-full max-w-56 rounded-lg ${shape}`} />
          <Skeleton className={`h-4 w-full max-w-lg rounded-md ${shape}`} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className={`h-[6.75rem] rounded-xl ${shape}`} />)}
      </div>
      <Skeleton className={`h-80 rounded-xl ${shape}`} />
    </div>
  );
}
