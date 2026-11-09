"use client";

import { useMemo } from "react";
import { Globe, History } from "lucide-react";
import useSWR from "swr";

import { useLibrary } from "./libraryContext";
import { libraryFreshnessPath } from "@/lib/api/library";
import { formatShortDate, hostAndPath } from "@/lib/library/library";
import { cn } from "@/lib/utils";

/**
 * Which files are behind the site, read once for the whole page.
 *
 * The API compares the content hash each file recorded for every page it was written from with the
 * page's hash now, and leaves out pages whose new version the agent has already read. The read is
 * keyed on the Library's last write, so a run rewriting a file clears its mark without anything
 * asking, and on the tab being looked at again, which is when a crawl that moved a page shows up.
 *
 * @returns {{byPath: Map<string, object>, behind: object[], checked: number}}
 */
export function useLibraryFreshness() {
  const library = useLibrary();
  const stamp = Date.parse(library.state?.stats?.updatedAt ?? "") || 0;
  const read = useSWR(library.workspaceId ? libraryFreshnessPath(library.workspaceId, stamp) : null, { keepPreviousData: true });
  const behind = read.data?.behind ?? EMPTY;
  const byPath = useMemo(() => new Map(behind.map((file) => [file.path, file])), [behind]);
  return { byPath, behind, checked: read.data?.checked ?? 0 };
}

const EMPTY = Object.freeze([]);

/** Where a click on a page opens it: beside the file, or in a new tab with a modifier held. */
function sourceTarget(event) {
  return event?.metaKey || event?.ctrlKey || event?.altKey || event?.button === 1 ? "tab" : "right";
}

/** How a file's freshness entry reads as a short phrase: "2 pages changed · 1 gone". */
export function behindLabel(entry) {
  const parts = [];
  if (entry.changed.length) parts.push(`${entry.changed.length} ${entry.changed.length === 1 ? "page" : "pages"} changed`);
  if (entry.gone.length) parts.push(`${entry.gone.length} gone`);
  return parts.join(" · ");
}

/**
 * The note above a file that is behind the site: how many of the pages it was written from have
 * moved since, which ones (each opening its copy beside the file), and what will happen next.
 *
 * What happens next is said from what is true, not promised: a changed page the knowledge base is
 * written from starts the agent's next write run on its own while the agent is set to work; a page
 * left out of the writing does not, and the note says how to have it read; a paused agent rewrites
 * nothing.
 *
 * @param {object} props
 * @param {object} props.node the open file
 */
export function FreshnessNote({ node }) {
  const library = useLibrary();
  const { byPath } = useLibraryFreshness();
  const entry = byPath.get(node.path);
  if (!entry) return null;

  const total = entry.pages;
  const since = entry.writtenAt ? ` since ${formatShortDate(entry.writtenAt)}` : " since it was written";
  const of = (count) => `${count === total && total > 1 ? "All" : count.toLocaleString()} of the ${total.toLocaleString()} ${total === 1 ? "page" : "pages"} this file was written from`;
  const sentence = entry.changed.length && entry.gone.length
    ? `${of(entry.changed.length)} changed${since}, and ${entry.gone.length.toLocaleString()} ${entry.gone.length === 1 ? "is" : "are"} no longer on the site.`
    : entry.changed.length
      ? `${of(entry.changed.length)} changed${since}.`
      : `${of(entry.gone.length)} ${entry.gone.length === 1 ? "is" : "are"} no longer on the site.`;
  const next = library.work?.inFlight
    ? "The agent is running now; when it finishes this file may already be up to date."
    : !library.work?.working
      ? "The agent is paused, so this file stays as it is until it is set to work — or until you correct it yourself."
      : entry.changed.length > 0 && entry.changed.every((page) => !page.chosen)
        ? "These pages are left out of what the agent writes from, so a change to them does not start a run. Include them in the source ledger, or correct the file yourself."
        : "The agent reads the changed pages on its next run and rewrites what they affect.";

  return (
    <div role="status" className="mb-6 rounded-xl border border-orb-orange/40 bg-orb-orange/[0.06] px-4 py-3" data-testid="library-freshness">
      <p className="flex items-start gap-2.5 text-compact text-orb-white">
        <History aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-orb-orange" />
        <span className="min-w-0">
          <span className="font-medium">Behind the site.</span> {sentence}
          <span className="mt-0.5 block text-xs text-orb-gray">{next}</span>
        </span>
      </p>
      <ul className="mt-2.5 flex flex-wrap gap-1.5 pl-[26px]" aria-label="Pages that moved">
        {entry.changed.map((page) => <PageChip key={page.key} page={page} state="changed" />)}
        {entry.gone.map((page) => <PageChip key={page.key} page={page} state="gone" />)}
      </ul>
    </div>
  );
}

/** One page that moved, as a chip: its copy opens beside the file; a page that is gone is struck. */
function PageChip({ page, state }) {
  const library = useLibrary();
  const label = page.title || (page.url ? hostAndPath(page.url) : page.key);
  const body = (
    <>
      <Globe aria-hidden="true" className="size-3 shrink-0" />
      <span className={cn("truncate", state === "gone" && "line-through")}>{label}</span>
      <span className="shrink-0 text-2xs text-orb-muted">{state === "gone" ? "gone" : "changed"}</span>
    </>
  );
  const chip = "inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border px-2 text-xs";
  return (
    <li className="min-w-0 max-w-full">
      {page.copyPath && state !== "gone" ? (
        <button
          type="button"
          onClick={(event) => library.open(page.copyPath, sourceTarget(event))}
          title={`${label} — opens the page as it is now, beside this file`}
          className={cn(chip, "border-orb-line bg-orb-space/70 text-orb-cyan transition-colors hover:border-orb-cyan/50 hover:text-orb-white")}
        >
          {body}
        </button>
      ) : (
        <span className={cn(chip, "border-orb-line text-orb-muted")}>{body}</span>
      )}
    </li>
  );
}

/** The mark beside a source in "Written from" when the page moved since the file was written. */
export function SourceMoved({ entry, sourceKey }) {
  if (!entry) return null;
  const gone = entry.gone.some((page) => page.key === sourceKey);
  const changed = !gone && entry.changed.some((page) => page.key === sourceKey);
  if (!gone && !changed) return null;
  return (
    <span className={cn("ml-1.5 shrink-0 rounded-full border px-1.5 text-2xs leading-4", gone ? "border-orb-line text-orb-muted" : "border-orb-orange/40 text-orb-orange")}>
      {gone ? "gone" : "changed"}
    </span>
  );
}
