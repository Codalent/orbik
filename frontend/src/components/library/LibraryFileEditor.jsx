"use client";

import { useState } from "react";
import { Check, Lock, LockOpen, Pencil, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { LIBRARY_LIMITS, markdownLimitFor } from "@/lib/library/library";

/**
 * A Library file, open to write in.
 *
 * The same column the file was being read in, so editing is a change of state rather than a trip
 * to a form somewhere else — and the rail beside it changes with it, from where this came from to
 * what happens when you save. That rail is the point. A person editing a file two writers share
 * needs to know, before they commit, that what they type becomes theirs, that what they delete
 * stays deleted, and that the version they are replacing is not gone. Saying it beside the box is
 * worth more than saying it in a dialog afterwards.
 *
 * @param {object} props
 * @param {object} props.node the file or folder being edited
 * @param {boolean} props.busy
 * @param {(body: object) => Promise<unknown>} props.onSave
 * @param {() => void} props.onCancel
 * @param {(node: object) => void} props.onToggleLock
 */
export function LibraryFileEditor({ node, busy, onSave, onCancel, onToggleLock }) {
  const isFolder = node.kind === "folder";
  const [draft, setDraft] = useState(() => ({
    title: node.title ?? "",
    summary: node.summary ?? "",
    markdown: node.markdown ?? "",
    tags: node.tags ?? [],
  }));
  const [tagDraft, setTagDraft] = useState("");

  const dirty =
    draft.title !== (node.title ?? "")
    || draft.summary !== (node.summary ?? "")
    || (!isFolder && (draft.markdown !== (node.markdown ?? "") || draft.tags.join("\u0000") !== (node.tags ?? []).join("\u0000")));
  const valid = draft.title.trim() && draft.summary.trim();

  function change(values) {
    setDraft((current) => ({ ...current, ...values }));
  }

  function addTag(value) {
    const tag = value.trim().replace(/,+$/, "").trim();
    setTagDraft("");
    if (!tag || draft.tags.includes(tag) || draft.tags.length >= LIBRARY_LIMITS.tags) return;
    change({ tags: [...draft.tags, tag] });
  }

  async function submit(event) {
    event.preventDefault();
    if (!valid) return;
    await onSave({
      kind: node.kind,
      title: draft.title.trim(),
      summary: draft.summary.trim(),
      ...(isFolder
        ? {}
        : {
          markdown: draft.markdown,
          tags: draft.tags,
          // The sources are the agent's record of where this file came from, not something this
          // form edits; they are sent back as they were so a person's correction does not erase
          // the provenance of the paragraphs they left alone.
          sources: (node.sources ?? []).map((source) => ({ kind: source.kind, ref: source.url ?? source.key })),
        }),
    });
  }

  return (
    <>
      <form onSubmit={submit} className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-orb-line pl-4 pr-3 md:pl-8">
          <p className="flex min-w-0 items-center gap-2 text-compact text-orb-gray">
            <Pencil aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="shrink-0">Editing</span>
            <span className="truncate font-mono text-xs text-orb-white">{node.path}</span>
            {dirty && (
              <>
                <span aria-hidden="true" className="text-orb-line">·</span>
                <span className="shrink-0 text-orb-muted">Unsaved changes</span>
              </>
            )}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
              <X aria-hidden="true" className="size-3.5" /> Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy || !valid || !dirty}>
              <Check aria-hidden="true" className="size-3.5" /> Save
            </Button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-6 md:px-8">
          <Field label="Title">
            <input
              type="text"
              aria-label="Title"
              value={draft.title}
              maxLength={LIBRARY_LIMITS.title}
              onChange={(event) => change({ title: event.target.value })}
              className="h-11 rounded-3xl bg-orb-line/50 px-3.5 font-display text-xl font-bold tracking-[-0.015em] text-orb-white outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
            />
          </Field>

          <Field label="Summary">
            <input
              type="text"
              aria-label="Summary"
              value={draft.summary}
              maxLength={LIBRARY_LIMITS.summary}
              onChange={(event) => change({ summary: event.target.value })}
              className="h-9 rounded-3xl bg-orb-line/50 px-3.5 text-sm text-orb-white outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
            />
          </Field>

          {!isFolder && (
            <Field
              label="Markdown"
              className="min-h-100 flex-1"
              aside={
                <span className="tabular-nums lowercase tracking-normal">
                  {draft.markdown.length.toLocaleString()} of {markdownLimitFor(node.path).toLocaleString()} characters
                </span>
              }
            >
              <textarea
                aria-label="Markdown"
                value={draft.markdown}
                maxLength={markdownLimitFor(node.path)}
                onChange={(event) => change({ markdown: event.target.value })}
                spellCheck
                className="min-h-0 flex-1 resize-none rounded-2xl bg-orb-line/50 p-4 font-mono text-compact leading-relaxed text-orb-white outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
              />
            </Field>
          )}
        </div>
      </form>

      <aside
        aria-label="While you edit"
        className="flex w-full shrink-0 flex-col gap-6 overflow-y-auto border-t border-orb-line p-5 md:w-64 md:border-l md:border-t-0"
      >
        <section>
          <h3 className="mb-2 text-2xs font-medium uppercase tracking-[0.12em] text-orb-muted">
            What happens when you save
          </h3>
          <ul className="flex flex-col gap-2.5 text-compact leading-snug text-orb-gray">
            {[
              "Every paragraph you change becomes yours. The agent writes around it on every run.",
              "What you delete stays deleted. The agent will not put it back.",
              "The version before this one stays in History.",
            ].map((line) => (
              <li key={line} className="flex gap-2">
                <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-orb-muted" />
                {line}
              </li>
            ))}
          </ul>
        </section>

        {!isFolder && (
          <>
            <section>
              <h3 className="mb-2 text-2xs font-medium uppercase tracking-[0.12em] text-orb-muted">
                Link to a file
              </h3>
              <p className="text-compact leading-snug text-orb-gray">
                Write{" "}
                <code className="rounded border border-orb-line bg-orb-black/40 px-1.5 py-px font-mono text-xs text-orb-white">
                  [[/case-studies/northwind]]
                </code>{" "}
                to link another file by its path.
              </p>
            </section>

            <section>
              <h3 className="mb-2 text-2xs font-medium uppercase tracking-[0.12em] text-orb-muted">
                <label htmlFor="library-tag">Tags</label>
              </h3>
              <div className="flex flex-wrap items-center gap-1.5 rounded-3xl bg-orb-line/50 p-1.5">
                {draft.tags.map((tag) => (
                  <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-orb-raised py-0.5 pl-2.5 pr-1 text-xs text-orb-white">
                    {tag}
                    <button
                      type="button"
                      onClick={() => change({ tags: draft.tags.filter((other) => other !== tag) })}
                      aria-label={`Remove the tag ${tag}`}
                      className="rounded-full p-0.5 text-orb-muted hover:text-orb-white"
                    >
                      <X aria-hidden="true" className="size-2.5" />
                    </button>
                  </span>
                ))}
                <input
                  id="library-tag"
                  type="text"
                  value={tagDraft}
                  placeholder={draft.tags.length >= LIBRARY_LIMITS.tags ? "That is the most" : "Add a tag"}
                  disabled={draft.tags.length >= LIBRARY_LIMITS.tags}
                  onChange={(event) => (event.target.value.endsWith(",") ? addTag(event.target.value) : setTagDraft(event.target.value))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") { event.preventDefault(); addTag(tagDraft); }
                  }}
                  onBlur={() => addTag(tagDraft)}
                  className="h-6 min-w-16 flex-1 bg-transparent px-1 text-compact text-orb-white outline-none placeholder:text-orb-muted"
                />
              </div>
            </section>
          </>
        )}

        <section>
          <h3 className="mb-2 text-2xs font-medium uppercase tracking-[0.12em] text-orb-muted">
            {node.locked ? "Let the agent back in" : "Stop the agent entirely"}
          </h3>
          <p className="mb-2.5 text-compact leading-snug text-orb-gray">
            {node.locked
              ? "This is locked: agents do not write here at all, however much your site changes."
              : "Lock it and agents will not write here at all — not even around what you have written."}
          </p>
          <Button type="button" variant="secondary" size="sm" onClick={() => onToggleLock(node)} disabled={busy}>
            {node.locked
              ? <><LockOpen aria-hidden="true" className="size-3.5" /> Unlock {isFolder ? "this folder" : "this file"}</>
              : <><Lock aria-hidden="true" className="size-3.5" /> Lock {isFolder ? "this folder" : "this file"}</>}
          </Button>
        </section>
      </aside>
    </>
  );
}

/** One labelled field, with an optional counter on the label's own line. */
function Field({ label, aside, className, children }) {
  return (
    <label className={`flex flex-col gap-1.5 text-2xs font-medium uppercase tracking-[0.12em] text-orb-muted ${className ?? ""}`}>
      <span className="flex items-baseline justify-between gap-2">
        <span>{label}</span>
        {aside}
      </span>
      {children}
    </label>
  );
}
