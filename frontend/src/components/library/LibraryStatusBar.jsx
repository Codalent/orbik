"use client";

import useSWR from "swr";

import { useLibrary } from "./libraryContext";
import { useLibraryFreshness } from "./LibraryFreshness";
import { libraryNodePath } from "@/lib/api/library";
import { cn } from "@/lib/utils";

/**
 * The line along the foot of the Library: the agent and the site on the left, the open file on
 * the right.
 *
 * The left half is how much of the site is in here, as arithmetic rather than as a claim the last
 * run made about itself: pages stored against pages found, and how many are still to come. The
 * right half is the file in the focused pane — how long it is, which revision, and whether what is
 * on screen is saved — because that is the one question somebody editing asks of the page without
 * wanting to look for the answer.
 *
 * The file is read from the cache the pane already filled, never fetched for this line.
 *
 * @param {object} props
 * @param {string|null} props.activePath the file in the focused pane
 * @param {object|null} props.activeTab that pane's tab in front
 */
export function LibraryStatusBar({ activePath, activeTab }) {
  const library = useLibrary();
  const { work, state } = library;
  const { data } = useSWR(activePath ? libraryNodePath(library.workspaceId, activePath) : null, {
    revalidateOnMount: false,
    revalidateOnFocus: false,
    revalidateIfStale: false,
  });
  const node = data?.node?.path === activePath ? data.node : null;
  const { behind } = useLibraryFreshness();
  const draft = activeTab ? library.drafts[activeTab.id] : null;
  const editing = Boolean(activeTab?.editing && node?.kind === "file");
  const coverage = state?.coverage;
  const outstanding = (coverage?.pending ?? 0) + (coverage?.failed ?? 0);
  const words = editing && draft
    ? countWords(draft.blocks.map((block) => block.text).join(" "))
    : node?.kind === "file" ? node.words ?? null : null;
  const agent = work.inFlight ? "working now" : !work.working ? "paused" : work.run?.status === "failed" ? "last run failed" : "idle";

  return (
    <footer className="hidden h-7 shrink-0 items-center gap-4 overflow-hidden border-t border-orb-line bg-orb-black px-3 text-xs whitespace-nowrap tabular-nums text-orb-muted md:flex">
      <span className="inline-flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 rounded-full",
            work.inFlight ? "bg-orb-lime motion-safe:animate-pulse" : work.working ? "border border-dashed border-orb-muted" : "bg-orb-line",
          )}
        />
        Knowledge base agent {agent}
      </span>
      {coverage?.pages > 0 && (
        <span>
          {coverage.stored.toLocaleString()} of {coverage.pages.toLocaleString()} pages stored
          {outstanding > 0 && ` · ${outstanding.toLocaleString()} to go`}
        </span>
      )}
      {behind.length > 0 && (
        <span className="inline-flex items-center gap-1.5 text-orb-orange">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-orb-orange" />
          {behind.length.toLocaleString()} {behind.length === 1 ? "file" : "files"} behind the site
        </span>
      )}
      <span className="flex-1" />
      {editing && <span>Editing · Saves when you press Done</span>}
      {editing && <span>Markdown</span>}
      {words !== null && <span>{words.toLocaleString()} {words === 1 ? "word" : "words"}</span>}
      {node?.kind === "file" && !node.path.startsWith("/sources/") && <span>Revision {node.revision}</span>}
      {node?.kind === "file" && !node.path.startsWith("/sources/") && (
        <span className={cn(draft?.dirty && "text-orb-white")}>{draft?.dirty ? "Unsaved changes" : "Saved"}</span>
      )}
    </footer>
  );
}

/** How many words a stretch of Markdown holds, counting what a reader would. */
function countWords(text) {
  return String(text ?? "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_match, path, label) => label || path)
    .replace(/[#>*_`[\]()-]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
}
