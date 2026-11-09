"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Waypoints } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { Skeleton } from "@/components/ui/skeleton";
import { CrawlActivityLog, useCrawlActivity } from "./CrawlActivityLog";
import { CrawlFrequencySheet } from "./CrawlFrequencySheet";
import { CrawlLogsSheet } from "./CrawlLogsSheet";
import { CrawlSettingsForm } from "./CrawlSettingsForm";
import { CrawlSummary } from "./CrawlSummary";
import { CrawlTopBar } from "./CrawlTopBar";
import { CrawlTree } from "./CrawlTree";
import { PageDetailSheet } from "./PageDetailSheet";
import { clearCrawlData, requestCrawl, saveCrawlSite } from "@/lib/api/crawl";
import { useRevalidateWorkspace } from "@/lib/api/cache";
import { useCrawlOverview } from "@/lib/crawl/useCrawlOverview";
import { useCan } from "@/lib/workspaces/roles";

/**
 * The workspace's crawl view: configure it, run it, and read what it found.
 *
 * Crawl status is read through the same hook the sidebar uses. A crawl is asynchronous and can
 * take minutes, so that status is polled while one is running — but the read is cached by its
 * path, so the two can never disagree and an open tab makes one request rather than two.
 */
export function CrawlDashboard({ workspaceId }) {
  const status = useCrawlOverview(workspaceId);
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
  const [notice, setNotice] = useState(null);
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

  // One read of the crawl's activity, shared by the live log on the page and the logs panel. It
  // runs while a crawl is in progress, and once more whenever the panel is opened on a finished
  // one; an idle page with the panel shut makes no request at all.
  const activity = useCrawlActivity({
    workspaceId,
    enabled: Boolean(hasSite && !editing && (live || logsOpen)),
    live,
  });

  // The tree loads its own branches, so a finished crawl is picked up when a branch is next
  // opened rather than by refetching a whole listing nobody is looking at. Remounting on the run
  // identifier is what makes a completed crawl redraw the branches already on screen.

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
      if (mounted.current) {
        setEditing(false);
        setNotice(firstSetup
          ? "Crawl queued. It starts within a minute, and this page updates automatically."
          : "Settings saved.");
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
      const result = await requestCrawl(workspaceId, { fresh });
      await refreshOverview();
      if (!mounted.current) return;
      setNotice(result.alreadyRunning
        ? "A crawl is already running."
        : result.fresh
          ? `Fresh crawl queued: ${result.pages.toLocaleString()} ${result.pages === 1 ? "page" : "pages"} will be fetched again in full. This page updates automatically.`
          : "Crawl queued. This page updates automatically as the sites ahead finish.");
    } catch (failure) {
      handleFailure(failure, "The crawl could not be started. Try again.");
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
      const result = await clearCrawlData(workspaceId);
      await refreshWorkspace();
      if (!mounted.current) return;
      setSelectedHash(null);
      setNotice(`Crawl data cleared: ${result.pages.toLocaleString()} ${result.pages === 1 ? "page" : "pages"} removed. Crawl now to read the site again.`);
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

    if (!hasSite || (editing && canCrawl)) {
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
          queued={overview.queued === true}
          onCrawlNow={canCrawl ? () => crawlNow() : undefined}
          onFreshCrawl={canCrawl ? () => crawlNow({ fresh: true }) : undefined}
          onSetFrequencies={canCrawl ? () => { setNotice(null); setFrequenciesOpen(true); } : undefined}
          onClearData={canClear ? clearData : undefined}
          onEditSettings={canCrawl ? () => { setNotice(null); setEditing(true); } : undefined}
          onOpenLogs={() => setLogsOpen(true)}
          busy={busy}
        />

        <CrawlSummary
          urls={overview.urls}
          counters={overview.latestRun?.counters ?? {}}
          budget={overview.budget}
          notice={notice}
          error={error}
          runError={overview.latestRun?.error?.message ?? null}
        />

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

        <CrawlTree
          key={runId ?? "no-run"}
          workspaceId={workspaceId}
          selectedHash={selectedHash}
          onSelect={setSelectedHash}
        />

        <CrawlFrequencySheet
          open={frequenciesOpen && canCrawl}
          onClose={() => setFrequenciesOpen(false)}
          workspaceId={workspaceId}
          onApplied={refreshOverview}
        />

        <CrawlLogsSheet
          workspaceId={workspaceId}
          open={logsOpen}
          onClose={() => setLogsOpen(false)}
          activity={activity}
          live={live}
          onSelect={setSelectedHash}
        />

        <PageDetailSheet
          workspaceId={workspaceId}
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
