"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Play, RefreshCw, Square } from "lucide-react";

import { HEAD_WRAP } from "@/components/agents/AgentPage";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Pill } from "@/components/ui/pill";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { crawlScope, requestCrawl, stopCrawl } from "@/lib/api/crawl";
import { useRevalidateWorkspace } from "@/lib/api/cache";
import { BUDGET_REFUSALS, crawlBlockedReason } from "@/lib/crawl/budget";
import { describeElapsed, describeNextCrawl } from "@/lib/crawl/format";
import { useCrawlOverview } from "@/lib/crawl/useCrawlOverview";
import { formatDate, personFromEmail } from "@/lib/format";
import { describeRelation, describeState, isLive } from "@/lib/sources/sources";
import { useSource, useSources } from "@/lib/sources/useSources";
import { useCan } from "@/lib/workspaces/roles";
import { cn } from "@/lib/utils";
import { sourceIcon } from "./SourceGlyph";

/**
 * A source's three tabs, each a route under the source's address: what it is and how it is doing,
 * every page its crawl keeps, and everything that can be set about it.
 */
export const SOURCE_TABS = Object.freeze([
  { id: "overview", label: "Overview", path: "" },
  { id: "pages", label: "Pages", path: "/pages" },
  { id: "settings", label: "Settings", path: "/settings" },
]);

/** The address of one of a source's tabs; `sourceId` is the route's, `website` for the website. */
export function sourceTabHref(workspaceId, sourceId, tab = "overview") {
  const path = SOURCE_TABS.find((entry) => entry.id === tab)?.path ?? "";
  return `/workspaces/${workspaceId}/sources/${sourceId}${path}`;
}

/**
 * Every tab of a source, framed alike: the source's head — its name, how it is doing, where it is
 * and when it is next read, and the one thing to press, **Crawl now** — with the tabs under it,
 * held at the top as the tab's own content scrolls beneath. The head reads the same cached source
 * and crawl status on every tab, so moving between them redraws nothing but the tab.
 *
 * The head is the same on all three so that the one action and the state never move: what
 * changes a setting is on Settings, what lists pages is on Pages, and Crawl now is everywhere.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 * @param {string} props.sourceId the route's source id, or `website`
 * @param {"overview"|"pages"|"settings"} props.tab the tab on screen
 */
export function SourceFrame({ workspaceId, sourceId, tab, children }) {
  const { data, failed, error } = useSource(workspaceId, sourceId);

  if (!data) {
    return (
      <main aria-label="Source" className="flex min-h-0 flex-1 flex-col md:overflow-y-auto">
        <div className="p-6">
          {!failed ? <HeadSkeleton /> : error?.code === "CRAWL_NOT_CONFIGURED" ? (
            // The website before its first crawl is set up: the setup is on its pages tab.
            <div className="max-w-xl space-y-3">
              <p className="text-sm text-orb-gray">The website&apos;s crawl is not set up yet. Everything else Orbik reads sits beside it.</p>
              <Link href={sourceTabHref(workspaceId, sourceId, "pages")} className={buttonVariants({ size: "sm" })}>Set up the website&apos;s crawl</Link>
            </div>
          ) : (
            <>
              <Alert variant="destructive" role="alert">
                <AlertDescription>
                  {error?.code === "SOURCE_NOT_FOUND" ? "This source is not in this workspace any more." : "This source could not be loaded. Refresh to try again."}
                </AlertDescription>
              </Alert>
              <Link href={`/workspaces/${workspaceId}/sources`} className="mt-3 inline-block text-sm text-orb-cyan hover:underline">All sources</Link>
            </>
          )}
        </div>
      </main>
    );
  }

  return (
    <main aria-labelledby="source-heading" className="flex min-h-0 flex-1 flex-col md:overflow-y-auto">
      <SourceHead workspaceId={workspaceId} sourceId={sourceId} tab={tab} source={data.source} />
      {children}
    </main>
  );
}

/**
 * The source's head and tabs. Held at the top from a tablet's width up; on a phone the head, with
 * its button wrapped under it, would cover a third of the screen, so there it scrolls away.
 */
function SourceHead({ workspaceId, sourceId, tab, source }) {
  const { data: list } = useSources(workspaceId);
  const scope = crawlScope(workspaceId, source.primary ? "website" : source.id);
  const website = list?.sources?.find((entry) => entry.primary) ?? null;
  const state = describeState(source);
  const live = isLive(source);
  const Icon = sourceIcon(source);
  const addedBy = personFromEmail(source.addedBy?.email);
  const progress = source.progress;

  return (
    <div className="z-20 border-b border-orb-line bg-orb-space px-6 pt-4 md:sticky md:top-0 md:pt-5">
      <PageHeader
        id="source-heading"
        className={HEAD_WRAP}
        icon={Icon}
        title={source.name}
        status={(
          <span role="status" className="flex flex-wrap items-center gap-2">
            <Pill tone={state.tone === "muted" ? "neutral" : state.tone} dot pulse={state.pulse} aria-live={live ? "polite" : undefined}>{headlineOf(source)}</Pill>
            <Pill>{describeRelation(source, website?.host)}</Pill>
          </span>
        )}
        description={descriptionOf(source, website)}
        meta={(
          <>
            <a href={source.seedUrl} target="_blank" rel="noreferrer" className="truncate text-orb-gray underline-offset-4 hover:text-orb-white hover:underline">{source.host}</a>
            <span aria-hidden="true">·</span>
            {/* While crawling, how far it has got replaces when it last finished: that is what
                somebody watching is asking. "Of about", because the total grows as links are found. */}
            {live && progress && (progress.fetched || progress.outstanding) ? (
              <span className="tabular-nums">
                {progress.fetched.toLocaleString("en-US")}
                {progress.outstanding > 0 && ` of about ${(progress.fetched + progress.outstanding).toLocaleString("en-US")}`} pages
              </span>
            ) : source.state === "queued" ? (
              <span>Starts within a minute</span>
            ) : source.lastReadAt ? (
              <span>Last crawl {describeElapsed(source.lastReadAt)}</span>
            ) : (
              <span>Not crawled yet</span>
            )}
            {!live && source.nextReadAt && source.enabled && (
              <>
                <span aria-hidden="true">·</span>
                {source.primary ? (
                  // A visit, not a crawl of every page: each fetches only what is due, and a page on
                  // Manual is never due on a timer.
                  <Tooltip>
                    <TooltipTrigger className="cursor-help border-b border-dotted border-orb-line text-left focus-visible:outline-2 focus-visible:outline-orb-lime">
                      Next visit {describeNextCrawl(source.nextReadAt)}
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      Orbik visits the site on its own to check the sitemaps for new pages. A visit fetches new pages and pages whose crawl frequency has come round; pages on Manual are fetched again only when you ask.
                    </TooltipContent>
                  </Tooltip>
                ) : <span>Next read {describeNextCrawl(source.nextReadAt)}</span>}
              </>
            )}
            {addedBy && (
              <>
                <span aria-hidden="true">·</span>
                <span>added by {addedBy.name} on {formatDate(source.createdAt, { time: false })}</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span>copies into <span className="font-mono">{source.libraryPath}</span></span>
          </>
        )}
        actions={<CrawlButton workspaceId={workspaceId} sourceId={sourceId} scope={scope} source={source} />}
      />

      <nav aria-label={`${source.name}: sections`} className="-mb-px mt-4 flex gap-1 overflow-x-auto">
        {SOURCE_TABS.map((entry) => {
          const current = entry.id === tab;
          const known = entry.id === "pages" && source.pages?.known ? source.pages.known : null;
          return (
            <Link
              key={entry.id}
              href={sourceTabHref(workspaceId, sourceId, entry.id)}
              aria-current={current ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-1.5 border-b-2 px-3 pb-2.5 pt-1 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/70",
                current ? "border-orb-lime text-orb-white" : "border-transparent text-orb-muted hover:text-orb-white",
              )}
            >
              {entry.label}
              {known !== null && <span className="rounded-full bg-orb-raised px-1.5 text-2xs tabular-nums text-orb-gray">{known.toLocaleString("en-US")}</span>}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/**
 * The head's one action: **Crawl now**, or **Stop crawl** while the source is being read or waits
 * to be. When the workspace has no crawl pages to spend the button is disabled and the reason is
 * written under it, since a disabled button's tooltip cannot be opened.
 */
function CrawlButton({ workspaceId, sourceId, scope, source }) {
  const canCrawl = useCan("member", workspaceId);
  const { crawl: overview, refresh: refreshOverview } = useCrawlOverview(scope);
  const { refresh: refreshSource } = useSource(workspaceId, sourceId);
  const revalidate = useRevalidateWorkspace(workspaceId);
  const [busy, setBusy] = useState(false);
  // `{ text, tone }`: only what the pill does not already say (a crawl that was asked for shows as
  // Queued by itself). An answer fades after a few seconds; a refusal stays until the next press.
  const [notice, setNotice] = useState(null);
  useEffect(() => {
    if (notice?.tone !== "cyan") return undefined;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);
  if (!canCrawl) return null;

  const live = isLive(source);
  const blockedReason = live ? null : crawlBlockedReason(overview?.budget);

  async function act(run, said) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await run();
      await Promise.all([refreshSource(), refreshOverview(), revalidate().catch(() => {})]);
      const text = said(result);
      if (text) setNotice({ text, tone: "cyan" });
    } catch (failure) {
      // Refused for want of crawl pages: the API's reason is the answer, and "try again" is not.
      setNotice({
        text: BUDGET_REFUSALS.has(failure?.code) || failure?.code === "CRAWL_RUNNING" ? failure.message : "That did not work. Try again.",
        tone: "coral",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1.5 sm:items-end">
      {live ? (
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => act(() => stopCrawl(scope), (result) => (
          result.stopped === "running" ? "Stopping: the pages it has not read are left for the next crawl."
            : result.stopped === "queued" ? "The crawl that was asked for is taken back." : "Nothing was being read."
        ))}>
          <Square aria-hidden="true" className="size-4" />{busy ? "Stopping…" : "Stop crawl"}
        </Button>
      ) : (
        <Tooltip>
          <TooltipTrigger render={<Button type="button" size="sm" disabled={busy || Boolean(blockedReason)} onClick={() => act(() => requestCrawl(scope), (result) => (
            result.alreadyRunning ? "A crawl is already running." : null
          ))} />}>
            {source.lastReadAt ? <RefreshCw aria-hidden="true" className="size-4" /> : <Play aria-hidden="true" className="size-4" />}
            {busy ? "Asking…" : "Crawl now"}
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            Fetch what is due now: pages never fetched yet, pages somebody asked for, and pages whose crawl frequency has come round. Pages on Manual are not fetched again; Fresh crawl, under Settings, fetches everything.
          </TooltipContent>
        </Tooltip>
      )}
      {blockedReason && <p className="max-w-sm text-xs text-orb-orange sm:text-right">{blockedReason}</p>}
      {notice && <p role="status" className={cn("max-w-sm text-xs sm:text-right", notice.tone === "coral" ? "text-orb-coral" : "text-orb-cyan")}>{notice.text}</p>}
    </div>
  );
}

/** The pill beside the name: the state, shortened. */
function headlineOf(source) {
  switch (source.state) {
    case "first-read": return "First crawl";
    case "reading": return "Reading";
    case "queued": return "Queued";
    case "refused": return "Refused";
    case "rate-limited": return "Asked to slow down";
    case "failed": return "Failed";
    case "stopped": return "Stopped";
    case "out-of-budget": return "Out of crawl pages";
    case "never-read": return "Not read yet";
    default: return "Up to date";
  }
}

/** One sentence on what the source is and how much of its host is read. */
function descriptionOf(source, website) {
  if (source.primary) {
    return `Your website, page by page. Orbik follows every link and sitemap on ${source.host}, and nothing beyond it; every agent, and the Library, works from what its crawl keeps.`;
  }
  if (source.relation === "elsewhere") {
    return `${source.purposeLabel} on ${source.host}. Orbik reads the pages listed here${source.followPagination ? " and their own next pages" : ""}, and nothing else on that site.`;
  }
  const where = describeRelation(source, website?.host) === "Subdomain" ? `a subdomain of ${website?.host?.replace(/^www\./, "")}` : "a site of yours";
  const how = source.mode === "section" ? `only the pages under ${source.section}` : source.mode === "pages" ? "only the pages listed here" : "every link on that host";
  return `${source.purposeLabel} on ${source.host}, ${where}. Orbik follows ${how}, and nothing beyond it.`;
}

/** The head while the source is on its way, shaped like it so nothing jumps. */
function HeadSkeleton() {
  return (
    <SkeletonRegion label="Loading the source…" className="space-y-6">
      <div className="flex gap-4">
        <Skeleton className="size-11 rounded-xl" />
        <div className="flex-1 space-y-2"><Skeleton className="h-7 w-48" /><Skeleton className="h-4 w-full max-w-xl" /></div>
      </div>
      <div className="flex gap-4">{[0, 1, 2].map((key) => <Skeleton key={key} className="h-5 w-20" />)}</div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">{[0, 1, 2, 3, 4].map((key) => <Skeleton key={key} className="h-[6.75rem] rounded-xl" />)}</div>
    </SkeletonRegion>
  );
}
