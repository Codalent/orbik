"use client";

import { useRef, useState } from "react";
import { ArrowUp, GripVertical, MessagesSquare, Pencil, Plus, RefreshCw, Undo2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { LABEL } from "./LibraryCreateDialog";
import { aiUnavailableSentence } from "@/lib/library/agentWait";
import { slugifySegment } from "@/lib/library/library";
import { cn } from "@/lib/utils";

/** How many top-level folders a structure may have. Mirrors `LIBRARY_LIMITS.groups` in `@orbik/library`. */
const MAX_GROUPS = 12;

/** The longest folder name a structure may use. Mirrors `LIBRARY_LIMITS.groupTitle`. */
const MAX_GROUP_TITLE = 40;

/** The longest request for a change. Mirrors `STRUCTURE_LIMITS.instruction`. */
const MAX_INSTRUCTION = 500;

/** Top-level names Orbik keeps for folders it writes itself. Mirrors `structure.js`. */
const KEPT_NAMES = Object.freeze(new Set(["sources", "brand", "overview", "index"]));

/** Requests to start from, offered under the field. */
const EXAMPLES = Object.freeze(["Merge Proof into Offer", "Add a folder for our locations", "Leave out Market"]);

/** A title's leading number and the rest: `02 Offer` is `02` and `Offer`. */
const NUMBERED = /^(\d{1,2})\s+(.*)$/;

/**
 * Choosing how the Library is organised, before the agent writes it.
 *
 * The top level of a Library is a few folders — `00 Start Here`, `01 Company`, `02 Offer` by
 * default — and they are the person's: the agent files into them and never adds, renames or
 * removes one. So before the first write run, and again when somebody asks for a rebuild, the
 * page asks. It starts from Orbik's standard folders, which the person renames, reorders (by
 * dragging the handle, or with the arrow keys on it), removes or adds to; a change that is easier
 * said than done — "merge Proof into Offer" — they ask for in words, under Suggest changes, and a
 * model makes it to the list on screen within seconds (`structure.revise`). Nothing is created
 * until they confirm, and until they do the agent waits — which is said here and in the agent's
 * own line in the header, because a Library that never fills with no reason given is the worst
 * outcome of this step.
 *
 * The numbers are part of the names, so the folders read in order; a list numbered that way is
 * renumbered as it is reordered, so the numbers always say the order on screen.
 *
 * Confirming sets the agent to work in the same press, said on the button, with a quieter way to
 * confirm without starting.
 *
 * @param {object} props
 * @param {object} props.structure the `structure` block of GET /library
 * @param {boolean} props.working whether the agent is set to work
 * @param {boolean} props.busy
 * @param {(groups: Array<object>, options: {start: boolean}) => Promise<void>} props.onChoose saves
 *   the choice, and sets the agent to work when `start`; throws a readable message
 * @param {(groups: Array<object>, instruction: string) => Promise<object>} props.onRevise asks for a
 *   change in words; resolves with the step as it stands, throws a readable message
 * @param {{availability: "available"|"unavailable"|"unknown", isAdmin: boolean}} [props.ai] whether
 *   AI is there to change the folders and write with, and whether the reader is told the setting
 *   behind it
 * @param {string} [props.startsWithin] how soon a run starts once nothing stands in its way: "a minute"
 */
export function LibraryStructureChoice({ structure, working, busy, onChoose, onRevise, ai = null, startsWithin = "a minute" }) {
  const revision = structure.revision ?? null;
  // A change answered before this page was opened is where the list had got to: start from it.
  const [draft, setDraft] = useState(() => (revision?.status === "ready" ? toDrafts(revision.groups, revision.id) : null));
  const [applied, setApplied] = useState(() => (revision?.status === "ready" ? revision.id : null));
  const [asked, setAsked] = useState(null);
  const [before, setBefore] = useState(null);
  const [askOpen, setAskOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [askFailure, setAskFailure] = useState(null);
  const [sending, setSending] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [announcement, setAnnouncement] = useState("");
  const [failure, setFailure] = useState(null);
  const [pending, setPending] = useState(false);
  const rows = useRef(new Map());

  const groups = draft ?? toDrafts(structure.defaults ?? [], "default");
  const problems = groupProblems(groups);
  const rebuild = structure.reason === "rebuild";
  const canAsk = ai?.availability !== "unavailable";
  const mine = revision && revision.id === asked ? revision : null;
  const changing = sending || mine?.status === "pending";

  // The change this page asked for has been made: the list becomes the model's, with the one
  // before it kept for Undo. Set while rendering rather than in an effect, so the new list is never
  // drawn a frame late beside the old one.
  if (mine?.status === "ready" && applied !== mine.id) {
    setApplied(mine.id);
    setBefore(groups);
    setDraft(toDrafts(mine.groups, mine.id));
    setInstruction("");
    setRenaming(null);
  }

  function change(next) {
    setDraft(renumber(next));
    setFailure(null);
  }

  function rename(index, name) {
    setDraft(groups.map((group, at) => {
      if (at !== index) return group;
      const number = NUMBERED.exec(group.title)?.[1];
      return { ...group, title: number ? `${number} ${name}` : name };
    }));
    setFailure(null);
  }

  function moveTo(from, to) {
    if (to < 0 || to >= groups.length || to === from) return;
    const next = [...groups];
    const [group] = next.splice(from, 1);
    next.splice(to, 0, group);
    change(next);
    setAnnouncement(`${nameOf(group.title)} moved to position ${to + 1} of ${groups.length}.`);
  }

  function add() {
    const key = `added-${Date.now()}`;
    // Numbered like the others when they are numbered; `renumber` gives it its place.
    const title = groups.some((group) => NUMBERED.test(group.title)) ? "99 New folder" : "New folder";
    change([...groups, { key, title, summary: "", subjects: [] }]);
    setRenaming(key);
  }

  /** While the handle is held, the row under the pointer's half-way mark is where it goes. */
  function dragOver(event, key) {
    if (dragging !== key) return;
    const from = groups.findIndex((group) => group.key === key);
    for (const [index, group] of groups.entries()) {
      const box = rows.current.get(group.key)?.getBoundingClientRect();
      if (!box || index === from) continue;
      const middle = box.top + box.height / 2;
      if ((index < from && event.clientY < middle) || (index > from && event.clientY > middle)) {
        moveTo(from, index);
        return;
      }
    }
  }

  async function ask(text = instruction) {
    const words = text.trim();
    if (!words || changing || problems.length) return;
    setSending(true);
    setAskFailure(null);
    try {
      const result = await onRevise(asGroups(groups), words);
      setAsked(result?.structure?.revision?.id ?? null);
    } catch (error) {
      setAskFailure(error?.message ?? "That change could not be asked for.");
    } finally {
      setSending(false);
    }
  }

  async function confirm({ start }) {
    if (problems.length || pending || changing) return;
    setPending(start ? "start" : "save");
    setFailure(null);
    try {
      await onChoose(asGroups(groups), { start });
    } catch (error) {
      setFailure(error?.message ?? "That structure could not be saved.");
    } finally {
      setPending(false);
    }
  }

  const disabled = busy || Boolean(pending) || problems.length > 0 || changing;

  return (
    <section aria-labelledby="library-structure-title" className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 pt-8 md:px-8 md:pt-12">
      <div className="mx-auto flex max-w-4xl flex-col gap-8">
        <header className="flex flex-col gap-3">
          <p className="text-2xs font-medium uppercase tracking-[0.12em] text-orb-lime">{rebuild ? "Rebuild" : "Set up your Library"}</p>
          <h2 id="library-structure-title" className="font-display text-[1.875rem] font-bold leading-tight tracking-[-0.035em] text-orb-white md:text-[2.25rem]">
            Choose how your Library is organised
          </h2>
          <p className="max-w-2xl text-[0.9375rem] leading-relaxed text-orb-gray">
            The agent files everything it writes into these top-level folders. Start from Orbik&apos;s standard structure:
            rename, reorder or remove folders{canAsk ? ", or ask for changes in your own words" : ""}, then confirm. You can
            change them later.
          </p>
          <details className="text-orb-muted">
            <summary className="w-max cursor-pointer rounded-md text-compact font-medium marker:text-orb-muted hover:text-orb-white">How this works</summary>
            <ul className="mt-2 max-w-2xl list-disc space-y-1 pl-5 text-compact text-orb-gray">
              <li>Each folder becomes a top-level folder in your Library. The labels under a folder are the kinds of page the agent files there; the first folder also holds the overview and the index.</li>
              <li>The folders are yours: the agent writes inside them and never adds, renames or removes one. Folders with nothing on your site to put in them can be removed.</li>
              <li>The numbers are part of the names, so the folders read in order, and they follow the order you set here. Rename a folder later and every link to it follows.</li>
              <li>Rebuild the structure, under What changed, brings this step back and moves what the Library holds into the new folders.</li>
            </ul>
          </details>
        </header>

        <section aria-labelledby="library-folders-title" className="flex flex-col gap-3">
          <h3 id="library-folders-title" className={LABEL}>Your folders · {groups.length}</h3>
          <ol className="flex flex-col gap-2">
            {groups.map((group, index) => {
              const match = NUMBERED.exec(group.title);
              const name = match ? match[2] : group.title;
              const filed = [...(index === 0 ? ["overview", "index"] : []), ...group.subjects];
              return (
                <li
                  key={group.key}
                  ref={(element) => {
                    if (element) rows.current.set(group.key, element);
                    else rows.current.delete(group.key);
                  }}
                  className={cn(
                    "flex items-center gap-3 rounded-4xl py-3.5 pl-1.5 pr-2 ring-1 ring-inset ring-orb-white/10 transition-colors hover:bg-orb-raised sm:gap-4 sm:pr-4",
                    dragging === group.key && "bg-orb-raised ring-orb-lime/60",
                  )}
                >
                  <button
                    type="button"
                    aria-label={`Reorder ${name}: drag, or press the up and down arrow keys`}
                    disabled={changing}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.currentTarget.setPointerCapture(event.pointerId);
                      setDragging(group.key);
                    }}
                    onPointerMove={(event) => dragOver(event, group.key)}
                    onPointerUp={() => setDragging(null)}
                    onPointerCancel={() => setDragging(null)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                        event.preventDefault();
                        moveTo(index, index + (event.key === "ArrowUp" ? -1 : 1));
                      }
                    }}
                    className="flex h-11 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-orb-muted outline-none hover:bg-orb-raised hover:text-orb-white focus-visible:ring-3 focus-visible:ring-ring/30 active:cursor-grabbing disabled:opacity-50"
                  >
                    <GripVertical aria-hidden="true" className="size-4" />
                  </button>
                  <FolderGlyph number={match?.[1] ?? null} />
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    {renaming === group.key ? (
                      <input
                        type="text"
                        // A field put there by the reader's own press of Rename or Add a folder.
                        autoFocus
                        aria-label={`Name of folder ${index + 1}`}
                        value={name}
                        maxLength={MAX_GROUP_TITLE - (match ? match[1].length + 1 : 0)}
                        onChange={(event) => rename(index, event.target.value)}
                        // Selected, so typing replaces the name: "New folder" is a placeholder.
                        onFocus={(event) => event.target.select()}
                        onBlur={() => setRenaming(null)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === "Escape") setRenaming(null);
                        }}
                        className="h-9 w-full max-w-sm rounded-3xl border border-orb-lime bg-orb-line/50 px-3 font-display text-lg font-bold tracking-[-0.02em] text-orb-white outline-none ring-3 ring-orb-lime/30"
                      />
                    ) : (
                      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                        <span className="font-display text-lg font-bold tracking-[-0.02em] text-orb-white">{name || "Untitled"}</span>
                        <code className="font-mono text-xs text-orb-muted">/{slugifySegment(group.title) || "…"}</code>
                      </div>
                    )}
                    {filed.length ? (
                      <ul aria-label="Filed here" className="flex flex-wrap gap-1.5">
                        {filed.map((subject) => (
                          <li key={subject} className="inline-flex h-6 items-center whitespace-nowrap rounded-full bg-orb-raised px-2.5 text-xs text-orb-gray ring-1 ring-inset ring-orb-line">
                            {subject}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-orb-muted">{group.summary || "The agent files here whatever fits its name."}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-11 rounded-full text-orb-gray"
                      aria-label={`Rename ${name || "this folder"}`}
                      aria-pressed={renaming === group.key}
                      disabled={changing}
                      onClick={() => setRenaming(renaming === group.key ? null : group.key)}
                    >
                      <Pencil aria-hidden="true" className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-11 rounded-full text-orb-gray"
                      aria-label={`Remove ${name || "this folder"}`}
                      disabled={groups.length === 1 || changing}
                      onClick={() => {
                        change(groups.filter((_group, at) => at !== index));
                        setAnnouncement(`${name || "The folder"} removed.`);
                      }}
                    >
                      <X aria-hidden="true" className="size-4" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
          <p aria-live="polite" className="sr-only">{announcement}</p>
          <button
            type="button"
            onClick={add}
            disabled={groups.length >= MAX_GROUPS || changing}
            className="flex items-center gap-4 rounded-4xl border border-dashed border-orb-line py-3 pl-10 pr-4 text-sm font-medium text-orb-gray outline-none transition-colors hover:bg-orb-raised hover:text-orb-white focus-visible:ring-3 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50"
          >
            <span className="flex h-11 w-16 shrink-0 items-center justify-center rounded-xl border border-dashed border-orb-line">
              <Plus aria-hidden="true" className="size-[1.125rem]" />
            </span>
            {groups.length >= MAX_GROUPS ? `At most ${MAX_GROUPS} folders` : "Add a folder"}
          </button>
        </section>

        {canAsk && askOpen && (
          <section
            id="library-structure-ask"
            aria-labelledby="library-structure-ask-title"
            className="flex flex-col gap-3.5 rounded-3xl bg-orb-raised p-5 shadow-lg ring-1 ring-inset ring-orb-white/10"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full text-orb-lime ring-1 ring-inset ring-orb-lime/60">
                  <MessagesSquare aria-hidden="true" className="size-4" />
                </span>
                <div className="flex flex-col">
                  <h3 id="library-structure-ask-title" className="text-base font-medium text-orb-white">Ask</h3>
                  <span className="text-xs text-orb-gray">Suggest changes to your folders</span>
                </div>
              </div>
              <Button type="button" variant="ghost" size="icon" className="rounded-full text-orb-gray" aria-label="Close Ask" onClick={() => setAskOpen(false)}>
                <X aria-hidden="true" className="size-4" />
              </Button>
            </div>
            <form
              className="flex flex-col gap-3.5"
              onSubmit={(event) => {
                event.preventDefault();
                ask();
              }}
            >
              <label htmlFor="library-structure-ask-input" className="text-sm font-medium text-orb-white">What would you like to change?</label>
              <textarea
                id="library-structure-ask-input"
                // Opened by the reader's own press of Suggest changes, to type into.
                autoFocus
                rows={3}
                value={instruction}
                maxLength={MAX_INSTRUCTION}
                placeholder="e.g. Merge Proof into Offer, and add a Blog folder for articles"
                onChange={(event) => {
                  setInstruction(event.target.value);
                  setAskFailure(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    ask();
                  }
                }}
                className="w-full resize-y rounded-3xl border border-transparent bg-orb-line/50 px-3.5 py-3 text-sm text-orb-white outline-none placeholder:text-orb-muted focus-visible:border-orb-lime focus-visible:ring-3 focus-visible:ring-orb-lime/30"
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs text-orb-muted">Try</span>
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => setInstruction(example)}
                    className="inline-flex h-8 items-center rounded-full px-3 text-xs text-orb-gray outline-none ring-1 ring-inset ring-orb-line transition-colors hover:bg-orb-line/40 hover:text-orb-white focus-visible:ring-3 focus-visible:ring-ring/30"
                  >
                    {example}
                  </button>
                ))}
              </div>
              <AskStatus mine={mine} sending={sending} failure={askFailure} ai={ai} problems={problems} onUndo={before ? () => {
                setDraft(before);
                setBefore(null);
                setAnnouncement("The change was undone.");
              } : null} />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-orb-muted">The agent updates the folders above. Nothing is written until you start.</span>
                <Button type="submit" disabled={!instruction.trim() || changing || problems.length > 0 || busy}>
                  {changing ? <RefreshCw aria-hidden="true" className="size-4 motion-safe:animate-spin" /> : <ArrowUp aria-hidden="true" className="size-4" />}
                  {changing ? "Changing…" : "Send"}
                </Button>
              </div>
            </form>
          </section>
        )}

        <footer className="flex flex-wrap items-center justify-between gap-5 rounded-4xl bg-orb-raised px-6 py-5 ring-1 ring-inset ring-orb-white/10">
          <div className="flex min-w-0 flex-[1_1_18rem] flex-col gap-1">
            <span className="text-sm font-semibold text-orb-white">{plural(groups.length, "folder")}, created as yours</span>
            <span className="text-xs leading-relaxed text-orb-gray">{afterConfirm({ working, ai, startsWithin })}</span>
            {!working && (
              <Button type="button" variant="link" size="xs" className="h-auto w-max px-0 text-xs text-orb-muted hover:text-orb-white" onClick={() => confirm({ start: false })} disabled={disabled}>
                {pending === "save" ? "Saving…" : "Or save without starting"}
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {canAsk && (
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="h-11 px-4"
                aria-expanded={askOpen}
                aria-controls={askOpen ? "library-structure-ask" : undefined}
                onClick={() => setAskOpen((open) => !open)}
              >
                <MessagesSquare aria-hidden="true" className="size-4" /> Suggest changes
              </Button>
            )}
            <Button type="button" size="lg" className="h-11 px-5 font-semibold" onClick={() => confirm({ start: !working })} disabled={disabled}>
              {pending ? "Creating the folders…" : working ? "Use this structure" : "Use this structure and start writing"}
            </Button>
          </div>
        </footer>
        {(failure || problems.length > 0) && (
          <p role="alert" className="-mt-5 text-xs text-orb-coral">{failure ?? problems[0]}</p>
        )}
      </div>
    </section>
  );
}

/** A folder, with its number on the front when it has one. */
function FolderGlyph({ number }) {
  return (
    // Left out at phone width, where the row needs the room; the number is in the path too.
    <div className="relative hidden h-[3.25rem] w-16 shrink-0 sm:block" aria-hidden="true">
      <svg width="64" height="52" viewBox="0 0 56 46" fill="none">
        <path className="fill-orb-line" d="M2 8a4 4 0 0 1 4-4h13.5a3 3 0 0 1 2.3 1.1L25 9h25a4 4 0 0 1 4 4v27a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4Z" />
        <path className="fill-orb-raised stroke-orb-white/15" d="M2 18a4 4 0 0 1 4-4h44a4 4 0 0 1 4 4v22a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4Z" />
      </svg>
      {number && <span className="absolute bottom-[0.4375rem] left-[0.5625rem] font-mono text-compact font-semibold leading-4 text-orb-gray">{number}</span>}
    </div>
  );
}

/**
 * How the change last asked for stands: being made, made (with Undo), or not made and why.
 */
function AskStatus({ mine, sending, failure, ai, problems, onUndo }) {
  if (problems.length) {
    return <p className="text-xs text-orb-muted">Fix the folders above first: {problems[0]}</p>;
  }
  if (failure) return <p role="alert" className="text-xs text-orb-coral">{failure}</p>;
  if (sending || mine?.status === "pending") {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-orb-gray">
        <RefreshCw aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />
        Changing your folders. This takes a few seconds.
      </p>
    );
  }
  if (mine?.status === "ready") {
    return (
      <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-orb-gray">
        <span>{mine.note || "Done: the folders above are updated."}</span>
        {onUndo && (
          <Button type="button" variant="ghost" size="xs" onClick={onUndo}>
            <Undo2 aria-hidden="true" /> Undo
          </Button>
        )}
      </p>
    );
  }
  if (mine?.status === "failed" || mine?.status === "skipped") {
    const noAi = mine.reason?.code === "PROVIDER_NOT_CONFIGURED";
    return (
      <p role="alert" className="text-xs text-orb-coral">
        {noAi
          ? aiUnavailableSentence({ isAdmin: Boolean(ai?.isAdmin), consequence: "the folders cannot be changed in words", after: "Change them by hand above." })
          : `That change could not be made${mine.reason?.message ? `: ${mine.reason.message}` : "."} Try again, or change the folders by hand.`}
      </p>
    );
  }
  return null;
}

/**
 * What happens once the folders are confirmed, said under the count of them.
 */
function afterConfirm({ working, ai, startsWithin }) {
  if (ai?.availability === "unavailable") {
    return aiUnavailableSentence({ isAdmin: ai.isAdmin, consequence: "the agent cannot write into them yet" });
  }
  return working
    ? `The agent starts writing within ${startsWithin}.`
    : `Starting sets the Knowledge base agent to work. It writes the Library within ${startsWithin}, and again whenever your site changes. You can pause it from its icon at the bottom left of the Library.`;
}

/** A list of groups as the editor holds them, each with a key that survives reordering. */
function toDrafts(groups, prefix) {
  return (groups ?? []).map((group, index) => ({
    key: `${prefix}-${index}`,
    title: group.title ?? "",
    summary: group.summary ?? "",
    subjects: group.subjects ?? [],
  }));
}

/** The groups as the API takes them; the first holds the overview and the index. */
function asGroups(groups) {
  return groups.map((group, index) => ({
    title: group.title.trim(),
    summary: group.summary.trim() || undefined,
    subjects: group.subjects,
    ...(index === 0 ? { start: true } : {}),
  }));
}

/**
 * Numbers each numbered folder by where it now is: `00`, `01`, … A folder named without a number
 * keeps its name; the numbers say the order, so they follow it.
 */
function renumber(groups) {
  return groups.map((group, index) => {
    const match = NUMBERED.exec(group.title);
    return match ? { ...group, title: `${String(index).padStart(2, "0")} ${match[2]}` } : group;
  });
}

/** A title without its number. */
function nameOf(title) {
  return NUMBERED.exec(title)?.[2] ?? title;
}

/** "1 folder", "6 folders". */
function plural(count, word) {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

/** What is wrong with the folders as they stand, said before the server has to. */
function groupProblems(groups) {
  const problems = [];
  const seen = new Set();
  if (!groups.length) problems.push("Keep at least one folder.");
  for (const group of groups) {
    const title = group.title.trim();
    const slug = slugifySegment(title);
    if (!nameOf(title).trim()) problems.push("Every folder needs a name.");
    else if (!slug) problems.push(`“${title}” needs at least one letter or digit.`);
    else if (KEPT_NAMES.has(slug)) problems.push(`“${title}” is a name Orbik keeps for a folder it writes itself.`);
    else if (seen.has(slug)) problems.push(`Two folders would both be /${slug}.`);
    else if (title.length > MAX_GROUP_TITLE) problems.push(`“${title}” is longer than ${MAX_GROUP_TITLE} characters.`);
    seen.add(slug);
  }
  return problems;
}
