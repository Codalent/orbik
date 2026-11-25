"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";

import { CrawlFrequencySheet } from "@/components/crawl/CrawlFrequencySheet";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Panel } from "@/components/ui/panel";
import { clearCrawlData, crawlScope, requestCrawl } from "@/lib/api/crawl";
import { useRevalidateWorkspace } from "@/lib/api/cache";
import { BUDGET_REFUSALS, crawlBlockedReason, isUnlimited } from "@/lib/crawl/budget";
import { useCrawlOverview } from "@/lib/crawl/useCrawlOverview";
import { isLive } from "@/lib/sources/sources";
import { useSource, useSources } from "@/lib/sources/useSources";
import { useCan } from "@/lib/workspaces/roles";
import { cn } from "@/lib/utils";
import { SourceFrame } from "./SourceFrame";
import { SourceSettings } from "./SourceSettings";

/**
 * One source's Settings tab: everything that can be set about it, in one column. Its settings
 * (where it starts, how much of it, what it is, how the Library uses it, how often, with the page
 * by page frequencies one press away), then its crawl data — a fresh crawl of every page, clearing
 * what was crawled — and, for a source other than the website, removing it.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 * @param {string} props.sourceId a source id, or `website`
 */
export function SourceSettingsTab({ workspaceId, sourceId }) {
  return (
    <SourceFrame workspaceId={workspaceId} sourceId={sourceId} tab="settings">
      <SettingsBody workspaceId={workspaceId} sourceId={sourceId} />
    </SourceFrame>
  );
}

function SettingsBody({ workspaceId, sourceId }) {
  const router = useRouter();
  // The frame has loaded the source before this draws: these reads are the cache's.
  const { data, refresh } = useSource(workspaceId, sourceId);
  const { data: list } = useSources(workspaceId);
  const source = data.source;
  const scope = crawlScope(workspaceId, source.primary ? "website" : source.id);
  const { crawl: overview, refresh: refreshOverview } = useCrawlOverview(scope);
  const revalidate = useRevalidateWorkspace(workspaceId);
  const canCrawl = useCan("member", workspaceId);
  const [frequenciesOpen, setFrequenciesOpen] = useState(false);

  /** Reads everything this tab changes again: a setting reaches the Library, agents and sidebar. */
  async function refreshAll() {
    await Promise.all([revalidate().catch(() => {}), refresh(), refreshOverview()]);
  }

  return (
    <div className="w-full max-w-3xl px-6 py-6">
      <SourceSettings
        key={source.id}
        workspaceId={workspaceId}
        source={source}
        detail={data}
        purposes={list?.purposes ?? []}
        redirectedFromHost={overview?.site?.redirectedFrom?.host ?? null}
        // Offered once there are pages to choose for: the list exists after the first crawl.
        onSetFrequencies={canCrawl && overview?.latestRun ? () => setFrequenciesOpen(true) : undefined}
        onSaved={refreshAll}
        onRemoved={() => router.replace(`/workspaces/${workspaceId}/sources`)}
      >
        {overview && <CrawlData workspaceId={workspaceId} scope={scope} source={source} overview={overview} onChanged={refreshAll} />}
      </SourceSettings>

      <CrawlFrequencySheet
        open={frequenciesOpen && canCrawl}
        onClose={() => setFrequenciesOpen(false)}
        workspaceId={scope}
        onApplied={refreshOverview}
      />
    </div>
  );
}

/**
 * What was crawled, and the two things done to all of it at once: fetch every page again in full,
 * and delete it all. Both ask first, since one spends the month's crawl pages on the whole site and
 * the other cannot be undone. Neither is offered while a crawl runs or waits to.
 */
function CrawlData({ workspaceId, scope, source, overview, onChanged }) {
  const canCrawl = useCan("member", workspaceId);
  const canClear = useCan("admin", workspaceId);
  const [confirm, confirmDialog] = useConfirm();
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  if (!canCrawl && !canClear) return null;

  const crawled = Boolean(overview.latestRun);
  const live = isLive(source) || Boolean(overview.activeRun) || overview.queued === true;
  const blockedReason = crawlBlockedReason(overview.budget);
  const limited = Boolean(overview.budget) && !isUnlimited(overview.budget);
  const pages = overview.urls?.eligible ?? null;
  const about = pages ? `about ${pages.toLocaleString("en-US")} ${pages === 1 ? "page" : "pages"}` : "every page";

  async function freshCrawl() {
    const ok = await confirm({
      title: "Fetch every page again?",
      description: `Orbik fetches ${about} of ${source.host} in full, whatever each page's crawl frequency, and none comes back as unchanged.${limited ? " Each page fetched uses one page of this month's crawl budget." : ""}`,
      confirmLabel: "Crawl every page",
    });
    if (!ok) return;
    await run("fresh", async () => {
      const result = await requestCrawl(scope, { fresh: true });
      return result.alreadyRunning
        ? "A crawl is already running."
        : `Fresh crawl queued: ${result.pages.toLocaleString("en-US")} ${result.pages === 1 ? "page" : "pages"} will be fetched again in full.`;
    }, "The crawl could not be started. Try again.");
  }

  async function clear() {
    const ok = await confirm({
      title: `Clear ${source.name}'s crawl data?`,
      description: "Every crawled page, its history and the crawl logs are deleted, to read the site from scratch. These settings and the crawl frequencies you chose are kept. This cannot be undone.",
      confirmLabel: "Delete all crawl data",
      destructive: true,
    });
    if (!ok) return;
    await run("clear", async () => {
      const result = await clearCrawlData(scope);
      return `Crawl data cleared: ${result.pages.toLocaleString("en-US")} ${result.pages === 1 ? "page" : "pages"} removed. Crawl now to read the site again.`;
    }, "The crawl data could not be cleared. Try again.");
  }

  /** Runs one action and says how it went; the API's own reason when it refuses one. */
  async function run(name, action, failed) {
    setBusy(name);
    setNotice(null);
    try {
      const text = await action();
      await onChanged();
      setNotice({ tone: "cyan", text });
    } catch (failure) {
      setNotice({ tone: "coral", text: BUDGET_REFUSALS.has(failure?.code) || failure?.code === "CRAWL_RUNNING" ? failure.message : failed });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel aria-labelledby="crawl-data-heading">
      <h2 id="crawl-data-heading" className="text-sm font-semibold text-orb-white">Crawl data</h2>
      <p className="mt-1 text-compact text-orb-muted">
        {crawled
          ? `${(overview.urls?.pages ?? overview.urls?.total ?? 0).toLocaleString("en-US")} pages crawled from ${source.host}.`
          : "Nothing is crawled yet."}
        {live && " Both wait until the crawl in progress has finished."}
      </p>
      <ul className="mt-3 divide-y divide-orb-line/70 rounded-lg border border-orb-line">
        {canCrawl && (
          <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <div className="min-w-[11rem] flex-1">
              <p className="text-sm font-medium text-orb-white">Fresh crawl</p>
              <p className="mt-0.5 text-compact text-orb-muted">
                Fetch {about} again in full, whatever its crawl frequency. For when much of the site has changed at once.
              </p>
              {blockedReason && crawled && !live && <p className="mt-1 text-xs text-orb-orange">{blockedReason}</p>}
            </div>
            <Button type="button" variant="outline" size="sm" disabled={!crawled || live || Boolean(blockedReason) || busy !== null} onClick={freshCrawl}>
              <RefreshCw aria-hidden="true" className="size-4" />{busy === "fresh" ? "Asking…" : "Fresh crawl"}
            </Button>
          </li>
        )}
        {canClear && (
          <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <div className="min-w-[11rem] flex-1">
              <p className="text-sm font-medium text-orb-white">Clear crawl data</p>
              <p className="mt-0.5 text-compact text-orb-muted">
                Delete every crawled page, its history and the crawl logs. The settings are kept. This cannot be undone.
              </p>
            </div>
            <Button type="button" variant="destructive" size="sm" disabled={!crawled || live || busy !== null} onClick={clear}>
              <Trash2 aria-hidden="true" className="size-4" />{busy === "clear" ? "Clearing…" : "Clear crawl data"}
            </Button>
          </li>
        )}
      </ul>
      {notice && <p role="status" className={cn("mt-2.5 text-xs", notice.tone === "coral" ? "text-orb-coral" : "text-orb-cyan")}>{notice.text}</p>}
      {confirmDialog}
    </Panel>
  );
}
