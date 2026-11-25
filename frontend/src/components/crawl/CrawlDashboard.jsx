"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ScrollText, Waypoints } from "lucide-react";

import { SourceFrame } from "@/components/sources/SourceFrame";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { Skeleton } from "@/components/ui/skeleton";
import { CrawlActivityLog, useCrawlActivity } from "./CrawlActivityLog";
import { FINDINGS, CrawlFindings } from "./CrawlFindings";
import { CrawlLogsSheet } from "./CrawlLogsSheet";
import { CrawlSettingsForm } from "./CrawlSettingsForm";
import { crawlFigures } from "./CrawlSummary";
import { CrawlTree } from "./CrawlTree";
import { PageDetailSheet } from "./PageDetailSheet";
import { crawlScope, saveCrawlSite } from "@/lib/api/crawl";
import { useRevalidateWorkspace } from "@/lib/api/cache";
import { crawlBlockedReason } from "@/lib/crawl/budget";
import { useCrawlOverview } from "@/lib/crawl/useCrawlOverview";
import { useCan } from "@/lib/workspaces/roles";
import { cn } from "@/lib/utils";

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
 * One source's Pages tab: every page its crawl keeps, as a tree of paths, or the pages behind one
 * of its findings; the live log while a crawl runs; the crawl logs; and each page's panel. Every
 * source has it under Sources (`…/sources/:sourceId/pages`); the website's is the crawl page it
 * always was, and where the website's crawl is first set up.
 *
 * Which finding is listed is in the address (`?finding=broken`), so the figures on the Overview tab
 * link straight to their pages.
 *
 * Crawl status is read through the same hook the sidebar and the source's head use. A crawl is
 * asynchronous and can take minutes, so that status is polled while one is running — but the read
 * is cached by its path, so they can never disagree and an open tab makes one request between them.
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
  // Setting up the crawl is a member's. A read-only member sees the crawl and its pages.
  const canCrawl = useCan("member", workspaceId);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const asked = searchParams.get("finding");
  const finding = Object.hasOwn(FINDINGS, asked ?? "") ? asked : null;
  const [selectedHash, setSelectedHash] = useState(null);
  const [logsOpen, setLogsOpen] = useState(false);
  // `{ text, stage }`: shown while the crawl is still at the stage it was given in (`stageOf`).
  const [notice, setNoticeState] = useState(null);
  const mounted = useRef(true);

  // Set on mount as well as cleared on unmount. In development React mounts every component,
  // unmounts it and mounts it again, and a ref keeps its value across that: cleared once and
  // never set back, it would read "unmounted" for the life of the page.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /** Lists one finding's pages in place of the tree, or the tree again, keeping the address in step. */
  const showFinding = useCallback((kind) => {
    router.replace(kind ? `${pathname}?finding=${kind}` : pathname, { scroll: false });
  }, [pathname, router]);

  const hasSite = Boolean(overview?.site);
  const runId = overview?.latestRun?.id ?? null;
  const live = Boolean(overview?.activeRun);
  const shownNotice = notice && notice.stage === stageOf(overview) ? notice.text : null;

  // One read of the crawl's activity, shared by the live log on the page and the logs panel. It
  // runs while a crawl is in progress, and once more whenever the panel is opened on a finished
  // one; an idle page with the panel shut makes no request at all.
  const activity = useCrawlActivity({
    workspaceId: scope,
    enabled: Boolean(hasSite && (live || logsOpen)),
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
   * Saves the website's first crawl settings, which is also what asks for the first crawl, so it
   * says the crawl is queued: that is what the button promised. A failure is the form's to show.
   */
  async function save(values) {
    await saveCrawlSite(workspaceId, values);
    try {
      await revalidateWorkspace();
    } catch {
      // The crawl was still set up; the next poll or focus corrects the rest.
    }
    const latest = await status.refresh();
    if (mounted.current) {
      setNoticeState({ text: "Crawl queued. It starts within a minute, and this page updates automatically.", stage: stageOf(latest ?? overview) });
    }
  }

  // A failed first read must not leave a skeleton on screen forever: with nothing loaded there is
  // no interface to degrade, so the failure is the only thing worth showing.
  if (!overview) {
    return (
      <Frame>
        {status.failed ? (
          <div className="p-6">
            <Alert variant="destructive" role="alert">
              <AlertDescription>The crawl status could not be loaded. Refresh to try again.</AlertDescription>
            </Alert>
          </div>
        ) : <CrawlSkeleton />}
      </Frame>
    );
  }

  if (!hasSite && !isWebsite) {
    return (
      <Frame>
        <div className="p-6">
          <Alert variant="destructive" role="alert"><AlertDescription>This source is not in this workspace any more.</AlertDescription></Alert>
          <Link href={`/workspaces/${workspaceId}/sources`} className="mt-3 inline-block text-sm text-orb-cyan hover:underline">All sources</Link>
        </div>
      </Frame>
    );
  }

  if (!hasSite && !canCrawl) {
    return (
      <Frame>
        <div className="mx-auto w-full max-w-2xl space-y-6 p-6 md:p-8">
          <PageHeader
            icon={Waypoints}
            title="Crawling is not set up yet"
            description="A member of this workspace sets up the crawl of its site. Your role here is read-only."
            status={<Pill tone="muted">Not set up</Pill>}
          />
        </div>
      </Frame>
    );
  }

  // The website before its first crawl: where it starts, and the button that starts it. Once it
  // is set up its settings are on the Settings tab, with every other source's.
  if (!hasSite) {
    return (
      <Frame>
        <div className="mx-auto w-full max-w-2xl space-y-6 p-6 md:p-8">
          <PageHeader
            icon={Waypoints}
            title="Set up crawling"
            description="Orbik crawls this site and builds the dataset every other check reads from. It needs one address to start."
            status={<Pill tone="muted">Not set up</Pill>}
          />
          <Panel>
            <CrawlSettingsForm
              site={null}
              defaultSeedUrl={overview.defaults.seedUrl}
              onSave={save}
              blockedReason={crawlBlockedReason(overview.budget)}
            />
          </Panel>
        </div>
      </Frame>
    );
  }

  const counters = (overview.activeRun ?? overview.latestRun)?.counters ?? {};
  // Worst first: what is broken, what nothing links to, then addresses that are only duplicates.
  const figures = crawlFigures(overview.urls, counters);
  const findings = ["broken", "orphans", "duplicates"].map((kind) => figures.find((figure) => figure.kind === kind));

  return (
    <SourceFrame workspaceId={workspaceId} sourceId={sourceId} tab="pages">
      {shownNotice && <p role="status" className="px-6 pt-5 text-sm text-orb-cyan">{shownNotice}</p>}

      {/*
        The log is on the page only while a crawl is running, which is the one time it is feedback
        rather than history. A finished crawl's log is a question somebody asks occasionally, and
        it lives behind the Crawl logs button with the rest of the record.
      */}
      {live && (
        <CrawlActivityLog
          entries={activity.entries}
          logs={activity.logs}
          progress={activity.progress}
          live
          onSelect={setSelectedHash}
          className="border-b border-orb-line px-6 py-5"
        />
      )}

      <FindingFilter
        total={overview.urls.pages ?? overview.urls.total}
        findings={findings}
        finding={finding}
        onFinding={showFinding}
        onOpenLogs={() => setLogsOpen(true)}
      />

      {finding ? (
        <CrawlFindings
          key={`${finding}:${treeKey}`}
          workspaceId={scope}
          kind={finding}
          selectedHash={selectedHash}
          onSelect={setSelectedHash}
          onClear={() => showFinding(null)}
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
    </SourceFrame>
  );
}

/**
 * The page's scroll container for every state but the set-up source, which `SourceFrame` frames.
 * Everything inside moves together.
 */
function Frame({ children }) {
  return <main aria-label="Crawl" className="flex min-h-0 flex-1 flex-col md:overflow-y-auto">{children}</main>;
}

/** Each finding's colour on its chip, as its figure on the Overview tab has it (`crawlFigures`). */
const CHIP_TONES = Object.freeze({
  info: { dot: "bg-orb-cyan", count: "text-orb-cyan", on: "border-orb-cyan/50 bg-orb-cyan/10 text-orb-cyan" },
  attention: { dot: "bg-orb-orange", count: "text-orb-orange", on: "border-orb-orange/50 bg-orb-orange/10 text-orb-orange" },
  failed: { dot: "bg-orb-coral", count: "text-orb-coral", on: "border-orb-coral/50 bg-orb-coral/10 text-orb-coral" },
});

/**
 * Which pages are listed: every page as a tree, or the pages behind one finding — broken, nothing
 * links here, duplicate URLs — each in its colour with its count. A finding of none cannot be
 * chosen. The crawl logs sit at the far end: the record of every run, for whoever asks.
 */
function FindingFilter({ total, findings, finding, onFinding, onOpenLogs }) {
  const chip = "inline-flex h-8 shrink-0 items-center gap-2 rounded-full border px-3 text-compact font-medium transition-colors focus-visible:outline-2 focus-visible:outline-orb-lime disabled:cursor-default disabled:opacity-50";
  return (
    <div className="flex flex-wrap items-center gap-2 px-6 pt-5">
      {/* At least a phone's width, so on a phone the logs button wraps under the chips rather than
          squeezing them into a column beside it. */}
      <div role="group" aria-label="Show" className="flex min-w-[min(100%,26rem)] flex-1 flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={!finding}
          onClick={() => onFinding(null)}
          className={cn(chip, !finding ? "border-orb-lime/50 bg-orb-lime/10 text-orb-lime" : "border-orb-line text-orb-gray hover:border-orb-muted hover:text-orb-white")}
        >
          Every page
          <span className="tabular-nums">{total.toLocaleString()}</span>
        </button>
        {findings.map((figure) => {
          const pressed = finding === figure.kind;
          const tone = CHIP_TONES[figure.tone] ?? null;
          return (
            <button
              key={figure.kind}
              type="button"
              aria-pressed={pressed}
              disabled={!pressed && figure.value === 0}
              onClick={() => onFinding(pressed ? null : figure.kind)}
              title={figure.detail}
              className={cn(chip, pressed && tone ? tone.on : "border-orb-line text-orb-gray enabled:hover:border-orb-muted enabled:hover:text-orb-white")}
            >
              {tone && !pressed && <span aria-hidden="true" className={cn("size-1.5 rounded-full", tone.dot)} />}
              {FINDINGS[figure.kind].title}
              <span className={cn("tabular-nums", !pressed && tone ? tone.count : null)}>{figure.value.toLocaleString()}</span>
            </button>
          );
        })}
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onOpenLogs}>
        <ScrollText aria-hidden="true" className="size-4" />
        Crawl logs
      </Button>
    </div>
  );
}

/**
 * The crawl view while its first read is on the way, shaped like the head, the tabs and the tree
 * it becomes, so nothing jumps when they arrive.
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
      <div className="flex gap-2">
        {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className={`h-8 w-28 rounded-full ${shape}`} />)}
      </div>
      <Skeleton className={`h-80 rounded-xl ${shape}`} />
    </div>
  );
}
