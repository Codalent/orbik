"use client";

import { useEffect, useState } from "react";
import { Check, Pencil, Pin, PinOff, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { SectionHeading as PageSectionHeading } from "@/components/ui/page-header";
import { Pill } from "@/components/ui/pill";
import { Textarea } from "@/components/ui/textarea";
import { SOURCE_LABELS } from "@/lib/brand/brand";
import { cn } from "@/lib/utils";
import { useBrand } from "./BrandContext";

/**
 * The pill tone of each source, so the four can be told apart down a column without reading them:
 * what was measured is plain, what was worked out from it is information, what the agent put in
 * to fill a gap wants a look, and a person's own value is settled.
 */
const SOURCE_TONES = Object.freeze({
  observed: "neutral",
  derived: "cyan",
  proposed: "orange",
  pinned: "lime",
});

/**
 * Where a value came from, as a small label.
 *
 * On every value, on purpose: it is the one thing about a derived design system a reader cannot
 * check by looking at it. Given the value's `pointer`, a pinned value says how it was set: taken
 * from one of the person's files ("brand-guide.pdf p. 6"), said in the chat ("From you"), or set
 * on this page ("Pinned").
 */
export function SourceBadge({ source, pointer = null, className }) {
  const { pinAt } = useBrand();
  const via = source === "pinned" && pointer ? pinAt(pointer)?.via ?? null : null;
  if (via?.kind === "upload") {
    const where = [shortName(via.fileName) ?? "Your file", via.page ? `p. ${via.page}` : null].filter(Boolean).join(" ");
    return (
      <Pill tone="cyan" className={cn("max-w-[11rem] gap-1 truncate px-1.5", className)} title={`Taken from ${via.fileName ?? "a file you uploaded"}${via.page ? `, page ${via.page}` : ""}.`}>
        {where}
      </Pill>
    );
  }
  if (via?.kind === "chat") {
    return (
      <Pill tone="lime" className={cn("gap-1 px-1.5", className)} title="Set by you, in the chat. Re-reading the site leaves it alone.">
        From you
      </Pill>
    );
  }
  const meta = SOURCE_LABELS[source];
  if (!meta) return null;
  return (
    <Pill tone={SOURCE_TONES[source]} className={cn("gap-1 px-1.5", className)} title={meta.hint}>
      {source === "pinned" && <Pin aria-hidden="true" className="size-2.5" />}
      {meta.label}
    </Pill>
  );
}

/** A file's name short enough for a label: its extension kept, the middle cut. */
function shortName(name) {
  if (!name) return null;
  return name.length > 22 ? `${name.slice(0, 14)}…${name.slice(-6)}` : name;
}

/**
 * One value of the system that a person can correct.
 *
 * Reading, it shows whatever its children draw and, beside it, the way in: a pencil. Editing, it
 * is a small form in place. Saving pins the value — it is never an edit of what the agent
 * proposed — and a pinned value offers the way back, naming what the agent had proposed so that
 * unpinning is a choice between two things somebody can see.
 *
 * @param {object} props
 * @param {string} props.pointer where in the system this value is
 * @param {unknown} props.value the value on screen
 * @param {"text"|"paragraph"|"number"|"color"|"lines"|"numbers"|"choice"} props.kind which editor
 * @param {string} props.label what the value is, for the editor's accessible name
 * @param {Array<{value: string, label: string}>} [props.choices] for `choice`
 * @param {(value: unknown) => string} [props.format] how the agent's value is written in the
 *   unpin hint
 * @param {boolean} [props.inline] sit on one line with the value rather than under it
 */
export function PinField({ pointer, value, kind, label, choices, format = String, inline = true, className, children }) {
  const { pin, unpin, pinAt, proposedAt, busy, canEdit } = useBrand();
  const [editing, setEditing] = useState(false);
  const pinned = pinAt(pointer);
  const proposed = proposedAt(pointer);

  // Somebody who may only read the system sees the value with no pencil beside it.
  if (!canEdit) {
    return <span className={cn(inline ? "inline-flex items-center gap-1.5" : "flex flex-col gap-1", className)}>{children}</span>;
  }

  async function save(next) {
    if (await pin(pointer, next)) setEditing(false);
  }

  if (editing) {
    return (
      <PinEditor kind={kind} label={label} value={value} choices={choices} busy={busy} onSave={save} onCancel={() => setEditing(false)} />
    );
  }

  return (
    <span className={cn("group/pin", inline ? "inline-flex items-center gap-1.5" : "flex flex-col gap-1", className)}>
      {children}
      <span className={cn("inline-flex items-center gap-0.5", !pinned && "opacity-0 transition-opacity group-hover/pin:opacity-100 focus-within:opacity-100")}>
        <Button type="button" variant="ghost" size="icon-xs" onClick={() => setEditing(true)} disabled={busy} aria-label={`Edit ${label}`} title={`Edit ${label}. Your value is pinned and kept when the agent derives the system again.`}>
          <Pencil />
        </Button>
        {pinned && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => unpin(pointer)}
            disabled={busy}
            aria-label={`Unpin ${label}`}
            title={proposed === undefined || proposed === null ? "Unpin: let the agent decide" : `Unpin: go back to what the agent proposed (${format(proposed)})`}
          >
            <PinOff />
          </Button>
        )}
      </span>
    </span>
  );
}

/** The form a value is corrected in. One per kind of value; all save the same way. */
function PinEditor({ kind, label, value, choices, busy, onSave, onCancel }) {
  const [draft, setDraft] = useState(() => toDraft(kind, value));
  // Escape leaves without saving, as it does in every other editor on the page.
  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const parsed = fromDraft(kind, draft);
  const submit = (event) => {
    event.preventDefault();
    if (parsed.ok) onSave(parsed.value);
  };
  const multiline = kind === "paragraph" || kind === "lines";

  return (
    <form onSubmit={submit} className={cn("flex gap-1.5", multiline ? "w-full flex-col" : "items-center")}>
      {kind === "color" && (
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(draft) ? draft : "#000000"} onChange={(event) => setDraft(event.target.value)} aria-label={`${label} colour picker`} className="size-7 shrink-0 cursor-pointer rounded-md border border-orb-line bg-transparent p-0" />
      )}
      {kind === "choice" ? (
        <Select items={choices} value={draft === "" ? null : draft} onValueChange={(next) => { if (next !== null) setDraft(next); }}>
          <SelectTrigger size="xs" aria-label={label} autoFocus>
            <SelectValue placeholder="Choose…" />
          </SelectTrigger>
          <SelectContent>
            {choices.map((choice) => <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>)}
          </SelectContent>
        </Select>
      ) : multiline ? (
        <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={label} autoFocus rows={kind === "lines" ? 6 : 4} className="text-sm" />
      ) : (
        <Input value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={label} autoFocus autoComplete="off" spellCheck={false} className={cn("h-7 px-2 text-xs", kind === "number" ? "w-20" : kind === "color" ? "w-24 font-mono" : "w-64")} />
      )}
      <span className="flex items-center gap-1">
        <Button type="submit" size="xs" disabled={busy || !parsed.ok} title="Pin this value: the agent keeps it when it derives the system again">
          <Check /> Pin
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" onClick={onCancel} disabled={busy} aria-label="Cancel">
          <X />
        </Button>
        {kind === "lines" && <span className="text-2xs text-orb-muted">One per line</span>}
        {kind === "numbers" && <span className="text-2xs text-orb-muted">Separated by commas</span>}
      </span>
    </form>
  );
}

/** A value as the text its editor starts with. */
function toDraft(kind, value) {
  if (kind === "lines") return (Array.isArray(value) ? value : []).join("\n");
  if (kind === "numbers") return (Array.isArray(value) ? value : []).join(", ");
  return value === null || value === undefined ? "" : String(value);
}

/** What an editor's text means, or that it does not mean anything yet. */
function fromDraft(kind, draft) {
  const text = draft.trim();
  if (kind === "number") {
    const number = Number(text);
    return text && Number.isFinite(number) ? { ok: true, value: number } : { ok: false };
  }
  if (kind === "color") return /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(text) ? { ok: true, value: text.startsWith("#") ? text : `#${text}` } : { ok: false };
  if (kind === "lines") return { ok: true, value: draft.split("\n").map((line) => line.trim()).filter(Boolean) };
  if (kind === "numbers") {
    const numbers = text.split(/[,\s]+/).filter(Boolean).map(Number);
    return numbers.length && numbers.every(Number.isFinite) ? { ok: true, value: numbers } : { ok: false };
  }
  if (kind === "choice") return { ok: true, value: draft };
  return text ? { ok: true, value: text } : { ok: false };
}

/**
 * The heading every section of the page opens with: the app's section heading (docs/architecture/ui.md), one
 * or two sentences under it on what the section is, and the section's own buttons on the right.
 *
 * @param {object} props
 * @param {string} props.id the heading's identifier, which the section is labelled by
 * @param {string} props.title
 * @param {string} [props.description] one or two sentences on what the section is
 */
export function SectionHeading({ id, title, description, children }) {
  return (
    <div className="space-y-1">
      <PageSectionHeading id={id} action={children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}>
        {title}
      </PageSectionHeading>
      {description && <p className="max-w-2xl text-sm text-orb-gray">{description}</p>}
    </div>
  );
}
