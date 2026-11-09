"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BookOpen, FileText, Globe, Minus, Plus, Trash2, UserPen, X } from "lucide-react";
import useSWR from "swr";

import { blockAuthorsOf } from "./LibraryMarkdown";
import { useLibrary } from "./libraryContext";
import { useAuth } from "@/lib/auth/AuthProvider";
import { formatDate, personFromEmail } from "@/lib/format";
import { libraryRevisionsPath, searchLibrary } from "@/lib/api/library";
import { LIBRARY_LIMITS, isSourcePath, markdownLimitFor, personLabel } from "@/lib/library/library";
import { splitBlocks } from "@/lib/library/markdown";
import { cn } from "@/lib/utils";

/**
 * A draft of one file, ready to edit: its fields, and its Markdown as the blocks the server
 * records authorship in, each remembering what it said when the draft began and who wrote that.
 *
 * Identifiers are counted from the file rather than random, so the draft a tab builds on every
 * render before its first change is the same draft each time.
 *
 * A person's block also remembers which person (`writer`): `{userId, email}` from the server,
 * null for an account that is gone, and absent when the server does not say — a file from before
 * workspaces had members, whose every passage is the reader's.
 *
 * @param {object} node the file, as the API returned it
 */
export function startDraft(node) {
  const yours = new Set((node.userBlocks ?? []).map((text) => text.trim()));
  const writers = blockAuthorsOf(node);
  const blocks = splitBlocks(node.markdown ?? "").map((text, index) => {
    const user = yours.has(text.trim());
    return {
      id: `b${index}`,
      text,
      original: text,
      origin: user ? "user" : "agent",
      ...(user && writers ? { writer: writers.get(text.trim()) ?? null } : {}),
    };
  });
  return {
    path: node.path,
    revision: node.revision ?? 1,
    title: node.title ?? "",
    summary: node.summary ?? "",
    tags: node.tags ?? [],
    blocks,
    removed: [],
    seq: blocks.length,
    dirty: false,
  };
}

/**
 * What saving a draft sends.
 *
 * When no block was changed, added, removed or moved, the file's Markdown goes back exactly as it
 * came, so a save that only retitled a file does not also rewrite its spacing. The sources are the
 * agent's record of where the file came from, not something this editor changes; they are sent
 * back as they were, so a person's correction does not erase the provenance of the passages they
 * left alone.
 */
export function draftBody(node, draft) {
  const texts = draft.blocks.map((block) => block.text.trim()).filter(Boolean);
  return {
    kind: "file",
    title: draft.title.trim(),
    summary: draft.summary.trim(),
    markdown: sameBlocks(node, texts) ? node.markdown ?? "" : texts.join("\n\n"),
    tags: draft.tags,
    sources: (node.sources ?? []).map((source) => ({ kind: source.kind, ref: source.url ?? source.key })),
  };
}

/** Whether a list of block texts is the file's own, block for block. */
function sameBlocks(node, texts) {
  const original = splitBlocks(node.markdown ?? "");
  return texts.length === original.length && texts.every((text, index) => text === original[index]);
}

/** Whether a draft differs from the file it was started from. */
function isDirty(node, draft) {
  return draft.title !== (node.title ?? "")
    || draft.summary !== (node.summary ?? "")
    || draft.tags.join("\u0000") !== (node.tags ?? []).join("\u0000")
    || draft.removed.length > 0
    || !sameBlocks(node, draft.blocks.map((block) => block.text.trim()).filter(Boolean));
}

/**
 * Who a block is by now: the agent's, untouched; the reader's, kept from before; somebody else's,
 * kept from before; or the reader's because they just changed or wrote it.
 */
function authorOf(block, viewerId) {
  if (block.origin === "new") return "new";
  if (block.text.trim() !== block.original.trim()) return "changed";
  if (block.origin !== "user") return "agent";
  return isViewers(block, viewerId) ? "yours" : "theirs";
}

/** Whether a person's block is the reader's own: it is, unless the server names someone else. */
function isViewers(block, viewerId) {
  if (!("writer" in block) || !viewerId) return true;
  return block.writer?.userId === viewerId;
}

/** The name of a block's writer, for a block that is somebody else's. */
function writerOf(block) {
  return personFromEmail(block.writer?.email) ?? { name: "someone", initial: "?" };
}

/**
 * A Library file, open to write in, block by block.
 *
 * The file is shown as the blocks the server keeps authorship in, each with a mark in the gutter
 * saying whose it is — the agent's, or yours — because the rule a person editing a shared file
 * needs is visible here rather than explained: what you type or change becomes yours and the agent
 * writes around it on every run; what you delete stays deleted and the agent does not put it back.
 * A deleted block stays on screen, struck through, until the save, with Undo beside it.
 *
 * Each block is plain Markdown in a field that grows with it. A blank line starts a new block;
 * Backspace at the start of one joins it to the block above; `[[` offers the Library's files to
 * link, by title. ⌘S saves without leaving.
 *
 * Beside it, while there is room, is what editing does: who wrote what in this file, the two
 * rules, the lock, and the file's history.
 *
 * @param {object} props
 * @param {object} props.node the file as it is saved
 * @param {object} props.draft the tab's draft, from `startDraft`
 * @param {(draft: object) => void} props.onDraft
 * @param {() => void} props.onSave saves and stays
 * @param {boolean} props.showAside
 */
export function LibraryBlockEditor({ node, draft, onDraft, onSave, showAside }) {
  const library = useLibrary();
  const fields = useRef(new Map());
  const pendingFocus = useRef(null);
  const [tagDraft, setTagDraft] = useState("");
  const viewerId = useAuth().user?.id ?? null;
  const limit = markdownLimitFor(node.path);
  const length = draft.blocks.reduce((total, block) => total + block.text.length + 2, 0);
  const counts = useMemo(() => {
    const authors = draft.blocks.map((block) => authorOf(block, viewerId));
    // Other people's passages, one line each, in the order they first appear.
    const others = new Map();
    draft.blocks.forEach((block, index) => {
      if (authors[index] !== "theirs") return;
      const key = block.writer?.userId ?? "?";
      const entry = others.get(key) ?? { key, ...writerOf(block), count: 0 };
      others.set(key, { ...entry, count: entry.count + 1 });
    });
    return {
      yours: authors.filter((author) => author !== "agent" && author !== "theirs").length,
      fresh: authors.filter((author) => author === "new" || author === "changed").length,
      agent: authors.filter((author) => author === "agent").length,
      others: [...others.values()],
      removed: draft.removed.length,
    };
  }, [draft.blocks, draft.removed.length, viewerId]);

  /** Applies a change to the draft and works out again whether it differs from the file. */
  function change(update) {
    const next = { ...draft, ...update(draft) };
    onDraft({ ...next, dirty: isDirty(node, next) });
  }

  // Focus moves to a block once it exists: after a split, a join or a delete.
  useLayoutEffect(() => {
    const wanted = pendingFocus.current;
    if (!wanted) return;
    const field = fields.current.get(wanted.id);
    if (!field) return;
    pendingFocus.current = null;
    field.focus();
    const at = wanted.at === "end" ? field.value.length : wanted.at;
    field.setSelectionRange(at, at);
  });

  /** The text of one block changed: a blank line in it splits it into blocks. */
  function edit(id, text) {
    const trailing = /\n[ \t]*\n[ \t]*$/.test(text) && !openFence(text);
    const parts = splitBlocks(text);
    if (parts.length <= 1 && !trailing) {
      change((current) => ({ blocks: current.blocks.map((block) => (block.id === id ? { ...block, text } : block)) }));
      return;
    }
    change((current) => {
      let seq = current.seq;
      const at = current.blocks.findIndex((block) => block.id === id);
      const head = { ...current.blocks[at], text: parts[0] ?? "" };
      const rest = [...parts.slice(1), ...(trailing ? [""] : [])].map((part) => {
        seq += 1;
        return { id: `n${seq}`, text: part, original: "", origin: "new" };
      });
      const focus = rest.length === 1 && !trailing ? { id: rest[0].id, at: 0 } : { id: rest.at(-1).id, at: "end" };
      pendingFocus.current = focus;
      return { seq, blocks: [...current.blocks.slice(0, at), head, ...rest, ...current.blocks.slice(at + 1)] };
    });
  }

  /** Adds an empty block after another, or at the end, and puts the cursor in it. */
  function add(afterId = null) {
    change((current) => {
      const seq = current.seq + 1;
      const block = { id: `n${seq}`, text: "", original: "", origin: "new" };
      const at = afterId ? current.blocks.findIndex((each) => each.id === afterId) + 1 : current.blocks.length;
      pendingFocus.current = { id: block.id, at: 0 };
      return { seq, blocks: [...current.blocks.slice(0, at), block, ...current.blocks.slice(at)] };
    });
  }

  /**
   * Deletes a block. One the file had is kept in view, struck through, where it was, so the
   * deletion can be undone until the save; one written in this draft simply goes.
   */
  function remove(id, { focusPrevious = false } = {}) {
    change((current) => {
      const at = current.blocks.findIndex((block) => block.id === id);
      const block = current.blocks[at];
      const after = at > 0 ? current.blocks[at - 1].id : null;
      if (focusPrevious && after) pendingFocus.current = { id: after, at: "end" };
      const blocks = current.blocks.filter((each) => each.id !== id);
      // Anything struck through below this block moves up to the block above it.
      const removed = current.removed.map((entry) => (entry.after === id ? { ...entry, after } : entry));
      if (block.origin === "new") return { blocks, removed };
      const writer = "writer" in block ? { writer: block.writer } : {};
      return { blocks, removed: [...removed, { id: block.id, text: block.original, origin: block.origin, ...writer, after }] };
    });
  }

  /** Puts a deleted block back where it was. */
  function undo(entryId) {
    change((current) => {
      const entry = current.removed.find((each) => each.id === entryId);
      const at = entry.after ? current.blocks.findIndex((block) => block.id === entry.after) + 1 : 0;
      const block = { id: entry.id, text: entry.text, original: entry.text, origin: entry.origin, ...("writer" in entry ? { writer: entry.writer } : {}) };
      return {
        blocks: [...current.blocks.slice(0, at), block, ...current.blocks.slice(at)],
        removed: current.removed.filter((each) => each.id !== entryId),
      };
    });
  }

  /** Joins a block to the one above it: Backspace at its start. */
  function join(id) {
    change((current) => {
      const at = current.blocks.findIndex((block) => block.id === id);
      if (at <= 0) return {};
      const above = current.blocks[at - 1];
      const block = current.blocks[at];
      pendingFocus.current = { id: above.id, at: above.text.length + (above.text && block.text ? 1 : 0) };
      const text = above.text && block.text ? `${above.text}\n${block.text}` : above.text || block.text;
      const blocks = [...current.blocks.slice(0, at - 1), { ...above, text }, ...current.blocks.slice(at + 1)];
      const removed = current.removed.map((entry) => (entry.after === id ? { ...entry, after: above.id } : entry));
      return { blocks, removed };
    });
  }

  function addTag(value) {
    const tag = value.trim().replace(/,+$/, "").trim();
    setTagDraft("");
    if (!tag || draft.tags.includes(tag) || draft.tags.length >= LIBRARY_LIMITS.tags) return;
    change((current) => ({ tags: [...current.tags, tag] }));
  }

  const struck = (after) => draft.removed.filter((entry) => entry.after === after);
  const stale = (node.revision ?? 1) !== draft.revision;

  return (
    <>
      <div
        className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pt-7 pb-16 md:px-10"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            onSave();
          }
        }}
      >
        <div className="mx-auto grid max-w-[47.5rem] grid-cols-[2rem_minmax(0,1fr)] gap-x-3 gap-y-1">
          {stale && (
            <p role="alert" className="col-start-2 mb-3 rounded-2xl border border-orb-orange/40 bg-orb-orange/10 px-3.5 py-2.5 text-compact text-orb-white">
              This file was rewritten while you were editing — it is at revision {node.revision} now. Saving replaces
              that version with yours; what it said stays in History.
            </p>
          )}

          <span />
          <div className="mb-4 border-b border-orb-line pb-4">
            <label htmlFor={`${draft.path}-title`} className="block text-2xs font-medium tracking-[0.12em] text-orb-muted uppercase">Title</label>
            <input
              id={`${draft.path}-title`}
              value={draft.title}
              maxLength={LIBRARY_LIMITS.title}
              onChange={(event) => change(() => ({ title: event.target.value }))}
              className="w-full bg-transparent py-0.5 font-display text-title leading-snug font-bold tracking-[-0.015em] text-orb-white outline-none placeholder:text-orb-muted"
              placeholder="A title"
            />
            <label htmlFor={`${draft.path}-summary`} className="mt-2 block text-2xs font-medium tracking-[0.12em] text-orb-muted uppercase">Summary</label>
            <input
              id={`${draft.path}-summary`}
              value={draft.summary}
              maxLength={LIBRARY_LIMITS.summary}
              onChange={(event) => change(() => ({ summary: event.target.value }))}
              className="w-full bg-transparent py-0.5 text-sm text-orb-gray outline-none placeholder:text-orb-muted"
              placeholder="One sentence on what this file is for"
            />
            {(!draft.title.trim() || !draft.summary.trim()) && (
              <p className="mt-1 text-xs text-orb-coral">A file needs a title and a summary before it can be saved.</p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {draft.tags.map((tag) => (
                <span key={tag} className="inline-flex h-6 items-center gap-1 rounded-full bg-orb-raised pr-1 pl-2.5 text-xs text-orb-white">
                  {tag}
                  <button
                    type="button"
                    aria-label={`Remove the tag ${tag}`}
                    onClick={() => change((current) => ({ tags: current.tags.filter((other) => other !== tag) }))}
                    className="flex size-[18px] items-center justify-center rounded-full text-orb-muted hover:text-orb-white"
                  >
                    <X aria-hidden="true" className="size-2.5" />
                  </button>
                </span>
              ))}
              <label className="sr-only" htmlFor={`${draft.path}-tag`}>Add a tag</label>
              <input
                id={`${draft.path}-tag`}
                value={tagDraft}
                disabled={draft.tags.length >= LIBRARY_LIMITS.tags}
                placeholder={draft.tags.length >= LIBRARY_LIMITS.tags ? "That is the most tags" : "Add a tag"}
                onChange={(event) => (event.target.value.endsWith(",") ? addTag(event.target.value) : setTagDraft(event.target.value))}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addTag(tagDraft); } }}
                onBlur={() => addTag(tagDraft)}
                className="h-6 w-28 rounded-full border border-dashed border-orb-line bg-transparent px-2.5 text-xs text-orb-white outline-none placeholder:text-orb-muted focus:border-orb-muted"
              />
            </div>
          </div>

          {struck(null).map((entry) => <Struck key={entry.id} entry={entry} onUndo={() => undo(entry.id)} />)}

          {draft.blocks.map((block, position) => (
            <BlockRow
              key={block.id}
              block={block}
              first={position === 0}
              register={(field) => { if (field) fields.current.set(block.id, field); else fields.current.delete(block.id); }}
              onEdit={(text) => edit(block.id, text)}
              onRemove={() => remove(block.id, { focusPrevious: true })}
              onJoin={() => join(block.id)}
              onAddAfter={() => add(block.id)}
              struck={struck(block.id)}
              onUndo={undo}
              viewerId={viewerId}
            />
          ))}

          <span />
          <button
            type="button"
            onClick={() => add()}
            className="mt-3 inline-flex h-8 w-fit items-center gap-1.5 rounded-full border border-dashed border-orb-line px-3 text-xs text-orb-gray hover:border-orb-muted hover:text-orb-white"
          >
            <Plus aria-hidden="true" className="size-3.5" /> Add a paragraph
          </button>
          {length > limit * 0.9 && (
            <p className={cn("col-start-2 mt-2 text-xs", length > limit ? "text-orb-coral" : "text-orb-muted")}>
              {length.toLocaleString()} of {limit.toLocaleString()} characters{length > limit ? ": shorten it before saving." : "."}
            </p>
          )}
        </div>
      </div>

      {showAside && (
        <WhileYouEdit node={node} draft={draft} counts={counts} library={library} viewerId={viewerId} />
      )}
    </>
  );
}

/**
 * One block of the file: its author's mark in the gutter, and its Markdown in a field that grows.
 *
 * The person's blocks sit on a raised card, as they do while reading, so the edit looks like what
 * it will become. A heading is set as a heading while it is typed; the rest is the document's own
 * body type.
 */
function BlockRow({ block, first, register, onEdit, onRemove, onJoin, onAddAfter, struck, onUndo, viewerId }) {
  const author = authorOf(block, viewerId);
  const mine = author !== "agent";
  const writer = author === "theirs" || (author === "changed" && !isViewers(block, viewerId)) ? writerOf(block) : null;
  const heading = /^#{1,3}\s/.test(block.text);
  const code = /^\s*(```|~~~)/.test(block.text);
  const field = useRef(null);
  const chooserRef = useRef(null);
  const [links, setLinks] = useState(null);

  // The field is as tall as its text, on every change and whenever the column is resized.
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return undefined;
    const fit = () => {
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element.parentElement);
    return () => observer.disconnect();
  }, [block.text]);

  /** Looks for a `[[` the cursor is inside, and offers the files it could link to. */
  function lookForLink(element) {
    const caret = element.selectionStart;
    if (caret !== element.selectionEnd) return setLinks(null);
    const before = element.value.slice(0, caret);
    const open = before.lastIndexOf("[[");
    const query = open >= 0 ? before.slice(open + 2) : null;
    if (query === null || /[\]\n]/.test(query) || query.length > 60) return setLinks(null);
    const at = caretCoordinates(element, open);
    setLinks((current) => ({ query, open, caret, top: at.top + at.height, left: at.left, highlighted: current?.query === query ? current.highlighted : 0 }));
  }

  /** Writes the chosen link in place of what was typed after `[[`. */
  function insertLink(path) {
    const element = field.current;
    if (!element || !links) return;
    const text = `${element.value.slice(0, links.open)}[[${path}]]${element.value.slice(links.caret)}`;
    const at = links.open + path.length + 4;
    onEdit(text);
    setLinks(null);
    window.requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(at, at);
    });
  }

  return (
    <>
      <AuthorMark author={author} writer={writer} first={first} heading={heading} />
      <div className="group/block relative">
        <div
          className={cn(
            "relative rounded-[13px] transition-shadow",
            mine ? "bg-orb-raised px-3.5 py-2 ring-1 ring-orb-white/10" : "px-0 py-0.5",
            "focus-within:ring-1 focus-within:ring-orb-lime focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-orb-lime)_30%,transparent)]",
            !mine && "focus-within:px-3.5 focus-within:-mx-3.5",
            first ? "mt-0" : heading ? "mt-4" : "mt-2",
          )}
        >
          {(author === "yours" || author === "theirs" || author === "changed") && (
            <p className="mb-0.5 text-2xs font-medium tracking-[0.12em] text-orb-muted uppercase">
              {author === "yours"
                ? "Your writing · kept"
                : author === "theirs"
                  ? `${writer.name}'s writing · kept`
                  : block.origin === "agent"
                    ? "Yours now · changed from the agent's"
                    : writer ? `Yours now · changed from ${writer.name}'s` : "Your writing · changed"}
            </p>
          )}
          <label className="sr-only" htmlFor={`block-${block.id}`}>
            {author === "agent" ? "A passage the agent wrote" : author === "theirs" ? `A passage ${writer.name} wrote` : "A passage you wrote"}
          </label>
          <textarea
            id={`block-${block.id}`}
            ref={(element) => { field.current = element; register(element); }}
            value={block.text}
            rows={1}
            spellCheck
            placeholder={block.text ? undefined : "Write here. A blank line starts a new block; [[ links a file."}
            onChange={(event) => { onEdit(event.target.value); lookForLink(event.target); }}
            onClick={(event) => lookForLink(event.target)}
            onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) lookForLink(event.target); }}
            onBlur={() => window.setTimeout(() => setLinks(null), 120)}
            onKeyDown={(event) => {
              if (links && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) {
                event.preventDefault();
                if (event.key === "Escape") return setLinks(null);
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  const by = event.key === "ArrowDown" ? 1 : -1;
                  return setLinks((current) => ({ ...current, highlighted: Math.max(0, (current.highlighted ?? 0) + by) }));
                }
                return chooserRef.current?.();
              }
              const element = event.target;
              if (event.key === "Backspace" && element.selectionStart === 0 && element.selectionEnd === 0) {
                if (!element.value) {
                  event.preventDefault();
                  onRemove();
                } else if (!first) {
                  event.preventDefault();
                  onJoin();
                }
              }
              if (event.key === "Escape") element.blur();
            }}
            className={cn(
              "block w-full resize-none overflow-hidden bg-transparent outline-none placeholder:text-orb-muted",
              heading
                ? "font-display text-[1.375rem] leading-snug font-bold tracking-[-0.015em] text-orb-white"
                : code
                  ? "font-mono text-compact leading-relaxed text-orb-white"
                  : cn("text-[0.9375rem] leading-[1.7]", mine ? "text-orb-white" : "text-orb-gray"),
            )}
          />
          {links && (
            <LinkSuggestions
              links={links}
              chooserRef={chooserRef}
              onHighlight={(highlighted) => setLinks((current) => ({ ...current, highlighted }))}
              onChoose={insertLink}
              onClose={() => setLinks(null)}
            />
          )}
        </div>
        <span className="absolute top-1 -right-9 hidden flex-col gap-0.5 opacity-0 transition-opacity group-focus-within/block:opacity-100 group-hover/block:opacity-100 md:flex">
          <button type="button" aria-label="Delete this block" title="Delete this block" onClick={onRemove} className="flex size-6 items-center justify-center rounded-md text-orb-muted hover:bg-orb-raised hover:text-orb-coral">
            <Trash2 aria-hidden="true" className="size-3.5" />
          </button>
          <button type="button" aria-label="Add a block below" title="Add a block below" onClick={onAddAfter} className="flex size-6 items-center justify-center rounded-md text-orb-muted hover:bg-orb-raised hover:text-orb-white">
            <Plus aria-hidden="true" className="size-3.5" />
          </button>
        </span>
      </div>
      {struck.map((entry) => <Struck key={entry.id} entry={entry} onUndo={() => onUndo(entry.id)} />)}
    </>
  );
}

/**
 * The gutter mark of a block: an outline for the agent's, a filled disc for yours, and somebody
 * else's initial on a raised disc for theirs.
 */
function AuthorMark({ author, writer, first, heading }) {
  const label = author === "agent"
    ? "Written by the knowledge base agent"
    : author === "yours" ? "Your writing" : author === "theirs" ? `Written by ${writer.name}` : "Your writing, not saved yet";
  return (
    <span
      title={label}
      className={cn(
        "inline-flex size-[22px] items-center justify-center justify-self-center rounded-full",
        author === "agent"
          ? "border-[1.5px] border-orb-line text-orb-muted"
          : author === "theirs" ? "bg-orb-raised text-[0.625rem] font-semibold text-orb-white ring-1 ring-orb-line" : "bg-orb-white text-orb-black",
        first ? "mt-1.5" : heading ? "mt-[1.375rem]" : "mt-3.5",
      )}
    >
      {author === "agent"
        ? <BookOpen aria-hidden="true" className="size-[11px]" />
        : author === "theirs" ? <span aria-hidden="true">{writer.initial}</span> : <UserPen aria-hidden="true" className="size-[11px]" />}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** A block deleted in this draft: struck through where it was, with the way to put it back. */
function Struck({ entry, onUndo }) {
  return (
    <>
      <span title="You deleted this" className="mt-2.5 inline-flex size-[22px] items-center justify-center justify-self-center rounded-full border-[1.5px] border-dashed border-orb-coral text-orb-coral">
        <Minus aria-hidden="true" className="size-[11px]" />
        <span className="sr-only">You deleted this</span>
      </span>
      <div className="mt-2 flex min-w-0 items-center gap-2.5 text-compact text-orb-gray">
        <span className="min-w-0 flex-1 truncate line-through decoration-orb-coral/60">{flatten(entry.text)}</span>
        <span className="shrink-0 text-xs text-orb-coral">{entry.origin === "agent" ? "deleted · stays deleted" : "deleted"}</span>
        <button type="button" onClick={onUndo} className="shrink-0 text-xs text-orb-white underline underline-offset-[3px] hover:text-orb-cyan">Undo</button>
      </div>
    </>
  );
}

/**
 * The files a `[[` could link to, under the cursor.
 *
 * The Library's own files are matched in the page from the tree it holds, at once; the copies of
 * the site's pages are too many to hold, so they are searched for as well, and shown below.
 */
function LinkSuggestions({ links, chooserRef, onHighlight, onChoose, onClose }) {
  const library = useLibrary();
  const query = links.query.trim().toLowerCase();
  const [found, setFound] = useState({ query: null, matches: [] });

  useEffect(() => {
    if (query.length < 2) return undefined;
    const timer = window.setTimeout(async () => {
      try {
        const result = await searchLibrary(library.workspaceId, query, { path: "/sources", limit: 4 });
        setFound({ query, matches: result.matches ?? [] });
      } catch {
        setFound({ query, matches: [] });
      }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [library.workspaceId, query]);

  const options = useMemo(() => {
    const rows = [];
    for (const node of library.index.values()) {
      if (isSourcePath(node.path)) continue;
      const title = (node.title || node.name || "").toLowerCase();
      const score = !query ? 1 : title.startsWith(query) ? 3 : title.includes(query) ? 2 : node.path.includes(query) ? 1 : 0;
      if (score) rows.push({ node, score });
    }
    const local = rows
      .sort((left, right) => right.score - left.score || (left.node.kind === "file" ? -1 : 1) || left.node.path.localeCompare(right.node.path))
      .slice(0, 5)
      .map((row) => row.node);
    const remote = found.query === query ? found.matches.filter((match) => !local.some((node) => node.path === match.path)).slice(0, 3) : [];
    return [...local, ...remote];
  }, [library.index, query, found]);
  const highlighted = Math.min(links.highlighted ?? 0, Math.max(options.length - 1, 0));

  // Enter or Tab in the field takes the highlighted one: the field calls this when it is pressed.
  useEffect(() => {
    chooserRef.current = () => (options[highlighted] ? onChoose(options[highlighted].path) : onClose());
  });

  // A block at the foot of the screen would open its list below the edge; the column scrolls
  // just enough to show it.
  const listRef = useRef(null);
  const shown = options.length > 0 || query.length >= 2;
  useEffect(() => {
    if (shown) listRef.current?.scrollIntoView({ block: "nearest" });
  }, [shown]);

  if (!shown) return null;

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Link to a file"
      className="absolute z-20 w-[min(26rem,calc(100vw-3rem))] rounded-2xl bg-popover p-1.5 shadow-[0_0_0_1px_color-mix(in_oklab,var(--moon-white)_10%,transparent),0_10px_15px_-3px_rgba(0,0,0,0.4)]"
      style={{ top: `${links.top + 6}px`, left: `${Math.max(0, Math.min(links.left, 320))}px` }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {options.length ? options.map((node, index) => {
        const source = isSourcePath(node.path);
        const Icon = source ? Globe : FileText;
        return (
          <button
            key={node.path}
            type="button"
            role="option"
            aria-selected={index === highlighted}
            onMouseEnter={() => onHighlight(index)}
            onClick={() => onChoose(node.path)}
            className={cn("flex w-full gap-2.5 rounded-xl px-2.5 py-2 text-left", index === highlighted && "bg-orb-line")}
          >
            <Icon aria-hidden="true" className={cn("mt-0.5 size-[15px] shrink-0", source ? "text-orb-cyan" : "text-orb-white")} />
            <span className="min-w-0">
              <span className="block truncate text-compact text-orb-white">{node.title || node.name}</span>
              <span className="block truncate text-xs text-orb-muted">{library.crumbsFor(node.path).slice(1).map((crumb) => crumb.label).join(" / ") || node.path}</span>
            </span>
          </button>
        );
      }) : (
        <p className="px-2.5 py-2 text-compact text-orb-muted">No file is called that.</p>
      )}
      <p className="mt-0.5 flex gap-3.5 border-t border-orb-line px-2.5 pt-1.5 pb-0.5 text-xs text-orb-muted">
        <span>↵ link</span><span>↑↓ move</span><span>esc close</span>
      </p>
    </div>
  );
}

/**
 * What editing does, beside the editor: who wrote what in this file, the two rules, the lock, and
 * the file's history.
 */
function WhileYouEdit({ node, draft, counts, library, viewerId }) {
  const { data } = useSWR(libraryRevisionsPath(library.workspaceId, node.path));
  const revisions = data?.revisions ?? [];

  return (
    <aside aria-label="While you edit" className="hidden w-70 shrink-0 flex-col gap-5 overflow-y-auto border-l border-orb-line p-4 text-compact text-orb-gray lg:flex">
      <section>
        <Heading>Who wrote what</Heading>
        <ul className="flex flex-col gap-2">
          <li className="flex items-center gap-2.5">
            <span aria-hidden="true" className="size-[18px] shrink-0 rounded-full bg-orb-white" />
            <span><strong className="font-medium text-orb-white">You</strong> · {plural(counts.yours, "passage")}{counts.fresh ? `, ${counts.fresh} new` : ""}</span>
          </li>
          {counts.others.map((other) => (
            <li key={other.key} className="flex items-center gap-2.5">
              <span aria-hidden="true" className="grid size-[18px] shrink-0 place-items-center rounded-full bg-orb-raised text-[0.5625rem] font-semibold text-orb-white ring-1 ring-orb-line">{other.initial}</span>
              <span><strong className="font-medium text-orb-white">{other.name}</strong> · {plural(other.count, "passage")}</span>
            </li>
          ))}
          <li className="flex items-center gap-2.5">
            <span aria-hidden="true" className="size-[18px] shrink-0 rounded-full border-[1.5px] border-orb-line" />
            <span><strong className="font-medium text-orb-white">Agent</strong> · {plural(counts.agent, "passage")}</span>
          </li>
          {counts.removed > 0 && (
            <li className="flex items-center gap-2.5">
              <span aria-hidden="true" className="size-[18px] shrink-0 rounded-full border-[1.5px] border-dashed border-orb-coral" />
              <span><strong className="font-medium text-orb-white">Deleted by you</strong> · {counts.removed}</span>
            </li>
          )}
        </ul>
      </section>

      <section>
        <Heading>The rules</Heading>
        <p className="mb-2 leading-snug">Anything you type or change becomes your writing. The agent keeps every word of it when it rewrites this file.</p>
        <p className="leading-snug">What you delete stays deleted. The agent does not write it back.</p>
      </section>

      <section className="flex items-start gap-2.5 rounded-xl border border-orb-line bg-orb-black p-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-orb-white">Lock this file</p>
          <p className="mt-0.5 text-xs leading-4 text-orb-muted">Agents stay out entirely, even to add what the site says next.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={node.locked}
          aria-label="Lock this file"
          disabled={library.busy}
          onClick={() => library.toggleLock(node)}
          className={cn("relative h-5 w-[34px] shrink-0 rounded-full transition-colors disabled:opacity-50", node.locked ? "bg-orb-lime" : "bg-orb-line")}
        >
          <span aria-hidden="true" className={cn("absolute top-0.5 size-4 rounded-full transition-all", node.locked ? "right-0.5 bg-orb-black" : "left-0.5 bg-orb-gray")} />
        </button>
      </section>

      <section>
        <Heading>Link to a file</Heading>
        <p className="leading-snug">Type <kbd className="rounded border border-orb-line px-1 font-mono text-xs text-orb-white">[[</kbd> and the file&apos;s name.</p>
      </section>

      <section>
        <Heading>History</Heading>
        <ul className="flex flex-col gap-1.5 tabular-nums">
          {draft.dirty && (
            <li className="flex justify-between gap-2"><span className="text-orb-white">Unsaved</span><span>you · now</span></li>
          )}
          {revisions.slice(0, 6).map((revision) => (
            <li key={revision.revision}>
              <button
                type="button"
                onClick={() => library.openHistory({ ...node, userBlocks: node.userBlocks }, {})}
                className="flex w-full justify-between gap-2 text-left hover:text-orb-white"
              >
                <span>Revision {revision.revision}</span>
                <span>{revision.updatedBy?.kind === "user" ? personLabel(revision.updatedBy, "you", viewerId) : "agent"} · {formatDate(revision.createdAt, { time: false })}</span>
              </button>
            </li>
          ))}
          {!data && <li className="text-xs text-orb-muted">Loading…</li>}
        </ul>
      </section>
    </aside>
  );
}

function Heading({ children }) {
  return <h3 className="mb-2.5 font-sans text-2xs font-medium tracking-[0.12em] text-orb-muted uppercase">{children}</h3>;
}

function plural(count, word) {
  return `${count.toLocaleString()} ${count === 1 ? word : `${word}s`}`;
}

/** Whether a block's text leaves a code fence open, inside which a blank line is not a break. */
function openFence(text) {
  return (String(text).match(/^[ \t]{0,3}(```|~~~)/gm) ?? []).length % 2 === 1;
}

/** One line of plain text from a block, for a struck-through row. */
function flatten(text) {
  return String(text ?? "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_match, path, label) => label || path)
    .replace(/[*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Properties copied to the measuring copy of a field, so it wraps text as the field does. */
const MIRRORED = [
  "boxSizing", "width", "borderLeftWidth", "borderRightWidth", "borderTopWidth", "paddingTop", "paddingRight",
  "paddingBottom", "paddingLeft", "fontStyle", "fontVariant", "fontWeight", "fontStretch", "fontSize", "lineHeight",
  "fontFamily", "textAlign", "textTransform", "textIndent", "letterSpacing", "wordSpacing", "tabSize",
];

/**
 * Where a character of a field sits, relative to the field: measured on an invisible copy of it,
 * since a field does not say where its own characters are.
 */
function caretCoordinates(element, position) {
  const mirror = document.createElement("div");
  const style = window.getComputedStyle(element);
  for (const property of MIRRORED) mirror.style[property] = style[property];
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.textContent = element.value.slice(0, position);
  const marker = document.createElement("span");
  marker.textContent = element.value.slice(position) || ".";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const at = {
    top: marker.offsetTop + element.offsetTop - element.scrollTop,
    left: marker.offsetLeft + element.offsetLeft,
    height: parseFloat(style.lineHeight) || 20,
  };
  document.body.removeChild(mirror);
  return at;
}
