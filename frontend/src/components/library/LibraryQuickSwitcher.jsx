"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ChevronRight, CornerDownLeft, FileText, Folder, Globe, MessagesSquare, Search, TerminalSquare } from "lucide-react";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { TabIcon } from "./LibraryPaneParts";
import { targetOf, useLibrary } from "./libraryContext";
import { useAskPanel } from "@/lib/ask/askPanel";
import { searchLibrary, searchLibraryPassages } from "@/lib/api/library";
import { hostAndPath, isSourcePath } from "@/lib/library/library";
import { VIEWS, activeLocation, loadRecent, nodeLocation } from "@/lib/library/workspaceTabs";
import { cn } from "@/lib/utils";

/** Where a search looks: everywhere, the files written from the site, or the copies of its pages. */
const SCOPES = Object.freeze([
  { value: "all", label: "Everything" },
  { value: "knowledge", label: "Knowledge base" },
  { value: "sources", label: "Sources" },
]);

/** How long typing has to pause before each kind of search is asked for. */
const NAME_DELAY = 150;
const MEANING_DELAY = 450;

/**
 * The quick switcher: the way to any file by its name, and to the passage that answers a question
 * by its meaning.
 *
 * Two searches answer one box, because the two questions people bring to a Library are different.
 * "Where is the pricing file" is answered by names — titles, paths, words in the text — at once,
 * and the Library's own files are matched before anything is asked of the server. "Do we support
 * FIPS 140" is answered by meaning: the same index a person's own AI searches with
 * `content_search`, returning the passages themselves, each opening the file it is in. It is asked
 * only once the typing pauses, since each question is embedded by a model.
 *
 * Enter opens the highlighted result in place, Alt+Enter in a new tab, Shift+Enter to the right;
 * Cmd+Enter takes the question to the ask page. A `>` turns the box into the page's commands.
 *
 * @param {object} props
 * @param {() => void} props.onClose
 */
export function LibraryQuickSwitcher({ onClose }) {
  const library = useLibrary();
  const router = useRouter();
  const askPanel = useAskPanel();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [highlighted, setHighlighted] = useState(0);
  const [names, setNames] = useState({ key: null, matches: [], error: null });
  const [meaning, setMeaning] = useState({ key: null, results: [], error: null });
  const list = useRef(null);

  const term = query.trim();
  const commanding = term.startsWith(">");
  const key = `${scope}:${term}`;
  const recent = useMemo(() => loadRecent(library.workspaceId), [library.workspaceId]);

  // Names, from the server: titles, paths and words in the text, across the source layer too.
  useEffect(() => {
    if (!term || commanding) return undefined;
    const timer = window.setTimeout(async () => {
      try {
        const found = await searchLibrary(library.workspaceId, term, { path: scope === "sources" ? "/sources" : "/", limit: 12 });
        setNames({ key, matches: found.matches ?? [], error: null });
      } catch (failure) {
        setNames({ key, matches: [], error: failure?.message ?? "That search did not work." });
      }
    }, NAME_DELAY);
    return () => window.clearTimeout(timer);
  }, [library.workspaceId, term, scope, key, commanding]);

  // Meaning, from the index: only once there is something to mean.
  useEffect(() => {
    if (term.length < 3 || commanding) return undefined;
    const kinds = scope === "sources" ? ["page"] : scope === "knowledge" ? ["library"] : [];
    const timer = window.setTimeout(async () => {
      try {
        const found = await searchLibraryPassages(library.workspaceId, term, { kinds, limit: 5 });
        setMeaning({ key, results: found.results ?? [], error: null });
      } catch (failure) {
        setMeaning({ key, results: [], error: failure?.message ?? "Search by meaning is not available." });
      }
    }, MEANING_DELAY);
    return () => window.clearTimeout(timer);
  }, [library.workspaceId, term, scope, key, commanding]);

  const files = useMemo(() => {
    if (commanding) return [];
    const inScope = (path) => (scope === "sources" ? isSourcePath(path) : scope === "knowledge" ? !isSourcePath(path) : true);
    if (!term) {
      return recent.filter((entry) => inScope(entry.path) && entry.path !== activePathOf(library.layout)).slice(0, 8).map((entry) => ({ path: entry.path }));
    }
    // The Library's own files the tree already holds, matched as the keys are pressed.
    const lower = term.toLowerCase();
    const local = [];
    for (const node of library.index.values()) {
      if (!inScope(node.path) || isSourcePath(node.path)) continue;
      const title = (node.title || node.name || "").toLowerCase();
      if (title.includes(lower)) local.push({ path: node.path, rank: title.startsWith(lower) ? 0 : 1 });
    }
    local.sort((left, right) => left.rank - right.rank || left.path.localeCompare(right.path));
    const remote = names.key === key ? names.matches.filter((match) => inScope(match.path)) : [];
    const seen = new Set();
    return [...local.slice(0, 6), ...remote.map((match) => ({ path: match.path, match }))]
      .filter((row) => (seen.has(row.path) ? false : seen.add(row.path)))
      .slice(0, 10);
  }, [commanding, term, scope, recent, library.index, library.layout, names, key]);

  const passages = !commanding && term.length >= 3 && meaning.key === key ? meaning.results : [];
  const commands = useMemo(() => (commanding ? commandsFor(library, term.slice(1).trim().toLowerCase()) : []), [commanding, library, term]);

  // Everything that can be chosen, in the order it is shown, for the arrow keys.
  const rows = commanding
    ? commands.map((command) => ({ kind: "command", command }))
    : [
      ...files.map((file) => ({ kind: "file", file })),
      ...passages.map((passage) => ({ kind: "passage", passage })),
      ...(term ? [{ kind: "ask" }] : []),
    ];
  const current = Math.min(highlighted, Math.max(rows.length - 1, 0));

  useEffect(() => {
    list.current?.querySelector(`[data-row="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  // Asking opens the Ask panel beside the Library with the term in its box, to be read and sent;
  // outside the workspace shell, where there is no panel, it goes to the address that opens one.
  function ask() {
    onClose();
    if (askPanel) askPanel.askAbout(term);
    else router.push(`/workspaces/${library.workspaceId}/ask?q=${encodeURIComponent(term)}`);
  }

  /** Acts on one row: opens it where `how` says, runs it, or asks it. */
  function choose(row, how = "current") {
    if (!row) return;
    if (row.kind === "ask") return ask();
    if (row.kind === "command") {
      onClose();
      return row.command.run();
    }
    const path = row.kind === "file" ? row.file.path : row.passage.path;
    if (!path) {
      if (row.passage?.url) window.open(row.passage.url, "_blank", "noreferrer");
      return onClose();
    }
    onClose();
    library.open(path, how);
  }

  function onKeyDown(event) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const by = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((rows.length ? (current + by + rows.length) % rows.length : 0));
      return;
    }
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if ((event.metaKey || event.ctrlKey) && term && !commanding) return ask();
    choose(rows[current], event.shiftKey ? "right" : event.altKey ? "tab" : "current");
  }

  let index = -1;
  const next = () => { index += 1; return index; };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="top-[10vh] max-h-[78vh] w-[min(42.5rem,calc(100%-2rem))] max-w-none gap-0 rounded-2xl bg-orb-raised p-0"
      >
        <DialogPrimitive.Title className="sr-only">Go to a file, or search the Library</DialogPrimitive.Title>
        <div className="flex min-h-14 flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-orb-line px-4 py-2.5">
          <Search aria-hidden="true" className="size-[18px] shrink-0 text-orb-muted" />
          <label htmlFor="library-switcher" className="sr-only">Search the Library</label>
          <input
            id="library-switcher"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setHighlighted(0); }}
            onKeyDown={onKeyDown}
            placeholder="Go to a file, or ask what the site says…"
            role="combobox"
            aria-expanded="true"
            aria-controls="library-switcher-results"
            aria-activedescendant={rows.length ? `library-switcher-${current}` : undefined}
            className="min-w-40 flex-1 bg-transparent text-base text-orb-white outline-none placeholder:text-orb-muted"
          />
          {!commanding && (
            <div role="group" aria-label="Where to look" className="flex gap-1">
              {SCOPES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={scope === option.value}
                  onClick={() => { setScope(option.value); setHighlighted(0); }}
                  className={cn(
                    "h-[26px] rounded-full px-2.5 text-xs font-medium transition-colors",
                    scope === option.value ? "bg-orb-line text-orb-white" : "text-orb-gray hover:text-orb-white",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div ref={list} id="library-switcher-results" role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-2">
          {commanding ? (
            <>
              <GroupLabel>Commands</GroupLabel>
              {commands.length ? commands.map((command) => {
                const at = next();
                return (
                  <Option key={command.label} at={at} current={current} onHover={setHighlighted} onChoose={() => choose(rows[at])}>
                    <TerminalSquare aria-hidden="true" className="size-4 shrink-0 text-orb-muted" />
                    <span className="flex-1">{command.label}</span>
                  </Option>
                );
              }) : <Empty>No command is called that.</Empty>}
            </>
          ) : (
            <>
              <GroupLabel>{term ? "Files" : "Recently opened"}</GroupLabel>
              {files.length ? files.map((file) => {
                const at = next();
                const node = library.index.get(file.path);
                const source = isSourcePath(file.path);
                const title = file.match?.title || node?.title || library.labelOf(file.path);
                return (
                  <Option key={file.path} at={at} current={current} onHover={setHighlighted} onChoose={(event) => choose(rows[at], targetOf(event))}>
                    {source
                      ? <Globe aria-hidden="true" className="size-4 shrink-0 text-orb-cyan" />
                      : node ? <TabIcon location={nodeLocation(file.path)} selected={at === current} className="size-4" />
                        : file.match?.kind === "folder" ? <Folder aria-hidden="true" className="size-4 shrink-0 text-orb-muted" />
                          : <FileText aria-hidden="true" className="size-4 shrink-0 text-orb-muted" />}
                    <span className="min-w-0 flex-1">
                      <Highlighted text={title} term={term} className="block truncate" />
                      <span className={cn("block truncate text-xs", at === current ? "text-orb-white/75" : "text-orb-muted")}>
                        {whereOf(library, file.path, file.match ?? node)}
                      </span>
                    </span>
                    {at === current && <kbd className="rounded-[5px] border border-orb-muted/50 px-1.5 font-sans text-2xs text-orb-gray"><CornerDownLeft aria-hidden="true" className="size-3" /></kbd>}
                  </Option>
                );
              }) : term ? (
                <Empty>{names.key === key ? names.error ?? "No file's name or text matches that." : "Searching…"}</Empty>
              ) : (
                <Empty>Files you open are listed here. Type to search every file and every page of the site.</Empty>
              )}

              {term.length >= 3 && (
                <>
                  <div className="flex items-center gap-2 px-2.5 pt-3.5 pb-1 text-2xs leading-4 font-medium tracking-[0.12em] text-orb-muted uppercase">
                    By meaning
                    <span aria-hidden="true" className="h-px flex-1 bg-orb-line" />
                    <span className="font-normal tracking-normal normal-case">passages that answer it</span>
                  </div>
                  {passages.length ? passages.map((passage) => {
                    const at = next();
                    const page = passage.kind === "page";
                    return (
                      <Option key={`${passage.path ?? passage.url}:${passage.snippet.slice(0, 32)}`} at={at} current={current} onHover={setHighlighted} onChoose={(event) => choose(rows[at], targetOf(event))} tall>
                        {page
                          ? <Globe aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-orb-cyan" />
                          : <TabIcon location={nodeLocation(passage.path ?? "/")} selected={at === current} className="mt-0.5 size-4" />}
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-baseline gap-1.5">
                            <span className="truncate">{page && passage.url ? hostAndPath(passage.url) : passage.title || library.labelOf(passage.path ?? "/")}</span>
                            {passage.headingPath?.length > 0 && (
                              <span className={cn("flex min-w-0 shrink items-center gap-1 truncate text-xs", at === current ? "text-orb-white/75" : "text-orb-muted")}>
                                <ChevronRight aria-hidden="true" className="size-3 shrink-0" />
                                <span className="truncate">{passage.headingPath.at(-1)}</span>
                              </span>
                            )}
                          </span>
                          <Highlighted text={plainSnippet(passage.snippet, passage.headingPath)} term={term} className={cn("mt-0.5 line-clamp-2 text-compact", at === current ? "text-orb-white/80" : "text-orb-gray")} />
                        </span>
                      </Option>
                    );
                  }) : (
                    <Empty>
                      {meaning.key !== key ? "Searching by meaning…" : meaning.error ?? "Nothing in the index answers that. The site may not say it, or the index may not have caught up with a recent crawl."}
                    </Empty>
                  )}
                </>
              )}

              {term && (() => {
                const at = next();
                return (
                  <Option at={at} current={current} onHover={setHighlighted} onChoose={ask} className="mx-1 mt-2.5 border border-dashed border-orb-line">
                    <MessagesSquare aria-hidden="true" className="size-4 shrink-0 text-orb-muted" />
                    <span className="flex-1 text-compact text-orb-gray">Ask “{term}”</span>
                    <kbd className="rounded-[5px] border border-orb-line px-1.5 font-sans text-2xs text-orb-gray">⌘↵</kbd>
                  </Option>
                );
              })()}
            </>
          )}
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-orb-line bg-orb-space px-4 py-2.5 text-xs text-orb-muted">
          <span><Key>↑</Key> <Key>↓</Key> move</span>
          <span><Key>↵</Key> open</span>
          <span><Key>⌥↵</Key> new tab</span>
          <span><Key>⇧↵</Key> open to the right</span>
          <span>Type <Key>&gt;</Key> for commands</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The commands a `>` offers, filtered by what follows it. */
function commandsFor(library, filter) {
  const active = activeLocation(library.layout);
  const path = active.view === VIEWS.node ? active.path : null;
  const all = [
    ...(library.canEdit
      ? [
        { label: "New file", run: () => library.startCreate("file") },
        { label: "New folder", run: () => library.startCreate("folder") },
      ]
      : []),
    { label: "Open the source ledger", run: () => library.openView(VIEWS.ledger) },
    { label: "Show what the last run changed", run: () => library.openView(VIEWS.changes) },
    { label: library.split ? "Close the right pane" : "Split right", run: () => (library.split ? library.closePane(library.layout.panes.at(-1).id) : library.splitRight()) },
    { label: library.inspector.open ? "Hide the inspector" : "Show the inspector", run: library.inspector.toggle },
    { label: "New tab", run: library.addTab },
    ...(library.layout.closed.length ? [{ label: "Reopen closed tabs", run: library.reopenClosed }] : []),
    ...(path ? [{ label: library.isBookmarked(path) ? "Remove the bookmark on this file" : "Bookmark this file", run: () => library.toggleBookmark(path) }] : []),
  ];
  return filter ? all.filter((command) => command.label.toLowerCase().includes(filter)) : all;
}

/** The path the focused pane is showing, which "recently opened" leaves out. */
function activePathOf(layout) {
  const location = activeLocation(layout);
  return location.view === VIEWS.node ? location.path : null;
}

/** Where a result lives, said the way the explorer names it. */
function whereOf(library, path, node) {
  if (isSourcePath(path)) {
    const url = node?.url;
    const parts = ["Sources", "Website", ...path.split("/").slice(3, -1)];
    return `${parts.join(" / ")}${url ? ` · ${hostAndPath(url)}` : ""}${node?.published ? ` · published ${node.published}` : ""}`;
  }
  const crumbs = library.crumbsFor(path).slice(1).map((crumb) => crumb.label);
  return crumbs.length ? crumbs.join(" / ") : "Top level";
}

/** One choosable row of the list. */
function Option({ at, current, onHover, onChoose, tall = false, className, children }) {
  return (
    <div
      id={`library-switcher-${at}`}
      data-row={at}
      role="option"
      aria-selected={at === current}
      tabIndex={-1}
      onMouseMove={() => { if (at !== current) onHover(at); }}
      onClick={onChoose}
      onAuxClick={(event) => { if (event.button === 1) onChoose(event); }}
      className={cn(
        "flex cursor-pointer gap-3 rounded-xl px-2.5 text-sm",
        tall ? "items-start py-2.5" : "items-center py-2",
        at === current ? "bg-orb-line text-orb-white" : "text-orb-white",
        className,
      )}
    >
      {children}
    </div>
  );
}

function GroupLabel({ children }) {
  return <div className="px-2.5 pt-1.5 pb-1 text-2xs leading-4 font-medium tracking-[0.12em] text-orb-muted uppercase">{children}</div>;
}

function Empty({ children }) {
  return <p className="px-2.5 py-2 text-compact text-orb-muted">{children}</p>;
}

function Key({ children }) {
  return <kbd className="rounded-[5px] border border-orb-line px-1.5 font-sans text-2xs text-orb-gray">{children}</kbd>;
}

/**
 * A passage as one line of prose: the heading it is under is already beside its title, and the
 * Markdown around its words — heading marks, links, emphasis, table rules — is not what a reader
 * scanning results wants to read.
 */
function plainSnippet(snippet, headingPath = []) {
  const heading = headingPath.at(-1);
  return String(snippet ?? "")
    .replace(/^#{1,6}\s+(.*)$/m, (line, text) => (text.trim() === heading ? "" : text))
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_match, path, label) => label || path)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:[-*+]|\d+[.)]|>)\s+/gm, "")
    .replace(/[*_`|#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Text with each word of the search set in white, so a reader sees why it matched. */
function Highlighted({ text, term, className }) {
  const words = String(term ?? "").toLowerCase().split(/\s+/).filter((word) => word.length > 2);
  if (!words.length) return <span className={className}>{text}</span>;
  const pattern = new RegExp(`\\b(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return (
    <span className={className}>
      {String(text ?? "").split(pattern).map((part, index) => (
        index % 2 === 1 ? <strong key={index} className="font-semibold text-orb-white">{part}</strong> : part
      ))}
    </span>
  );
}
