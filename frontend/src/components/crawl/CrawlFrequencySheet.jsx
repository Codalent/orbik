"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CrawlTree } from "./CrawlTree";
import { setCrawlFrequencies } from "@/lib/api/crawl";
import { describeFrequency } from "@/lib/crawl/format";
import { PATTERN_FREQUENCIES, frequencyToInterval } from "@/lib/validation/crawl";
import { cn } from "@/lib/utils";

/**
 * Where crawl frequencies are chosen: the page list with checkboxes, and one frequency to apply
 * to whatever is ticked.
 *
 * Nobody decides for the owner. Every page starts on manual trigger — fetched only when asked —
 * and stays there until a person ticks it, alone or with its whole folder, and picks how often it
 * should be revisited. The list is the same tree the crawl page shows, so what somebody selects
 * here is exactly what they were looking at a moment ago.
 *
 * The panel stays open after applying. Choosing frequencies is a few rounds — the blog weekly,
 * the docs monthly, the legal pages left alone — and closing after each would turn three choices
 * into three trips.
 *
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {string} props.workspaceId
 * @param {() => void} [props.onApplied] called after a frequency is saved, so the page behind can
 *   pick up the change
 */
export function CrawlFrequencySheet({
  open,
  onClose,
  workspaceId,
  onApplied,
}) {
  const [selection, setSelection] = useState(() => ({ hashes: new Set(), paths: new Set() }));
  const [frequency, setFrequency] = useState("168");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const count = selection.hashes.size + selection.paths.size;

  /** Adds or removes one page or folder. A folder carries everything under it, server-side. */
  function toggle(target) {
    setSelection((current) => {
      const hashes = new Set(current.hashes);
      const paths = new Set(current.paths);
      if (target.kind === "folder") {
        if (paths.has(target.path)) paths.delete(target.path);
        else paths.add(target.path);
      } else if (hashes.has(target.urlHash)) {
        hashes.delete(target.urlHash);
      } else {
        hashes.add(target.urlHash);
      }
      return { hashes, paths };
    });
    setNotice(null);
  }

  /** Writes the chosen frequency to the selection and shows the list again with it applied. */
  async function apply() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const intervalHours = frequencyToInterval(frequency);
      const result = await setCrawlFrequencies(
        workspaceId,
        { urlHashes: [...selection.hashes], paths: [...selection.paths] },
        intervalHours,
      );
      const pages = result.pages === 1 ? "1 page" : `${result.pages.toLocaleString()} pages`;
      setNotice(intervalHours === null
        ? `${pages} set to manual trigger. They are crawled only when you ask.`
        : `${pages} set to ${describeFrequency(intervalHours).toLowerCase()}.`);
      setSelection({ hashes: new Set(), paths: new Set() });
      setRefreshKey((value) => value + 1);
      onApplied?.();
    } catch (failure) {
      setError(failure?.message ?? "The frequency could not be saved. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 border-orb-line bg-orb-space p-0 sm:w-[70%] sm:min-w-[40rem] data-[side=right]:sm:max-w-[72rem]"
      >
        <SheetHeader className="gap-1 border-b border-orb-line p-5 pr-14">
          <SheetTitle className="font-display text-base font-bold text-orb-white">Crawl frequencies</SheetTitle>
          <SheetDescription className="text-orb-muted">
            Tick pages or whole folders, choose how often to revisit them, and apply. Everything
            starts on manual trigger, which means it is crawled only when you ask. New pages are
            always fetched when they are found.
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {error && <p role="alert" className="mb-3 text-sm text-orb-coral">{error}</p>}
          {notice && <p role="status" className="mb-3 text-sm text-orb-cyan">{notice}</p>}
          <CrawlTree
            workspaceId={workspaceId}
            selection={selection}
            onToggle={toggle}
            refreshKey={refreshKey}
            embedded
          />
        </div>

        {/*
          The action bar is pinned to the bottom so the choice is always one glance from the
          list, however far down somebody has scrolled a thousand-page site. It reads as a
          sentence: what is selected, how often, apply.
        */}
        <div className="flex flex-wrap items-center gap-3 border-t border-orb-line bg-orb-space p-4">
          <p className="text-sm text-orb-gray" aria-live="polite">
            {count === 0
              ? "Nothing selected"
              : describeSelection(selection)}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <label htmlFor="frequency-choice" className="sr-only">Crawl frequency</label>
            <Select items={PATTERN_FREQUENCIES} value={frequency} disabled={busy} onValueChange={(next) => { if (next) setFrequency(next); }}>
              <SelectTrigger id="frequency-choice" className={cn(frequency === "never" && "text-orb-orange")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PATTERN_FREQUENCIES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="button" size="sm" onClick={apply} disabled={busy || count === 0}>
              {busy ? "Applying…" : "Apply"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** "3 folders and 2 pages selected", in whichever of the two halves applies. */
function describeSelection({ hashes, paths }) {
  const parts = [];
  if (paths.size) parts.push(paths.has("/") ? "every page" : `${paths.size} ${paths.size === 1 ? "folder" : "folders"}`);
  if (hashes.size && !paths.has("/")) parts.push(`${hashes.size} ${hashes.size === 1 ? "page" : "pages"}`);
  return `${parts.join(" and ")} selected`;
}
