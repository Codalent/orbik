"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, Info, LibraryBig, Play, RefreshCw, Square } from "lucide-react";

import { PageFrame } from "@/components/workspaces/PageFrame";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Panel, PanelTitle, RowList } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { requestCrawl, stopCrawl, crawlScope } from "@/lib/api/crawl";
import { useRevalidateWorkspace } from "@/lib/api/cache";
import { describeDuration, describeElapsed, describeNextCrawl } from "@/lib/crawl/format";
import { formatDate, pathOf, personFromEmail } from "@/lib/format";
import { describeRelation, describeState, isLive, libraryHref, shortUrl } from "@/lib/sources/sources";
import { useSource, useSources } from "@/lib/sources/useSources";
import { useCan } from "@/lib/workspaces/roles";
import { cn } from "@/lib/utils";
import { sourceIcon } from "./SourceGlyph";
import { SourceSettings } from "./SourceSettings";

/**
 * One source: what it is, how it is doing, its settings, and what is in the Library from it.
 *
 * The website has a page like every other source; its pages — the tree, the frequencies, the crawl
 * logs — are one link away, at `…/sources/website/pages`, as every source's are.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 * @param {string} props.sourceId a source id, or `website`
 */
export function SourcePage({ workspaceId, sourceId }) {
  const router = useRouter();
  const { data, failed, error, refresh } = useSource(workspaceId, sourceId);
  const { data: list } = useSources(workspaceId);
  const revalidate = useRevalidateWorkspace(workspaceId);
  const canCrawl = useCan("member", workspaceId);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);

  if (!data) {
    return (
      <PageFrame label="Source" className="max-w-6xl">
        {failed ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>
              {error?.code === "SOURCE_NOT_FOUND" ? "This source is not in this workspace any more." : "This source could not be loaded. Refresh to try again."}
            </AlertDescription>
          </Alert>
        ) : <SourceSkeleton />}
      </PageFrame>
    );
  }

  const { source } = data;
  const website = list?.sources?.find((entry) => entry.primary) ?? null;
  const state = describeState(source);
  const live = isLive(source);
  const reading = source.state === "reading" || source.state === "first-read";
  const scope = crawlScope(workspaceId, source.primary ? "website" : source.id);
  const Icon = sourceIcon(source);
  const addedBy = personFromEmail(source.addedBy?.email);
  const pagesHref = `/workspaces/${workspaceId}/sources/${source.primary ? "website" : source.id}/pages`;

  /** Runs one action on the source's crawl, then reads everything again. */
  async function act(name, run) {
    setBusy(name);
    setNotice(null);
    try {
      const result = await run();
      if (name === "read") setNotice(result.alreadyRunning ? "It is being read already." : "Asked for: it starts within a minute.");
      if (name === "stop") setNotice(result.stopped === "running" ? "Stopping: the pages it has not read are left for the next read." : result.stopped === "queued" ? "The read that was asked for is taken back." : "Nothing was being read.");
      await Promise.all([revalidate(), refresh()]);
    } catch (failure) {
      setNotice(failure.message ?? "That did not work.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <PageFrame label={source.name} className="max-w-6xl space-y-7">
      <PageHeader
        icon={Icon}
        title={source.name}
        status={(
          <>
            <Pill tone={state.tone === "muted" ? "neutral" : state.tone} dot pulse={state.pulse}>{headlineOf(source)}</Pill>
            <Pill>{describeRelation(source, website?.host)}</Pill>
          </>
        )}
        description={descriptionOf(source, website)}
        meta={(
          <>
            {reading && source.activeRun
              ? <span>Started {describeElapsed(source.activeRun.startedAt)}</span>
              : source.lastReadAt ? <span>Read {formatDate(source.lastReadAt)}</span> : <span>Not read yet</span>}
            {!live && source.nextReadAt && source.enabled && (
              <>
                <span aria-hidden="true">·</span>
                <span>next read {describeNextCrawl(source.nextReadAt)}</span>
              </>
            )}
            {addedBy && (
              <>
                <span aria-hidden="true">·</span>
                <span>added by {addedBy.name} on {formatDate(source.createdAt, { time: false })}</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span>copies into {source.libraryPath}</span>
          </>
        )}
        actions={(
          <>
            {canCrawl && (live ? (
              <Button type="button" variant="outline" disabled={busy !== null} onClick={() => act("stop", () => stopCrawl(scope))}>
                <Square aria-hidden="true" />{busy === "stop" ? "Stopping…" : "Stop crawl"}
              </Button>
            ) : (
              <Button type="button" variant="outline" disabled={busy !== null} onClick={() => act("read", () => requestCrawl(scope))}>
                {source.lastReadAt ? <RefreshCw aria-hidden="true" /> : <Play aria-hidden="true" />}{busy === "read" ? "Asking…" : "Read now"}
              </Button>
            ))}
            <Link href={libraryHref(workspaceId, source.libraryPath)} className={buttonVariants({ variant: "outline" })}>
              <LibraryBig aria-hidden="true" />Open in Library
            </Link>
          </>
        )}
      />

      {notice && <p role="status" className="text-compact text-orb-cyan">{notice}</p>}
      {source.latestRun?.error && !live && ["refused", "rate-limited", "failed"].includes(source.state) && (
        <Alert variant="destructive" role="alert"><AlertDescription>{source.latestRun.error.message}</AlertDescription></Alert>
      )}
      {source.state === "out-of-budget" && (
        <p className="text-compact text-orb-orange">The last read stopped when this month’s crawl pages ran out. The pages it did not reach are read next time.</p>
      )}

      {live && <Progress source={source} leftOut={data.leftOut?.total ?? 0} />}

      <div className="flex flex-wrap items-start gap-6">
        <div className="min-w-0 flex-[999_1_28rem]">
          <SourceSettings
            key={source.id}
            workspaceId={workspaceId}
            source={source}
            detail={data}
            purposes={list?.purposes ?? []}
            onSaved={async () => { await Promise.all([revalidate(), refresh()]); }}
            onRemoved={() => router.replace(`/workspaces/${workspaceId}/sources`)}
          />
        </div>
        <aside aria-label={`About ${source.name}`} className="flex min-w-0 flex-[1_1_18rem] flex-col gap-4">
          {source.mode === "pages"
            ? <LastRead source={source} detail={data} />
            : <LatestPages source={source} detail={data} pagesHref={pagesHref} />}
          {!source.primary && source.relation === "own" && data.website?.linksHere > 0 && <NextToWebsite source={source} detail={data} />}
          <TheCopy workspaceId={workspaceId} source={source} detail={data} />
          {data.quotedIn?.total > 0 && <QuotedIn workspaceId={workspaceId} quoted={data.quotedIn} />}
          {source.mode === "pages" && (
            <Link href={pagesHref} className="flex items-center gap-1 self-start text-xs text-orb-cyan hover:underline">
              Every page, with its crawl history <ArrowRight aria-hidden="true" className="size-3" />
            </Link>
          )}
        </aside>
      </div>
    </PageFrame>
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
    return `Your website, ${source.host}. Orbik follows every link and sitemap on that host, and nothing beyond it; other sites of yours are sources of their own.`;
  }
  if (source.relation === "elsewhere") {
    return `${source.purposeLabel} on ${source.host}. Orbik reads the pages listed here${source.followPagination ? " and their own next pages" : ""}, and nothing else on that site.`;
  }
  const where = describeRelation(source, website?.host) === "Subdomain" ? `a subdomain of ${website?.host?.replace(/^www\./, "")}` : "a site of yours";
  const how = source.mode === "section" ? `only the pages under ${source.section}` : source.mode === "pages" ? "only the pages listed here" : "every link on that host";
  return `${source.purposeLabel} on ${source.host}, ${where}. Orbik follows ${how}, and nothing beyond it.`;
}

/** How far the read in progress has got: copied, left out, waiting. */
function Progress({ source, leftOut }) {
  const progress = source.progress ?? { fetched: 0, outstanding: 0, discovered: 0 };
  const total = progress.fetched + progress.outstanding + leftOut;
  const share = (value) => (total ? `${Math.min(100, (value / total) * 100)}%` : "0%");
  const queued = source.state === "queued";
  return (
    <Panel aria-labelledby="source-progress">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="source-progress" className="text-sm font-semibold text-orb-white">
          {queued ? `Waiting to read ${source.host}` : `${source.mode === "pages" ? "Reading" : "Copying"} ${source.host}`}
        </h2>
        <span className="text-xs tabular-nums text-orb-muted">
          {queued
            ? "Starts within a minute"
            : `${Math.max(progress.discovered, progress.fetched + progress.outstanding).toLocaleString("en-US")} pages found so far`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Pages read"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={progress.fetched}
        className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-orb-raised"
      >
        <div className={cn("bg-orb-lime", queued && "motion-safe:animate-pulse")} style={{ width: share(progress.fetched) }} />
        <div className="bg-orb-muted" style={{ width: share(leftOut) }} />
      </div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-compact tabular-nums text-orb-gray">
        <Legend swatch="bg-orb-lime" value={progress.fetched}>read</Legend>
        <Legend swatch="bg-orb-muted" value={leftOut}>left out</Legend>
        <Legend swatch="bg-orb-raised ring-1 ring-inset ring-orb-line" value={progress.outstanding}>waiting</Legend>
      </div>
    </Panel>
  );
}

function Legend({ swatch, value, children }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={cn("size-2 rounded-xs", swatch)} />
      <span className="font-semibold text-orb-white">{value.toLocaleString("en-US")}</span> {children}
    </span>
  );
}

/** The pages a site's last read went through, and what it left out and why. */
function LatestPages({ source, detail, pagesHref }) {
  const read = detail.latestRead ?? [];
  const left = detail.leftOut?.items ?? [];
  const known = source.pages?.known ?? 0;
  return (
    <Panel>
      <PanelTitle aside={<Link href={pagesHref} className="text-xs text-orb-cyan hover:underline">{known ? `All ${known.toLocaleString("en-US")} pages` : "Every page"}</Link>}>
        Latest pages
      </PanelTitle>
      {read.length + left.length === 0 ? (
        <p className="text-compact text-orb-muted">Nothing read yet. Pages appear here as they are copied.</p>
      ) : (
        <RowList className="text-compact">
          {read.map((page, index) => (
            <li key={page.url} className="px-3 py-2">
              <span className="block truncate font-mono text-xs text-orb-white">{pathOf(page.url)}</span>
              {index === 0 && isLive(source)
                ? <span className="mt-0.5 inline-flex items-center gap-1.5 text-xs text-orb-lime"><span aria-hidden="true" className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" />Read just now</span>
                : <span className="mt-0.5 block text-xs text-orb-muted">{page.status >= 400 ? `Answered ${page.status}` : "Copied"} · {describeElapsed(page.fetchedAt)}</span>}
            </li>
          ))}
          {left.map((page) => (
            <li key={`left-${page.url}`} className="px-3 py-2">
              <span className="block truncate font-mono text-xs text-orb-gray">{pathOf(page.url)}</span>
              <span className="mt-0.5 block text-xs text-orb-muted">
                {page.reason === "robots" ? "Left out: robots.txt asks crawlers not to read it" : page.reason === "outside-section" ? `Left out: not under ${source.section}` : "Left out by one of your rules"}
              </span>
            </li>
          ))}
        </RowList>
      )}
    </Panel>
  );
}

/** What the last read of a list of pages found, page by page. */
function LastRead({ source, detail }) {
  // Every page on the list, read or not yet, then the next pages found from them.
  const known = detail.pages ?? [];
  const unread = (source.pageUrls ?? [])
    .filter((url) => !known.some((page) => page.url === url))
    .map((url) => ({ url, urlHash: url, title: null, status: null, crawledAt: null, changedAt: null, listed: true }));
  const pages = [...known, ...unread];
  const last = detail.lastRead;
  const since = last?.at ? new Date(last.at).getTime() - (last.durationMs ?? 0) - 60_000 : null;
  return (
    <Panel>
      <PanelTitle aside={last ? <span className="text-xs text-orb-muted">{describeElapsed(last.at)}{last.durationMs ? ` · ${describeDuration(last.durationMs)}` : ""}</span> : null}>
        Last read
      </PanelTitle>
      {!pages.length ? (
        <p className="text-compact text-orb-muted">Nothing read yet.</p>
      ) : (
        <RowList className="text-compact">
          {pages.map((page) => {
            const changed = since !== null && page.changedAt && new Date(page.changedAt).getTime() >= since;
            const failedPage = page.status >= 400;
            return (
              <li key={page.urlHash} className="flex items-center gap-2 px-3 py-2">
                <span className={cn("min-w-0 flex-1 truncate", page.listed ? "text-orb-gray" : "pl-3 text-orb-muted")}>{page.title ?? shortUrl(page.url)}</span>
                {failedPage ? <span className="text-orb-coral">Answered {page.status}</span>
                  : !page.crawledAt ? <span className="text-orb-muted">Not read yet</span>
                    : changed ? <span className="inline-flex items-center gap-1.5 text-orb-white"><span aria-hidden="true" className="size-1.5 rounded-full bg-orb-lime" />Changed</span>
                      : <span className="text-orb-muted">No change</span>}
              </li>
            );
          })}
        </RowList>
      )}
      {source.pages.chosen > 0 && (
        <p className="mt-2.5 text-xs text-orb-muted">
          The knowledge base is written from {source.pages.chosen === 1 ? "this page" : `these ${source.pages.chosen} pages`}; the Library agent reads what changed on its next run.
        </p>
      )}
    </Panel>
  );
}

/** A site of the company's own that its website links to: why its pages are not read twice. */
function NextToWebsite({ source, detail }) {
  return (
    <Panel className="border-orb-cyan/30 bg-orb-cyan/5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-orb-white">
        <Info aria-hidden="true" className="size-4 text-orb-cyan" />Next to your website
      </h2>
      <p className="mt-2 text-compact leading-[19px] text-orb-gray">
        {detail.website.host} links here from {detail.website.linksHere.toLocaleString("en-US")} {detail.website.linksHere === 1 ? "page" : "pages"}. Those links are left to this source rather than crawled twice: each host is read by the one source it belongs to.
      </p>
      <p className="mt-2 text-compact leading-[19px] text-orb-gray">
        Both draw on the workspace’s crawl budget{source.pages.known ? `: this source has about ${source.pages.known.toLocaleString("en-US")} pages to read` : ""}.
      </p>
    </Panel>
  );
}

/** The source's folder of the Library, a few files deep. */
function TheCopy({ workspaceId, source, detail }) {
  const files = detail.library?.items ?? [];
  const total = detail.library?.total ?? 0;
  return (
    <Panel>
      <PanelTitle aside={<Link href={libraryHref(workspaceId, source.libraryPath)} className="text-xs text-orb-cyan hover:underline">Open in Library</Link>}>
        The copy
      </PanelTitle>
      <div className="rounded-lg bg-orb-space/70 px-3 py-2.5 font-mono text-xs leading-[22px]">
        <div className="text-orb-gray">{source.libraryPath}</div>
        {files.length === 0
          ? <div className="pl-4 text-orb-muted">nothing copied yet</div>
          : files.map((file) => (
            <Link key={file.path} href={libraryHref(workspaceId, file.path)} className="block truncate pl-4 text-orb-white hover:text-orb-cyan">
              {file.path.slice(source.libraryPath.length + 1)}
            </Link>
          ))}
        {total > files.length && <div className="pl-4 text-orb-muted">and {(total - files.length).toLocaleString("en-US")} more</div>}
      </div>
      <p className="mt-2.5 text-xs text-orb-muted">
        {source.knowledgeUse === "copy"
          ? "Copied only: searchable by Ask and your AI tools, never written into the knowledge base."
          : `${source.pages.chosen.toLocaleString("en-US")} of ${source.pages.copied.toLocaleString("en-US")} copied ${source.pages.copied === 1 ? "page is" : "pages are"} what the knowledge base is written from.`}
      </p>
    </Panel>
  );
}

/** The knowledge base's files that cite pages of this source. */
function QuotedIn({ workspaceId, quoted }) {
  return (
    <Panel>
      <PanelTitle aside={<span className="text-xs text-orb-muted">{quoted.total} Library {quoted.total === 1 ? "file" : "files"}</span>}>
        Quoted in
      </PanelTitle>
      <ul className="flex flex-col gap-2 text-compact">
        {quoted.items.map((file) => (
          <li key={file.path} className="flex items-baseline gap-2">
            <Link href={libraryHref(workspaceId, file.path)} className="min-w-0 flex-1 truncate text-orb-cyan hover:underline">{file.title ?? file.path}</Link>
            <span className="tabular-nums text-orb-muted">{file.pages} {file.pages === 1 ? "page" : "pages"}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function SourceSkeleton() {
  return (
    <SkeletonRegion label="Loading the source…" className="space-y-7">
      <div className="flex gap-4"><Skeleton className="size-11 rounded-xl" /><div className="flex-1 space-y-2"><Skeleton className="h-7 w-48" /><Skeleton className="h-4 w-full max-w-xl" /></div></div>
      <div className="flex flex-wrap gap-6">
        <div className="flex-[999_1_28rem] space-y-4">{[0, 1, 2].map((key) => <Skeleton key={key} className="h-36 rounded-xl" />)}</div>
        <div className="flex-[1_1_18rem] space-y-4">{[0, 1].map((key) => <Skeleton key={key} className="h-44 rounded-xl" />)}</div>
      </div>
    </SkeletonRegion>
  );
}
