"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useAuth } from "@/lib/auth/AuthProvider";
import { formatDate } from "@/lib/format";
import { LIBRARY_AGENT_SLUG, personLabel } from "@/lib/library/library";
import { diffBlocks, flattenBlock, splitBlocks } from "@/lib/library/markdown";
import { cn } from "@/lib/utils";

/** How many changed passages a collapsed diff shows before it says how many are left. */
const DIFF_PREVIEW = 4;

/**
 * One file's history, and the way back to any of it.
 *
 * History is not a nicety here. Two writers share every Library file, so "the agent replaced the
 * paragraph I wrote last week" has to be answerable with the text rather than with an apology —
 * and a person who deleted a file needs it back. So each version says who wrote it and, when it is
 * opened, what it actually changed: the passages that went and the ones that took their place.
 * The server keeps the versions, not a diff, so the comparison is made here.
 *
 * Restoring writes a new version rather than winding the history back, so the restore is itself
 * visible and itself reversible. It is also a person's write, so a passage of theirs that the old
 * version lacks is recorded as one they removed — which the note under the button says before
 * anybody presses it.
 *
 * @param {object} props
 * @param {{path: string, revisions: Array<object>}} props.revisions
 * @param {Array<string>} [props.userBlocks] the passages people wrote in the file as it is now
 * @param {Array<{userId: string, email: string}|null>|null} [props.userBlockAuthors] who wrote each
 * @param {number|null} [props.initialRevision] the version to open with; by default the one before
 *   the current, which is what somebody opening History usually wants to compare against
 */
export function LibraryRevisions({ revisions, userBlocks = [], userBlockAuthors = null, initialRevision = null, busy, onClose, onRestore }) {
  const entries = revisions.revisions ?? [];
  const viewerId = useAuth().user?.id ?? null;
  const [open, setOpen] = useState(initialRevision ?? entries[1]?.revision ?? entries[0]?.revision ?? null);
  const [full, setFull] = useState(null);

  return (
    <Sheet open onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-120">
        <SheetHeader className="border-b border-orb-line pr-12">
          <SheetTitle>
            History of <span className="font-mono text-[0.9em] font-normal">{revisions.path}</span>
          </SheetTitle>
          <SheetDescription>
            The last 20 versions are kept. Restoring one saves it as a new version, so nothing here is lost.
          </SheetDescription>
        </SheetHeader>

        <ol className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3">
          {entries.map((entry, index) => {
            const previous = entries[index + 1] ?? null;
            const expanded = entry.revision === open;
            return (
              <li
                key={entry.revision}
                className={cn("rounded-2xl", expanded && "bg-orb-space shadow-[inset_0_0_0_1px] shadow-orb-white/10")}
              >
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : entry.revision)}
                  className={cn(
                    "w-full rounded-2xl px-3 py-3 text-left",
                    expanded ? "pb-2" : "hover:bg-orb-space/60",
                  )}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-orb-white">
                    Revision {entry.revision}
                    {index === 0 && (
                      <span className="rounded-full border border-orb-line px-2 py-px text-2xs font-normal text-orb-gray">
                        current
                      </span>
                    )}
                    {entry.deleted && (
                      <span className="rounded-full border border-orb-coral/40 px-2 py-px text-2xs font-normal text-orb-coral">
                        deleted
                      </span>
                    )}
                    <span className="flex-1" />
                    <span className="text-xs font-normal tabular-nums text-orb-muted">{formatDate(entry.createdAt)}</span>
                  </span>
                  <span className="mt-1 block text-compact text-orb-gray">{describe(entry, previous, viewerId)}</span>
                </button>

                {expanded && (
                  <div className="flex flex-col gap-3 px-3 pb-3.5 pt-1">
                    {/* The first version has nothing to be compared with, so it shows itself
                        rather than a diff that would mark every line as added. */}
                    {full === entry.revision || !previous ? (
                      <pre className="max-h-96 overflow-auto rounded-xl bg-orb-black/50 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-orb-gray">
                        {entry.markdown ?? "(no text)"}
                      </pre>
                    ) : (
                      <Diff entry={entry} previous={previous} />
                    )}

                    <div className="flex flex-wrap gap-1.5">
                      {index > 0 && onRestore && (
                        <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => onRestore(entry.revision)}>
                          <RotateCcw aria-hidden="true" className="size-3.5" /> Restore revision {entry.revision}
                        </Button>
                      )}
                      {previous && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setFull(full === entry.revision ? null : entry.revision)}
                        >
                          {full === entry.revision ? "Show what changed" : "Open full version"}
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-orb-muted">
                      {index === 0
                        ? "This is what the file says now."
                        : onRestore ? restoreNote(entry, entries[0], userBlocks, userBlockAuthors, viewerId) : null}
                    </p>
                  </div>
                )}
              </li>
            );
          })}
          {!entries.length && <li className="px-3 py-2 text-sm text-orb-muted">No history yet.</li>}
        </ol>
      </SheetContent>
    </Sheet>
  );
}

/** What one version did to the one before it, as the passages that went and came. */
function Diff({ entry, previous }) {
  const changes = sectionedChanges(previous?.markdown ?? "", entry.markdown ?? "");
  if (!changes.length) {
    return <p className="text-compact text-orb-muted">The text is the same as the version before it.</p>;
  }
  const shown = changes.slice(0, DIFF_PREVIEW);
  const rest = changes.slice(DIFF_PREVIEW);
  // When everything left over sits under one heading, saying which is the difference between
  // "3 more changes" and knowing whether to open the full version.
  const sections = [...new Set(rest.map((change) => change.section))];
  const where = sections.length === 1 && sections[0] ? ` in “${sections[0]}”` : "";
  return (
    <div className="flex flex-col gap-0.5 text-compact leading-snug">
      {shown.map((change, index) => (
        <p
          key={`${change.type}-${index}`}
          className={cn(
            "flex gap-2.5 rounded-lg px-2.5 py-2",
            change.type === "removed" ? "bg-orb-coral/10 text-orb-gray" : "bg-orb-lime/8 text-orb-white",
          )}
        >
          <span aria-label={change.type === "removed" ? "Removed" : "Added"} className={cn("font-mono", change.type === "removed" ? "text-orb-coral" : "text-orb-lime")}>
            {change.type === "removed" ? "−" : "+"}
          </span>
          <span className={cn("line-clamp-3", change.type === "removed" && "line-through decoration-orb-coral/50")}>
            {flattenBlock(change.text)}
          </span>
        </p>
      ))}
      {rest.length > 0 && (
        <p className="flex gap-2.5 px-2.5 py-1.5 text-xs text-orb-muted">
          <span aria-hidden="true" className="font-mono">⋯</span>
          {rest.length} more {rest.length === 1 ? "change" : "changes"}{where}
        </p>
      )}
    </div>
  );
}

/**
 * The changed passages between two versions, each with the heading it sits under.
 *
 * The heading is the nearest one above the change in the newer version, since that is the version
 * the reader is looking at; a heading the change removed no longer names anywhere.
 */
function sectionedChanges(before, after) {
  const changes = [];
  let section = null;
  for (const change of diffBlocks(before, after)) {
    const heading = /^#{1,6}\s+(.+)$/.exec(change.text.trim());
    if (heading && !change.text.trim().includes("\n") && change.type !== "removed") section = flattenBlock(heading[1]);
    if (change.type !== "same") changes.push({ ...change, section });
  }
  return changes;
}

/**
 * What restoring a version will do to the person's own writing, said before they press it.
 *
 * A restore is a person's save, so any passage of theirs in the current version that the restored
 * one lacks is recorded as removed on purpose, and the agent will not put it back. That deserves a
 * sentence; restoring a version that keeps all of it does not.
 *
 * The passages may be other people's: when the server says some of those lost are not the
 * reader's, the note counts them as kept passages rather than as "yours".
 */
function restoreNote(entry, current, userBlocks, authors, viewerId) {
  const kept = new Set(splitBlocks(entry.markdown ?? "").map((block) => block.trim()));
  const lostAt = userBlocks.map((block, index) => (kept.has(block.trim()) ? -1 : index)).filter((index) => index >= 0);
  const lost = lostAt.length;
  if (!lost) {
    return "Restoring puts this text back as a new revision. Whatever the file says now stays in this history, so you can undo it the same way.";
  }
  const known = Array.isArray(authors) && authors.length === userBlocks.length && viewerId;
  if (known && lostAt.some((index) => authors[index]?.userId !== viewerId)) {
    return lost === 1
      ? `Restoring it removes a kept passage from revision ${current.revision}. It stays in history.`
      : `Restoring it removes ${lost} kept passages from revision ${current.revision}. They stay in history.`;
  }
  return lost === 1
    ? `Restoring it removes your passage from revision ${current.revision}. Your passage stays in history.`
    : `Restoring it removes ${lost} of your passages from revision ${current.revision}. They stay in history.`;
}

/** One line saying who changed what, worked out from the two versions themselves. */
function describe(entry, previous, viewerId) {
  const who = entry.updatedBy?.kind !== "agent"
    ? personLabel(entry.updatedBy, "You", viewerId)
    : entry.updatedBy.agentSlug === LIBRARY_AGENT_SLUG ? "Library agent" : "An agent";
  if (entry.deleted) return `${who} deleted the file`;
  // A version no one wrote: renaming another node rewrote this file's links to it.
  if (entry.renamed) return `Links updated: ${entry.renamed.from} was renamed ${entry.renamed.to}`;
  if (!previous) return `${who} created the file`;
  const changes = diffBlocks(previous.markdown ?? "", entry.markdown ?? "");
  const added = changes.filter((change) => change.type === "added").length;
  const removed = changes.filter((change) => change.type === "removed").length;
  if (!added && !removed) {
    return entry.title !== previous.title || entry.summary !== previous.summary
      ? `${who} changed the title or summary`
      : `${who} saved it unchanged`;
  }
  if (added && removed) return `${who} rewrote ${removed} ${removed === 1 ? "passage" : "passages"}`;
  if (added) return `${who} added ${added} ${added === 1 ? "passage" : "passages"}`;
  return `${who} removed ${removed} ${removed === 1 ? "passage" : "passages"}`;
}
