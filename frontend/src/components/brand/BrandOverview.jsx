"use client";

import { Panel, RowList } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { brandAssetUrl } from "@/lib/api/brand";
import { describePointer } from "@/lib/brand/brand";
import { formatDate, pathOf } from "@/lib/format";
import { AssetImage } from "./AssetImage";
import { useBrand } from "./BrandContext";
import { PinField, SectionHeading } from "./PinField";

/**
 * The brand in one glance: its mark on light and on dark, and the sentence that says what it is
 * like.
 *
 * First on the page, because it is the check everything else rests on: if the logo here is not
 * the company's logo, or the sentence describes somebody else's site, nothing below is worth
 * reading yet.
 */
export function BrandCard({ name }) {
  const { workspaceId, system, assets } = useBrand();
  const logos = assets.filter((asset) => asset.kind === "logo" && !asset.hidden);
  const primary = logos.find((logo) => logo.id === system.logos?.primary) ?? logos[0] ?? null;
  const personality = system.personality ?? {};

  return (
    <Panel role="region" aria-label="Brand" className="grid gap-4 overflow-hidden p-0 sm:p-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      {primary ? (
        <div className="grid grid-cols-2 md:grid-cols-1">
          <div className="flex min-h-28 items-center justify-center bg-white p-6">
            <AssetImage workspaceId={workspaceId} assetId={primary.id} alt={`${name} logo on a light background`} className="max-h-16 w-auto object-contain" />
          </div>
          <div className="flex min-h-28 items-center justify-center bg-[#111827] p-6">
            <AssetImage workspaceId={workspaceId} assetId={primary.id} alt={`${name} logo on a dark background`} className="max-h-16 w-auto object-contain" />
          </div>
        </div>
      ) : (
        <div className="flex min-h-28 items-center justify-center border-b border-dashed border-orb-line p-6 text-sm text-orb-muted md:border-b-0 md:border-r">No logo was found on your site.</div>
      )}
      <div className="flex flex-col justify-center gap-3 p-5">
        <p className="text-xs uppercase tracking-[0.12em] text-orb-muted">{name}</p>
        <PinField pointer="/personality/summary" value={personality.summary ?? ""} kind="paragraph" label="how the brand looks and feels" inline={false} format={() => "the agent's sentence"}>
          <p className="font-display text-xl font-bold leading-snug tracking-[-0.01em] text-orb-white">{personality.summary || "No description yet."}</p>
        </PinField>
        <PinField pointer="/personality/adjectives" value={personality.adjectives ?? []} kind="lines" label="adjectives" format={(value) => value.join(", ")}>
          <ul className="flex flex-wrap gap-1.5">
            {(personality.adjectives ?? []).map((adjective) => (
              <li key={adjective}><Pill className="text-xs">{adjective}</Pill></li>
            ))}
          </ul>
        </PinField>
      </div>
    </Panel>
  );
}

/**
 * What moved since the derivation before, token by token.
 *
 * Shown only when something did. A person who has read the system once should be able to see what
 * a new derivation changed without reading it all again — and to see that their pinned values are
 * not on the list.
 */
export function WhatChanged({ brand }) {
  const changes = brand.changes ?? [];
  if (!changes.length) return null;
  const show = (value) => (value === null || value === undefined ? "none" : Array.isArray(value) ? value.join(", ") : String(value));
  return (
    <details className="rounded-xl border border-orb-line bg-orb-raised/40">
      <summary className="cursor-pointer px-4 py-2.5 text-sm text-orb-white sm:px-5">
        What changed <span className="text-orb-muted">· {changes.length} value{changes.length === 1 ? "" : "s"} moved{brand.previousDerivedAt ? ` since ${formatDate(brand.previousDerivedAt)}` : ""}</span>
      </summary>
      <ul className="divide-y divide-orb-line/60 border-t border-orb-line px-4 py-1 text-xs sm:px-5">
        {changes.map((change) => (
          <li key={change.pointer} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5">
            <span className="font-mono text-orb-gray">{describePointer(change.pointer)}</span>
            <span className="text-orb-muted">{show(change.from)} →</span>
            <span className="text-orb-white">{show(change.to)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The rules of the system: what to do with everything above, in sentences. */
export function RulesSection() {
  const { system } = useBrand();
  if (!system.rules?.length) return null;
  return (
    <section aria-labelledby="brand-rules" className="space-y-3">
      <SectionHeading id="brand-rules" title="Rules" description="How the system is used. These are handed to your AI with the tokens." />
      <PinField pointer="/rules" value={system.rules} kind="lines" label="rules" inline={false} format={(value) => `${value.length} rules`}>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-orb-gray">
          {system.rules.map((rule) => <li key={rule}>{rule}</li>)}
        </ul>
      </PinField>
    </section>
  );
}

/** The pages the system was read from, as Chrome rendered them. */
export function ScreenshotsSection() {
  const { workspaceId, observation } = useBrand();
  const pages = (observation?.pages ?? []).filter((page) => page.shots?.desktop || page.shots?.mobile);
  if (!pages.length) return null;
  return (
    <section aria-labelledby="brand-screens" className="space-y-4">
      <SectionHeading id="brand-screens" title="Screenshots" description={`The pages the system was read from, as rendered${observation.createdAt ? ` on ${formatDate(observation.createdAt)}` : ""}.`} />
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {pages.map((page) => (
          <li key={page.url} className="space-y-2">
            <div className="flex items-start gap-2">
              {page.shots.desktop && (
                <a href={brandAssetUrl(workspaceId, page.shots.full ?? page.shots.desktop)} target="_blank" rel="noreferrer" className="block min-w-0 flex-1 overflow-hidden rounded-xl border border-orb-line hover:border-orb-lime/50" title="Open the screenshot">
                  <AssetImage workspaceId={workspaceId} assetId={page.shots.desktop} alt={`${page.label} at desktop width`} className="w-full" />
                </a>
              )}
              {page.shots.mobile && (
                <a href={brandAssetUrl(workspaceId, page.shots.mobile)} target="_blank" rel="noreferrer" className="block w-[22%] shrink-0 overflow-hidden rounded-xl border border-orb-line hover:border-orb-lime/50" title="Open the mobile screenshot">
                  <AssetImage workspaceId={workspaceId} assetId={page.shots.mobile} alt={`${page.label} at mobile width`} className="w-full" />
                </a>
              )}
            </div>
            <p className="truncate text-xs text-orb-gray" title={page.url}>
              <span className="font-mono text-orb-white">{pathOf(page.url)}</span>
              {page.reason && <span className="text-orb-muted"> · {page.reason}</span>}
            </p>
          </li>
        ))}
      </ul>
      {(observation.pages ?? []).some((page) => page.status !== "ok") && (
        <ul className="space-y-1 text-xs text-orb-orange">
          {observation.pages.filter((page) => page.status !== "ok").map((page) => (
            <li key={page.url}><span className="font-mono">{pathOf(page.url)}</span> {page.status === "blocked" ? "refused a browser (BLOCKED)" : "could not be rendered"}: {page.error}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * What the agent could not tell, and why.
 *
 * Listed rather than left out, because the alternative to "the site shows no error colour" is a
 * plausible red that nobody chose, sitting in a table looking like a decision.
 */
export function UndeterminedSection() {
  const { system } = useBrand();
  if (!system.undetermined?.length) return null;
  return (
    <section aria-labelledby="brand-undetermined" className="space-y-3">
      <SectionHeading id="brand-undetermined" title="Not determined" description="What could not be read from your site, and why. None of it was filled in with a guess; set any of it yourself above." />
      <RowList>
        {system.undetermined.map((entry) => (
          <li key={entry.field} className="grid gap-x-4 gap-y-0.5 px-3 py-2.5 sm:grid-cols-[14rem_minmax(0,1fr)] sm:px-4">
            <span className="font-mono text-xs text-orb-white">{entry.field}</span>
            <span className="text-compact text-orb-gray">{entry.reason}</span>
          </li>
        ))}
      </RowList>
    </section>
  );
}
