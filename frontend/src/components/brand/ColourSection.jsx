"use client";

import { useState } from "react";
import { Layers } from "lucide-react";
import useSWR from "swr";

import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { brandObservationPath } from "@/lib/api/brand";
import { COLOR_ROLES } from "@/lib/brand/brand";
import { pathOf } from "@/lib/format";
import { useBrand } from "./BrandContext";
import { PinField, SectionHeading, SourceBadge } from "./PinField";

/** The pill tone of each WCAG grade: passing is healthy, large-text-only wants a look, failing failed. */
const GRADE_TONES = Object.freeze({
  AAA: "lime",
  AA: "lime",
  "AA-large": "orange",
  fail: "coral",
});

/**
 * The colours of the system, by role.
 *
 * Each is a swatch with what it is for, where it came from, and how it reads against the
 * background and the surface — the last worked out by the API from the colours as they now stand,
 * so changing one here changes its badges. A role the site gives no evidence for is shown empty
 * rather than filled, and can be set by hand.
 *
 * Beside the heading is the way to the other half: every colour the rendered pages actually
 * paint, before anything decided what each was for, with the means to promote one to a role.
 */
export function ColourSection() {
  const { system } = useBrand();
  const [observedOpen, setObservedOpen] = useState(false);

  return (
    <section aria-labelledby="brand-colours" className="space-y-4">
      <SectionHeading id="brand-colours" title="Colours" description="By role, with how each reads on the background and the surface. Click the pencil to set a colour yourself; yours is kept.">
        <Button type="button" variant="outline" size="sm" onClick={() => setObservedOpen(true)}>
          <Layers className="size-3.5" /> Observed palette
        </Button>
      </SectionHeading>

      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {COLOR_ROLES.map(({ role, label, required }) => (
          <li key={role}>
            <ColourCard role={role} label={label} required={required} colour={system.colors?.[role] ?? null} />
          </li>
        ))}
      </ul>

      <ObservedPalette open={observedOpen} onClose={() => setObservedOpen(false)} />
    </section>
  );
}

/** One role: its swatch, its value, and what it is for. */
function ColourCard({ role, label, colour }) {
  const pointer = `/colors/${role}/value`;
  if (!colour) {
    return (
      <div className="flex h-full flex-col justify-between gap-3 rounded-xl border border-dashed border-orb-line p-4">
        <div>
          <p className="text-sm font-medium text-orb-white">{label}</p>
          <p className="mt-1 text-xs text-orb-muted">Your site shows no evidence of one, so none was proposed.</p>
        </div>
        <PinField pointer={pointer} value="" kind="color" label={`${label} colour`}>
          <span className="text-xs text-orb-gray">Set one</span>
        </PinField>
      </div>
    );
  }

  const surface = colour.contrastOn?.text ? [["Text on it", colour.contrastOn.text]] : [["On background", colour.contrastOn?.background], ["On surface", colour.contrastOn?.surface]];
  return (
    <Panel className="flex h-full flex-col overflow-hidden p-0 sm:p-0">
      <div className="h-20 w-full border-b border-orb-line" style={{ backgroundColor: colour.value }} role="img" aria-label={`${label}: ${colour.value}`} />
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-orb-white">{label}</p>
          <SourceBadge source={colour.source} pointer={pointer} />
        </div>
        <PinField pointer={pointer} value={colour.value} kind="color" label={`${label} colour`}>
          <span className="font-mono text-sm text-orb-white">{colour.value}</span>
        </PinField>
        {colour.oklch && <p className="font-mono text-2xs text-orb-muted">{colour.oklch}</p>}
        {colour.usage && <p className="text-xs leading-relaxed text-orb-gray">{colour.usage}</p>}
        <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
          {surface.filter(([, contrast]) => contrast).map(([name, contrast]) => (
            <Pill key={name} tone={GRADE_TONES[contrast.grade]} className="px-1.5" title={`${name}: contrast ${contrast.ratio}:1 (WCAG ${contrast.grade === "fail" ? "fails AA" : contrast.grade})`}>
              {name} {contrast.ratio}:1 · {contrast.grade === "fail" ? "fails" : contrast.grade}
            </Pill>
          ))}
        </div>
        {colour.observedFrom?.length > 0 && colour.source === "derived" && (
          <p className="flex flex-wrap items-center gap-1 text-2xs text-orb-muted">
            From
            {colour.observedFrom.map((hex) => (
              <span key={hex} className="inline-flex items-center gap-1 font-mono">
                <span aria-hidden="true" className="inline-block size-2.5 rounded-sm border border-orb-line" style={{ backgroundColor: hex }} />{hex}
              </span>
            ))}
          </p>
        )}
      </div>
    </Panel>
  );
}

/**
 * Every colour the rendered pages paint, before anything decided what each was for.
 *
 * The observed half of the page's promise. A proposal says "your border colour is this grey";
 * this says which greys there actually are, how much of the page each covers, and where each was
 * seen — and lets a person overrule the proposal by promoting one of them to a role, which pins
 * it there.
 */
function ObservedPalette({ open, onClose }) {
  const { workspaceId, pin, busy, system, canEdit } = useBrand();
  // Read only once the drawer is opened: the observation is the largest thing the page can ask
  // for, and most visits never look at it.
  const { data, error } = useSWR(open ? brandObservationPath(workspaceId) : null);
  const colours = data?.observation?.observed?.colors ?? [];
  const pages = data?.observation?.pages ?? [];

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 border-orb-line bg-orb-space p-0 sm:w-[60%] sm:min-w-[36rem] data-[side=right]:sm:max-w-[56rem]">
        <SheetHeader className="gap-1 border-b border-orb-line p-5 pr-14">
          <SheetTitle className="font-display text-base font-bold text-orb-white">Observed palette</SheetTitle>
          <SheetDescription className="text-orb-muted">
            Every colour the rendered pages paint, most used first. Colours too alike to tell apart are counted as one. Nothing here is a proposal: it is what was measured.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto p-5">
          {error && <p className="text-sm text-orb-coral">{error.message}</p>}
          {!data && !error && <p className="text-sm text-orb-muted">Loading what was observed…</p>}
          {data && !colours.length && <p className="text-sm text-orb-muted">Nothing has been observed yet.</p>}
          <ul className="divide-y divide-orb-line/60">
            {colours.map((colour) => (
              <li key={colour.hex} className="flex flex-wrap items-center gap-3 py-2.5">
                <span aria-hidden="true" className="size-10 shrink-0 rounded-lg border border-orb-line" style={{ backgroundColor: colour.hex }} />
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm text-orb-white">{colour.hex}</p>
                  <p className="text-xs text-orb-gray">
                    {[colour.share >= 0.001 ? `${percent(colour.share)} of painted area` : null, colour.textShare >= 0.001 ? `${percent(colour.textShare)} of text` : null].filter(Boolean).join(" · ") || "a trace"}
                    {colour.roles?.length > 0 && <span className="text-orb-muted"> · {colour.roles.slice(0, 4).join(", ")}</span>}
                  </p>
                  <p className="truncate text-2xs text-orb-muted" title={(colour.seenOn ?? []).join("\n")}>
                    Seen on {colour.pages} of {pages.filter((page) => page.status === "ok").length} pages
                    {colour.seenOn?.length > 0 && `: ${colour.seenOn.slice(0, 3).map(pathOf).join(", ")}${colour.seenOn.length > 3 ? "…" : ""}`}
                  </p>
                </div>
                {canEdit && <span className="flex shrink-0 items-center gap-1.5 text-xs text-orb-gray">
                  <span aria-hidden="true">Use as</span>
                  {/* An action rather than a setting: it never holds a value, so it always reads
                      "a role…" and picking one pins the colour to it. */}
                  <Select
                    value={null}
                    disabled={busy}
                    onValueChange={(role) => { if (role) pin(`/colors/${role}/value`, colour.hex); }}
                  >
                    <SelectTrigger size="xs" aria-label={`Use ${colour.hex} as a role`}>
                      <SelectValue placeholder="a role…" />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false} align="end">
                      {COLOR_ROLES.map(({ role, label }) => (
                        <SelectItem key={role} value={role}>{label}{system.colors?.[role]?.value === colour.hex ? " (current)" : ""}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </span>}
              </li>
            ))}
          </ul>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** A share as a percentage a person reads at a glance. */
function percent(value) {
  const amount = value * 100;
  return amount >= 10 ? `${Math.round(amount)}%` : `${Math.round(amount * 10) / 10}%`;
}
