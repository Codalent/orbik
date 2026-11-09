"use client";

import { useState } from "react";
import useSWR from "swr";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { brandRevisionsPath, restoreBrandRevision } from "@/lib/api/brand";
import { formatDate } from "@/lib/format";

/** Why a version was kept, in the words the list uses. */
const REASONS = Object.freeze({ derivation: "Replaced by a derivation", restore: "Replaced by a restore" });

/**
 * The kept versions of the system, and the way back to one.
 *
 * Every derivation keeps the version it replaces, so a derivation that turns out worse than the
 * one before can be undone. Restoring writes forward: the version being replaced is kept too,
 * which makes restoring itself something that can be taken back. A version comes back whole — the
 * agent's proposal and the pins that were on it — because that pair is what the system was.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 * @param {boolean} props.open
 * @param {number} props.current the revision now in force
 * @param {() => void} props.onClose
 * @param {(brand: object) => void} props.onRestored receives the restored system
 */
export function BrandHistory({ workspaceId, open, current, onClose, onRestored, canRestore = true }) {
  const { data, error, mutate } = useSWR(open ? brandRevisionsPath(workspaceId) : null);
  const [busy, setBusy] = useState(null);
  const [failure, setFailure] = useState(null);

  async function restore(revision) {
    setBusy(revision);
    setFailure(null);
    try {
      const response = await restoreBrandRevision(workspaceId, revision);
      onRestored(response.brand);
      await mutate();
      onClose();
    } catch (problem) {
      setFailure(problem?.message ?? "That version could not be restored.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 border-orb-line bg-orb-space p-0 sm:w-[32rem] data-[side=right]:sm:max-w-[32rem]">
        <SheetHeader className="gap-1 border-b border-orb-line p-5 pr-14">
          <SheetTitle className="font-display text-base font-bold text-orb-white">History</SheetTitle>
          <SheetDescription className="text-orb-muted">The last ten versions of the system. Now at version {current}.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-3 overflow-y-auto p-5">
          {(error || failure) && <p className="text-sm text-orb-coral">{failure ?? error.message}</p>}
          {!data && !error && <p className="text-sm text-orb-muted">Loading…</p>}
          {data && !data.revisions.length && <p className="text-sm text-orb-muted">No earlier version yet. One is kept each time the system is derived again.</p>}
          <ul className="divide-y divide-orb-line/60">
            {data?.revisions.map((entry) => (
              <li key={entry.revision} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm text-orb-white">Version {entry.revision}</p>
                  <p className="text-xs text-orb-gray">
                    {entry.derivedAt ? `Derived ${formatDate(entry.derivedAt)}` : "Not derived"} · {entry.pins} pinned value{entry.pins === 1 ? "" : "s"}
                  </p>
                  <p className="text-2xs text-orb-muted">{REASONS[entry.reason] ?? entry.reason} {formatDate(entry.savedAt)}</p>
                </div>
                {canRestore && (
                  <Button type="button" size="xs" variant="outline" onClick={() => restore(entry.revision)} disabled={busy !== null}>
                    {busy === entry.revision ? "Restoring…" : "Restore"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      </SheetContent>
    </Sheet>
  );
}
