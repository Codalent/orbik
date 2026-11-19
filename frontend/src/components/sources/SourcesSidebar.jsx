"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { Plus, SatelliteDish } from "lucide-react";

import { LiveActivity } from "@/components/workspaces/LiveActivity";
import { describeState, isLive, shortUrl, sourceHref } from "@/lib/sources/sources";
import { useSources } from "@/lib/sources/useSources";
import { useCan } from "@/lib/workspaces/roles";
import { cn } from "@/lib/utils";
import { SourceGlyph } from "./SourceGlyph";

/**
 * Everything the workspace reads, as the column beside the rail while Sources is open: all of
 * them, then the sites of the workspace's own, then the pages about it elsewhere, and the way to
 * add another. The activity monitor sits at its foot, as it does under the agents.
 *
 * @param {object} props
 * @param {string} props.workspaceId the workspace whose sources are listed
 * @param {string} props.currentPath the route on screen, which marks the current row
 */
export function SourcesSidebar({ workspaceId, currentPath }) {
  const { data } = useSources(workspaceId);
  const canAdd = useCan("member", workspaceId);
  const sources = data?.sources ?? [];
  const own = sources.filter((source) => source.relation === "own");
  const elsewhere = sources.filter((source) => source.relation === "elsewhere");
  const overview = `/workspaces/${workspaceId}/sources`;
  const addHref = `${currentPath ?? overview}?add=1`;
  const here = (href) => currentPath === href || currentPath?.startsWith(`${href}/`);

  return (
    <aside aria-label="Sources sidebar" className="flex w-full shrink-0 flex-col gap-2 border-b border-orb-line p-2 text-sidebar-foreground md:w-60 md:gap-3 md:border-b-0 md:border-r md:p-3">
      <h2 className="px-3 pt-1 font-display text-base font-bold tracking-[-0.02em] text-orb-white max-md:sr-only">Sources</h2>
      <SourcesCompact workspaceId={workspaceId} sources={sources} overview={overview} currentPath={currentPath} addHref={canAdd ? addHref : null} />
      <nav aria-label="Sources" className="relative flex flex-col gap-3 max-md:hidden md:-mr-2 md:min-h-0 md:flex-1 md:overflow-y-auto md:pr-2">
        <div className="border-b border-orb-line/70 px-1 pb-2">
          <Row href={overview} current={currentPath === overview}>
            <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full border border-orb-line text-orb-gray">
              <SatelliteDish className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">All sources</span>
          </Row>
        </div>
        <Group title="Your sites" sources={own} workspaceId={workspaceId} here={here} />
        {elsewhere.length > 0 && <Group title="Elsewhere" sources={elsewhere} workspaceId={workspaceId} here={here} />}
        {canAdd && (
          <div className="border-t border-orb-line/70 px-1 pt-2">
            <Row href={addHref} current={false}>
              <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full border border-dashed border-orb-line text-orb-muted">
                <Plus className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">Add a source</span>
            </Row>
          </div>
        )}
      </nav>
      <div className="md:mt-auto">
        <LiveActivity />
      </div>
    </aside>
  );
}

/** One heading and its sources. */
function Group({ title, sources, workspaceId, here }) {
  if (!sources.length) return null;
  return (
    <div>
      <p className="mb-1 px-3 text-2xs font-medium uppercase tracking-[0.12em] text-orb-muted">{title}</p>
      <ul className="space-y-0.5 px-1">
        {sources.map((source) => {
          const href = sourceHref(workspaceId, source);
          const state = describeState(source);
          const failed = state.tone === "coral";
          return (
            <li key={source.id}>
              <Row href={href} current={here(href)}>
                <SourceGlyph source={source} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium leading-[18px]">{source.name}</span>
                  <span className={cn("truncate text-xs leading-4", failed ? "text-orb-coral" : "text-orb-muted")}>
                    {source.mode === "pages" ? shortUrl(source.pageUrls?.[0] ?? source.seedUrl).split("/")[0] : source.host}
                    {failed ? " · refused" : ""}
                  </span>
                </span>
                {isLive(source) && <span className="sr-only">, being read now</span>}
              </Row>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A sidebar row, drawn as the agents' rows are. */
function Row({ href, current, children }) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring/70",
        current ? "bg-orb-raised text-orb-white" : "text-orb-gray hover:bg-orb-raised/60 hover:text-orb-white",
      )}
    >
      {children}
    </Link>
  );
}

/**
 * The same list as one row that scrolls sideways, for a narrow screen, with the current source
 * scrolled into view.
 */
function SourcesCompact({ workspaceId, sources, overview, currentPath, addHref }) {
  const current = useRef(null);
  useEffect(() => {
    current.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [currentPath]);
  const pill = (active) => cn(
    "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-compact transition-colors",
    active ? "border-orb-line bg-orb-raised text-orb-white" : "border-transparent text-orb-gray hover:text-orb-white",
  );
  return (
    <nav aria-label="Sources" className="-mx-1 flex gap-1 overflow-x-auto px-1 md:hidden">
      <Link href={overview} aria-current={currentPath === overview ? "page" : undefined} ref={currentPath === overview ? current : undefined} className={pill(currentPath === overview)}>All</Link>
      {sources.map((source) => {
        const href = sourceHref(workspaceId, source);
        const active = currentPath === href || currentPath?.startsWith(`${href}/`);
        return (
          <Link key={source.id} href={href} aria-current={active ? "page" : undefined} ref={active ? current : undefined} className={pill(active)}>
            {isLive(source) && <span aria-hidden="true" className="size-1.5 rounded-full bg-orb-lime motion-safe:animate-pulse" />}
            {source.name}
          </Link>
        );
      })}
      {addHref && <Link href={addHref} className={pill(false)}><Plus aria-hidden="true" className="size-3.5" />Add</Link>}
    </nav>
  );
}
