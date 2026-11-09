"use client";

import { useState } from "react";
import { ArrowRight, Check, Loader2, LocateFixed, Plus, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { brandAssetUrl, setBrandPin, undoBrandChange } from "@/lib/api/brand";
import { cn } from "@/lib/utils";

/** What each colour role is called. */
const ROLE_NAMES = Object.freeze({
  primary: "Primary", background: "Background", surface: "Surface", text: "Text", textMuted: "Muted text",
  border: "Border", link: "Link", secondary: "Secondary", accent: "Accent", success: "Success", warning: "Warning", error: "Error",
});

/** What each field of a type step or a family is called. */
const FIELD_NAMES = Object.freeze({
  px: "size", lineHeight: "line height", weight: "weight", letterSpacing: "letter-spacing", family: "typeface",
  fallbacks: "fallbacks", weights: "weights", usedFor: "use", value: "", usage: "usage",
});

/** Which section of the Brand page shows each part of the system, by its heading's id. */
const SECTIONS = Object.freeze([
  ["/colors", "brand-colours"],
  ["/typography", "brand-type"],
  ["/logos", "brand-logos"],
  ["/rules", "brand-rules"],
  ["/graphics", "brand-graphics"],
  ["/spacing", "brand-spacing"],
  ["/shape", "brand-spacing"],
  ["/components", "brand-components"],
]);

/** A colour as the API writes one. */
const HEX = /^#[0-9a-f]{6}$/i;

/** A change's place, in words: "Primary colour", "H1 letter-spacing", "Rules". */
export function placeName(change) {
  if (change.kind === "asset") return "Image";
  const parts = (change.pointer ?? "").split("/").slice(1);
  if (parts[0] === "colors") return `${ROLE_NAMES[parts[1]] ?? parts[1]} colour${parts[2] === "usage" ? " usage" : ""}`;
  if (parts[0] === "typography" && parts[1] === "families") return `${capitalise(parts[2])} typeface${parts[3] !== "family" ? ` ${FIELD_NAMES[parts[3]] ?? parts[3]}` : ""}`;
  if (parts[0] === "typography" && parts[1] === "scale") return `${stepName(parts[2])} ${FIELD_NAMES[parts[3]] ?? parts[3]}`;
  if (parts[0] === "typography" && parts[1] === "rules") return "Typography rules";
  if (parts[0] === "rules") return "Rules";
  if (parts[0] === "logos") return "Primary logo";
  if (parts[0] === "personality") return parts[1] === "adjectives" ? "Personality" : "Personality summary";
  if (parts[0] === "graphics") return "Imagery";
  return parts.map(capitalise).join(" ");
}

function capitalise(text) {
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "";
}

function stepName(token) {
  return { bodyLarge: "Large body", body: "Body", small: "Small", caption: "Caption", button: "Button", label: "Label", display: "Display" }[token] ?? String(token).toUpperCase();
}

/** A file's name short enough for a tag: the start and the extension, the middle cut. */
function shortName(name) {
  if (!name) return null;
  return name.length > 24 ? `${name.slice(0, 15)}…${name.slice(-6)}` : name;
}

/** Where a change came from, in words: "brand-guide.pdf, p. 6", or "what you said". */
export function viaLabel(via) {
  if (!via) return null;
  if (via.kind === "upload") return [shortName(via.fileName) ?? "your file", via.page ? `p. ${via.page}` : null].filter(Boolean).join(", ");
  if (via.kind === "chat") return "what you said";
  return "the Brand page";
}

/** Scrolls the Brand page to the section a pointer is shown in and outlines it for a moment. */
export function showOnPage(pointer) {
  const id = SECTIONS.find(([prefix]) => (pointer ?? "").startsWith(prefix))?.[1] ?? "brand-logos";
  const section = document.getElementById(id)?.closest("section");
  if (!section) return false;
  section.scrollIntoView({ behavior: "smooth", block: "start" });
  section.classList.add("ring-2", "ring-orb-lime/60", "ring-offset-4", "ring-offset-orb-black", "rounded-xl");
  window.setTimeout(() => section.classList.remove("ring-2", "ring-orb-lime/60", "ring-offset-4", "ring-offset-orb-black", "rounded-xl"), 1600);
  return true;
}

/**
 * What a brand turn changed: one row per change, each with what it was, what it is now, where the
 * new value came from, a way to see it on the page, and an Undo.
 *
 * Read from the brand's change log, not from the model's reply, so the list is what happened. An
 * undone change stays in the list, struck through, so the thread still says what was done and then
 * taken back.
 *
 * @param {object} props
 * @param {object[]} props.changes the turn's changes, oldest first
 * @param {string} props.workspaceId
 * @param {boolean} [props.canUndo] whether the person may change the brand
 * @param {() => void} [props.onChanged] re-reads what the change touched
 */
export function BrandChanges({ changes, workspaceId, canUndo = true, onChanged }) {
  const [undone, setUndone] = useState(() => new Set(changes.filter((change) => change.undoneAt).map((change) => change.id)));
  const [working, setWorking] = useState(null);
  const [error, setError] = useState(null);
  const live = changes.filter((change) => !undone.has(change.id));

  async function undo(list) {
    setError(null);
    // Newest first, so a change made on top of another is taken back before the one beneath it.
    for (const change of [...list].reverse()) {
      setWorking(change.id);
      try {
        await undoBrandChange(workspaceId, change.id);
        setUndone((current) => new Set([...current, change.id]));
      } catch (failure) {
        setError(failure?.message ?? "That could not be undone.");
        break;
      }
    }
    setWorking(null);
    await onChanged?.();
  }

  return (
    <div className="overflow-hidden rounded-lg border border-orb-line bg-orb-black/30">
      <div className="flex items-center justify-between gap-2 border-b border-orb-line px-3 py-2">
        <p className="text-2xs font-medium uppercase tracking-[0.14em] text-orb-muted">Changed in your brand</p>
        {canUndo && live.length > 1 && (
          <Button type="button" size="xs" variant="ghost" onClick={() => undo(live)} disabled={Boolean(working)}>
            <Undo2 /> Undo all
          </Button>
        )}
      </div>
      <ul className="divide-y divide-orb-line">
        {changes.map((change) => {
          const isUndone = undone.has(change.id);
          return (
            <li key={change.id} className={cn("space-y-1.5 px-3 py-2.5", isUndone && "opacity-55")}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className={cn("min-w-[8rem] flex-1 text-xs font-medium text-orb-white", isUndone && "line-through")}>{placeName(change)}</p>
                {isUndone ? <Pill className="px-1.5">Undone</Pill> : change.via?.kind === "upload" ? <Pill tone="cyan" className="px-1.5" title={change.via.fileName ?? undefined}>{viaLabel(change.via)}</Pill> : null}
              </div>
              <BeforeAfter change={change} workspaceId={workspaceId} />
              <div className="flex flex-wrap gap-1">
                <Button type="button" size="xs" variant="ghost" onClick={() => showOnPage(change.pointer ?? "/logos")}>
                  <LocateFixed /> Show
                </Button>
                {canUndo && !isUndone && (
                  <Button type="button" size="xs" variant="ghost" onClick={() => undo([change])} disabled={Boolean(working)}>
                    {working === change.id ? <Loader2 className="animate-spin" /> : <Undo2 />} Undo
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {error && <p className="border-t border-orb-line px-3 py-2 text-xs text-orb-coral" role="alert">{error}</p>}
    </div>
  );
}

/** A change's two sides, drawn as what they are: swatches, logos, lines of a list, or values. */
function BeforeAfter({ change, workspaceId }) {
  if (change.kind === "asset") return <AssetChange change={change} workspaceId={workspaceId} />;
  const before = change.before?.value ?? null;
  const after = change.after?.value ?? null;

  if (Array.isArray(before) || Array.isArray(after)) {
    const was = new Set(Array.isArray(before) ? before : []);
    const now = new Set(Array.isArray(after) ? after : []);
    const added = [...now].filter((line) => !was.has(line));
    const removed = [...was].filter((line) => !now.has(line));
    if (!added.length && !removed.length) return <p className="text-xs text-orb-muted">Reordered.</p>;
    return (
      <ul className="space-y-1 text-xs">
        {added.map((line) => (
          <li key={`+${line}`} className="flex gap-1.5 text-orb-gray"><Plus aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-orb-lime" /><span>{String(line)}</span></li>
        ))}
        {removed.map((line) => (
          <li key={`-${line}`} className="flex gap-1.5 text-orb-muted line-through"><span className="w-3 shrink-0 text-center">−</span><span>{String(line)}</span></li>
        ))}
      </ul>
    );
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
      <Side value={before} pointer={change.pointer} workspaceId={workspaceId} />
      <ArrowRight aria-hidden="true" className="size-3.5 text-orb-muted" />
      <Side value={after} pointer={change.pointer} workspaceId={workspaceId} />
    </div>
  );
}

/** One side of a change. */
function Side({ value, pointer, workspaceId }) {
  if (value === null || value === undefined || value === "") return <span className="text-xs text-orb-muted">none</span>;
  if (pointer === "/logos/primary" && typeof value === "string") {
    return (
      <span className="grid h-12 place-items-center overflow-hidden rounded-md bg-white p-1.5">
        {/* eslint-disable-next-line @next/next/no-img-element -- an asset streamed by the API with the session cookie */}
        <img src={brandAssetUrl(workspaceId, value)} alt="" className="max-h-full max-w-full object-contain" />
      </span>
    );
  }
  if (typeof value === "string" && HEX.test(value)) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="size-5 shrink-0 rounded border border-orb-line" style={{ backgroundColor: value }} />
        <code className="truncate font-mono text-xs text-orb-white">{value.toUpperCase()}</code>
      </span>
    );
  }
  if (pointer?.endsWith("/letterSpacing") && typeof value === "number") {
    return <span className="text-xs tabular-nums text-orb-white">{value === 0 ? "0" : `${value}em`}</span>;
  }
  return <span className="break-words text-xs text-orb-white">{typeof value === "object" ? JSON.stringify(value) : String(value)}</span>;
}

/** What was recorded about an image, or that it was set aside. */
function AssetChange({ change, workspaceId }) {
  const after = change.after ?? {};
  const words = [];
  if (after.hidden === true) words.push("Set aside: not handed to anyone’s AI");
  if (after.hidden === false) words.push("Shown again");
  if (after.kind) words.push(capitalise(after.kind));
  if (after.variant) words.push(after.variant);
  if (after.tone) words.push(after.tone === "on-dark" ? "for dark backgrounds" : "for light backgrounds");
  if (after.isReference === true) words.push("a style reference");
  if (after.label) words.push(`“${after.label}”`);
  return (
    <div className="flex items-center gap-2">
      <span className={cn("grid h-10 w-14 shrink-0 place-items-center overflow-hidden rounded-md bg-white p-1", after.hidden === true && "opacity-50")}>
        {/* eslint-disable-next-line @next/next/no-img-element -- an asset streamed by the API with the session cookie */}
        <img src={brandAssetUrl(workspaceId, change.assetId)} alt="" className="max-h-full max-w-full object-contain" />
      </span>
      <span className="min-w-0 text-xs text-orb-gray">{words.join(" · ") || "Details recorded"}</span>
    </div>
  );
}

/**
 * What a file offered that the chat did not apply, each with why — and, where it is a value that
 * could be set, "Add it", which sets it as taken from that file and page.
 *
 * @param {object} props
 * @param {object[]} props.items
 * @param {string} props.workspaceId
 * @param {boolean} [props.canAdd]
 * @param {() => void} [props.onChanged]
 */
export function LeftOut({ items, workspaceId, canAdd = true, onChanged }) {
  const [added, setAdded] = useState(() => new Set());
  const [working, setWorking] = useState(null);
  const [error, setError] = useState(null);

  async function add(item, index) {
    setWorking(index);
    setError(null);
    try {
      await setBrandPin(workspaceId, item.pointer, item.value, item.fileId ? { assetId: item.fileId, page: item.page } : null);
      setAdded((current) => new Set([...current, index]));
      await onChanged?.();
    } catch (failure) {
      setError(failure?.fields?.[0]?.message ?? failure?.message ?? "That could not be added.");
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="rounded-lg border border-orb-line px-3 py-2.5">
      <p className="text-2xs font-medium uppercase tracking-[0.14em] text-orb-muted">Left out</p>
      <ul className="mt-1.5 space-y-2">
        {items.map((item, index) => (
          <li key={`${item.label}-${index}`} className="flex flex-wrap items-start gap-2">
            <div className="min-w-[10rem] flex-1 text-xs">
              <p className="text-orb-white">{item.label}{item.page ? <span className="text-orb-muted"> · p. {item.page}</span> : null}</p>
              {item.reason && <p className="text-orb-gray">{item.reason}</p>}
            </div>
            {canAdd && item.pointer && item.value !== undefined && (
              added.has(index) ? (
                <Pill tone="lime" className="px-1.5"><Check className="size-2.5" /> Added</Pill>
              ) : (
                <Button type="button" size="xs" variant="outline" onClick={() => add(item, index)} disabled={working !== null}>
                  {working === index ? <Loader2 className="animate-spin" /> : <Plus />} Add it
                </Button>
              )
            )}
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-xs text-orb-coral" role="alert">{error}</p>}
    </div>
  );
}
