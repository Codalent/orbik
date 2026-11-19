"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { ChevronRight, Plus, SatelliteDish } from "lucide-react";

import { PageFrame } from "@/components/workspaces/PageFrame";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { PageHeader, SectionHeading } from "@/components/ui/page-header";
import { EmptyState, Panel, PanelTitle, RowList } from "@/components/ui/panel";
import { Pill, StatusDot } from "@/components/ui/pill";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { StatTile } from "@/components/ui/stat-tile";
import { dismissSourceSuggestion, sourceSuggestionsPath } from "@/lib/api/sources";
import { describeElapsed } from "@/lib/crawl/format";
import { pathOf } from "@/lib/format";
import { describePages, describeRelation, describeSourceLine, describeState, shortUrl, sourceHref } from "@/lib/sources/sources";
import { useSources } from "@/lib/sources/useSources";
import { useCan } from "@/lib/workspaces/roles";
import { cn } from "@/lib/utils";
import { SourceGlyph } from "./SourceGlyph";

/**
 * All sources: everything Orbik reads for the workspace, with the figures that say how much of it
 * is in the Library, and the pages about the company its website links to that are not read yet.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 */
export function SourcesOverview({ workspaceId }) {
  const { data, failed } = useSources(workspaceId);
  const canAdd = useCan("member", workspaceId);

  if (!data) {
    return (
      <PageFrame label="Sources" className="max-w-6xl">
        {failed
          ? <Alert variant="destructive" role="alert"><AlertDescription>The sources could not be loaded. Refresh to try again.</AlertDescription></Alert>
          : <OverviewSkeleton />}
      </PageFrame>
    );
  }

  const { sources, totals } = data;
  const website = sources.find((source) => source.primary) ?? null;
  const own = sources.filter((source) => source.relation === "own");
  const elsewhere = sources.filter((source) => source.relation === "elsewhere");
  const onTheWay = totals.onTheWay.reduce((sum, entry) => sum + entry.pages, 0);
  const attention = totals.needsAttention;

  return (
    <PageFrame label="Sources" className="max-w-6xl space-y-8">
      <PageHeader
        icon={SatelliteDish}
        title="Sources"
        status={totals.reading > 0 ? <Pill tone="lime" dot pulse>{totals.reading} crawling now</Pill> : null}
        description="Everything Orbik reads for this workspace. Each source is read on its own schedule and copied, word for word, into the Library under /sources, where the knowledge base, Ask and your AI tools find it."
        meta={(
          <>
            <span>{totals.sources} {totals.sources === 1 ? "source" : "sources"}</span>
            {totals.lastChangeAt && (
              <>
                <span aria-hidden="true">·</span>
                <span>last change found {describeElapsed(totals.lastChangeAt)}</span>
              </>
            )}
          </>
        )}
        actions={canAdd && website ? (
          <Link href={`/workspaces/${workspaceId}/sources?add=1`} className={buttonVariants()}>
            <Plus aria-hidden="true" />Add a source
          </Link>
        ) : null}
      />

      {!website ? (
        <EmptyState
          icon={SatelliteDish}
          action={<Link href={`/workspaces/${workspaceId}/sources/website/pages`} className={buttonVariants({ variant: "outline", size: "sm" })}>Set up the website’s crawl</Link>}
        >
          Every workspace reads its website first. Once it is set up, other sites of yours and pages about you elsewhere can be added beside it.
        </EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Sources" value={totals.sources} detail={`${totals.own} of your ${totals.own === 1 ? "site" : "sites"} · ${totals.elsewhere} elsewhere`} />
            <StatTile
              label="Pages in the Library"
              value={totals.libraryPages.toLocaleString("en-US")}
              live={onTheWay > 0}
              detail={onTheWay > 0
                ? `under /sources · ${onTheWay.toLocaleString("en-US")} more on the way${totals.onTheWay.length === 1 ? ` from ${totals.onTheWay[0].name}` : ""}`
                : "under /sources"}
            />
            <StatTile label="Read this month" value={totals.readThisMonth.toLocaleString("en-US")} detail="page fetches, across every source" />
            <StatTile
              label="Needs a look"
              value={attention.length}
              tone={attention.length ? "failed" : null}
              href={attention.length ? sourceHref(workspaceId, sources.find((source) => source.id === attention[0].id)) : undefined}
              detail={attention.length ? `${attention[0].name}: ${attentionWords(attention[0].state)}` : "Every source is being read"}
            />
          </div>

          <section aria-labelledby="own-sources" className="space-y-3">
            <SectionHeading id="own-sources" aside="Orbik follows every link it finds on these hosts">Your sites</SectionHeading>
            <SourceList workspaceId={workspaceId} sources={own} website={website} />
          </section>

          <section aria-labelledby="elsewhere-sources" className="space-y-3">
            <SectionHeading id="elsewhere-sources" aside="Orbik reads only the pages you list, and never follows links off them">About you elsewhere</SectionHeading>
            {elsewhere.length
              ? <SourceList workspaceId={workspaceId} sources={elsewhere} website={website} />
              : (
                <EmptyState icon={SatelliteDish}>
                  A review profile, a directory listing, an article about you: add one, and Orbik reads that page — and nothing else on its site — on the schedule you choose.
                </EmptyState>
              )}
          </section>

          <Suggestions workspaceId={workspaceId} canAdd={canAdd} websiteHost={website.host} />
        </>
      )}
    </PageFrame>
  );
}

/** What a source needing a look needs, in a few words. */
function attentionWords(state) {
  if (state === "refused") return "the site refused OrbikBot";
  if (state === "rate-limited") return "the site asked for fewer requests";
  return "the last read failed";
}

/** A list of sources, one row each. */
function SourceList({ workspaceId, sources, website }) {
  return (
    <RowList>
      {sources.map((source) => {
        const state = describeState(source);
        const pages = describePages(source);
        return (
          <li key={source.id}>
            <Link href={sourceHref(workspaceId, source)} className="flex flex-wrap items-center gap-x-5 gap-y-2 px-3 py-3.5 transition-colors hover:bg-orb-raised/55 sm:px-4">
              <SourceGlyph source={source} size="md" />
              <span className="min-w-[11rem] flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-semibold text-orb-white">{source.name}</span>
                  <Pill>{source.primary ? "Main website" : source.purposeLabel}</Pill>
                </span>
                <span className="mt-0.5 block text-compact text-orb-muted">{describeSourceLine(source)}</span>
              </span>
              <span className="w-26 text-compact tabular-nums text-orb-gray">
                <span className="text-sm font-semibold text-orb-white">{pages.value.toLocaleString("en-US")}</span>
                {pages.of !== null ? ` of ${pages.of.toLocaleString("en-US")}` : ` ${pages.value === 1 ? "page" : "pages"}`}
              </span>
              <span className="hidden w-36 truncate font-mono text-xs text-orb-muted sm:block">{source.libraryPath}</span>
              <span className={cn("flex w-52 items-center gap-1.5 text-compact", state.tone === "coral" ? "text-orb-coral" : state.pulse ? "text-orb-white" : "text-orb-gray")}>
                <StatusDot tone={state.tone === "muted" ? "neutral" : state.tone} pulse={state.pulse} />
                <span className="truncate">{state.label}</span>
              </span>
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-orb-muted" />
              <span className="sr-only">{describeRelation(source, website?.host)}</span>
            </Link>
          </li>
        );
      })}
    </RowList>
  );
}

/**
 * Pages about the company its website links to — a review profile, a directory listing, its code —
 * which are not sources yet. Each can be added, which opens the dialog with the address filled
 * in, or dismissed for good. A page whose site asks crawlers to stay away is shown with why.
 */
function Suggestions({ workspaceId, canAdd, websiteHost }) {
  const { data, mutate } = useSWR(sourceSuggestionsPath(workspaceId));
  const [error, setError] = useState(null);
  const items = data?.items ?? [];
  if (!items.length) return null;
  const toReview = items.filter((item) => item.readable).length;

  async function dismiss(url) {
    setError(null);
    try {
      await dismissSourceSuggestion(workspaceId, url);
      await mutate({ items: items.filter((item) => item.url !== url) }, { revalidate: true });
    } catch (failure) {
      setError(failure.message ?? "That could not be dismissed.");
    }
  }

  return (
    <Panel>
      <PanelTitle aside={<span className="text-xs text-orb-muted">Pages about you that {websiteHost} links to</span>}>
        <span className="flex flex-wrap items-center gap-2">
          Found on your website
          {toReview > 0 && <Pill tone="orange">{toReview} to review</Pill>}
        </span>
      </PanelTitle>
      {error && <p role="alert" className="mb-2 text-compact text-orb-coral">{error}</p>}
      <RowList>
        {items.map((item) => (
          <li key={item.url} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:px-4">
            <span className="min-w-[11rem] flex-1">
              <span className={cn("block text-sm", item.readable ? "text-orb-white" : "text-orb-gray")}>{shortUrl(item.url)}</span>
              <span className="mt-0.5 block text-xs text-orb-muted">
                {item.readable
                  ? `${item.label} · linked from ${item.pages > 20 ? `${item.pages.toLocaleString("en-US")} pages` : item.linkedFrom ? `${websiteHost}${pathOf(item.linkedFrom) === "/" ? "" : pathOf(item.linkedFrom)}` : `${item.pages} pages`}`
                  : item.reason}
              </span>
            </span>
            {item.readable ? (
              canAdd && (
                <span className="flex gap-2">
                  <Link href={`/workspaces/${workspaceId}/sources?add=${encodeURIComponent(item.url)}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Add</Link>
                  <Button type="button" variant="ghost" size="sm" onClick={() => dismiss(item.url)}>Dismiss</Button>
                </span>
              )
            ) : (
              <span className="flex items-center gap-2 text-xs text-orb-muted">
                Cannot be read
                {canAdd && <Button type="button" variant="ghost" size="sm" onClick={() => dismiss(item.url)}>Dismiss</Button>}
              </span>
            )}
          </li>
        ))}
      </RowList>
    </Panel>
  );
}

function OverviewSkeleton() {
  return (
    <SkeletonRegion label="Loading the sources…" className="space-y-8">
      <div className="flex gap-4"><Skeleton className="size-11 rounded-xl" /><div className="flex-1 space-y-2"><Skeleton className="h-7 w-40" /><Skeleton className="h-4 w-full max-w-xl" /></div></div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((key) => <Skeleton key={key} className="h-26 rounded-xl" />)}</div>
      <Skeleton className="h-36 rounded-lg" />
      <Skeleton className="h-36 rounded-lg" />
    </SkeletonRegion>
  );
}
