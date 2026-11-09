"use client";

import {
  Bookmark,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  FilePlus2,
  FileText,
  Files,
  Folder,
  FolderPlus,
  Globe,
  House,
  Library,
  ListTree,
  Lock,
  MoreHorizontal,
  PanelLeft,
  PanelLeftClose,
  Plus,
  Search,
  Square,
  UserPen,
  X,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FolderMenu } from "./LibraryFolder";
import { targetOf, useLibrary } from "./libraryContext";
import { behindLabel, useLibraryFreshness } from "./LibraryFreshness";
import { formatDate } from "@/lib/format";
import { describeRunEvent } from "@/lib/agents/runEvents";
import {
  LIBRARY_LIMITS,
  LIBRARY_ROLES,
  depthOf,
  isFixedFolder,
  isSourcePath,
} from "@/lib/library/library";
import { runHeadline } from "@/lib/library/runActivity";
import { VIEWS } from "@/lib/library/workspaceTabs";
import { cn } from "@/lib/utils";

/** The two files every Library has keep their own icons wherever a rename puts them. */
const ROLE_ICONS = Object.freeze({ [LIBRARY_ROLES.overview]: House, [LIBRARY_ROLES.index]: ListTree });

/** Where a Library from before roles keeps them, so its entry points keep their icons until it is rebuilt. */
const LEGACY_ROLES = Object.freeze({ "/overview": LIBRARY_ROLES.overview, "/index": LIBRARY_ROLES.index });

/** The icon buttons of the explorer's toolbar and its folded strip. */
const ICON_BUTTON = "flex size-7 shrink-0 items-center justify-center rounded-md text-orb-muted transition-colors hover:bg-orb-raised hover:text-orb-white disabled:pointer-events-none disabled:opacity-50 aria-pressed:bg-orb-raised aria-pressed:text-orb-white";

/**
 * The Library's explorer: the folders and files, the bookmarks, and the agent at the foot.
 *
 * The top level is the structure the person chose for this company — `00 Start Here`, `01
 * Company`, `02 Offer` by default — and each is a real folder, opened, renamed, moved, reordered
 * and locked like any other. The folders code writes come after them, below a rule that says so:
 * Sources, a copy of every page of the site, each marked by whether the knowledge base is written
 * from it.
 *
 * A row opens a folder or closes it; a file opens where the click asks — in place, in a new tab
 * with Cmd or Ctrl, or to the right with Shift. A folder's own page, its summary and what is in it,
 * is in its "⋯" menu beside the "+" that makes something inside it. Two markers earn a place on a
 * row: a lock says agents stay out, and a pen says a person has written inside. While a run is in
 * flight a third says what it has done to that file so far.
 *
 * The agent sits at the foot rather than above the files because the Library is the thing and the
 * agent is one of its two writers: what it is doing, the switch that sets it to work, and the two
 * records of what it did — what changed, and which pages it read.
 *
 * @param {object} props
 * @param {"files"|"bookmarks"} props.mode
 * @param {(mode: "files"|"bookmarks") => void} props.onMode
 * @param {() => void} props.onHide folds the explorer to a strip, or closes the drawer it is in
 * @param {Set<string>} props.expanded
 * @param {(path: string) => void} props.onToggle
 * @param {() => void} props.onCollapseAll
 * @param {(path: string) => void} props.onLoadBranch
 * @param {string|null} props.activePath the file on screen, which the tree marks
 * @param {boolean} [props.drawer] drawn in the drawer a phone opens it in rather than as the page's
 *   left column, which is only drawn from `md` up: it fills the drawer, and its last button closes it
 */
export function LibraryExplorer({ mode, onMode, onHide, expanded, onToggle, onCollapseAll, onLoadBranch, activePath, drawer = false }) {
  const library = useLibrary();
  const { tree, busy } = library;
  const top = tree?.children ?? [];
  const chosen = top.filter((node) => !isFixedFolder(node.path));
  const fixed = top.filter((node) => isFixedFolder(node.path));
  const branch = { expanded, onToggle, onLoadBranch, activePath };

  return (
    <nav
      aria-label="Explorer"
      className={drawer ? "flex min-h-0 flex-1 flex-col" : "hidden h-full w-68 shrink-0 flex-col border-r border-orb-line md:flex"}
    >
      <div role="toolbar" aria-label="Explorer" className="flex h-11 shrink-0 items-center gap-0.5 border-b border-orb-line px-2">
        <button type="button" aria-pressed={mode === "files"} aria-label="Files" title="Files" onClick={() => onMode("files")} className={ICON_BUTTON}>
          <Files aria-hidden="true" className="size-4" />
        </button>
        <button type="button" aria-label="Search or jump to a file (⌘O)" title="Search or jump to… ⌘O" onClick={library.openSwitcher} className={ICON_BUTTON}>
          <Search aria-hidden="true" className="size-4" />
        </button>
        <button type="button" aria-pressed={mode === "bookmarks"} aria-label="Bookmarks" title="Bookmarks" onClick={() => onMode("bookmarks")} className={ICON_BUTTON}>
          <Bookmark aria-hidden="true" className="size-4" />
        </button>
        <span className="flex-1" />
        {library.canEdit && (
          <>
            <button type="button" aria-label="New file" title="New file" disabled={busy} onClick={() => library.startCreate("file")} className={ICON_BUTTON}>
              <FilePlus2 aria-hidden="true" className="size-4" />
            </button>
            <button type="button" aria-label="New folder" title="New folder" disabled={busy} onClick={() => library.startCreate("folder")} className={ICON_BUTTON}>
              <FolderPlus aria-hidden="true" className="size-4" />
            </button>
          </>
        )}
        <button type="button" aria-label="Collapse all folders" title="Collapse all" onClick={onCollapseAll} className={ICON_BUTTON}>
          <ChevronsDownUp aria-hidden="true" className="size-4" />
        </button>
        {drawer ? (
          <button type="button" aria-label="Close the explorer" title="Close" onClick={onHide} className={ICON_BUTTON}>
            <X aria-hidden="true" className="size-4" />
          </button>
        ) : (
          <button type="button" aria-label="Hide the explorer" title="Hide the explorer" onClick={onHide} className={ICON_BUTTON}>
            <PanelLeftClose aria-hidden="true" className="size-4" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {mode === "bookmarks" ? (
          <Bookmarks activePath={activePath} />
        ) : (
          <div className="flex flex-col gap-px">
            {chosen.length ? (
              <Branch nodes={chosen} depth={0} {...branch} />
            ) : (
              <p className="px-2 py-1 text-xs text-orb-muted">No folders yet.</p>
            )}
            {fixed.length > 0 && (
              <div role="separator" className="mx-2 mt-2.5 mb-1.5 h-px bg-orb-line" />
            )}
            {fixed.length > 0 && <Branch nodes={fixed} depth={0} {...branch} />}
            {fixed.some((node) => node.path === "/sources" && expanded.has("/sources")) && <SourceLegend />}
          </div>
        )}
      </div>

      <AgentStrip />
    </nav>
  );
}

/**
 * The explorer folded to a strip: the way back to it, and to search, in the width of an icon.
 *
 * Folded so a file and the page beside it get the width — the reading this page is for.
 */
export function LibraryExplorerStrip({ onShow }) {
  const library = useLibrary();
  return (
    <div role="toolbar" aria-label="Explorer" aria-orientation="vertical" className="hidden w-11 shrink-0 flex-col items-center gap-1 border-r border-orb-line pt-2 md:flex">
      <button type="button" aria-label="Show the explorer" title="Show the explorer" onClick={() => onShow()} className={ICON_BUTTON}>
        <PanelLeft aria-hidden="true" className="size-4" />
      </button>
      <button type="button" aria-label="Files" title="Files" onClick={() => onShow("files")} className={ICON_BUTTON}>
        <Files aria-hidden="true" className="size-4" />
      </button>
      <button type="button" aria-label="Search or jump to a file (⌘O)" title="Search or jump to… ⌘O" onClick={library.openSwitcher} className={ICON_BUTTON}>
        <Search aria-hidden="true" className="size-4" />
      </button>
      <button type="button" aria-label="Bookmarks" title="Bookmarks" onClick={() => onShow("bookmarks")} className={ICON_BUTTON}>
        <Bookmark aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}

/** One level of the tree, and the levels it has open beneath it. */
function Branch({ nodes, depth, expanded, onToggle, onLoadBranch, activePath }) {
  return nodes.map((node) => {
    const isFolder = node.kind === "folder";
    const isOpen = isFolder && expanded.has(node.path);
    return (
      <div key={node.path} className="flex flex-col gap-px">
        <Row node={node} depth={depth} expanded={isOpen} active={node.path === activePath} onToggle={onToggle} />
        {isOpen && (
          <>
            <Branch
              nodes={node.children ?? []}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onLoadBranch={onLoadBranch}
              activePath={activePath}
            />
            <Elided node={node} depth={depth} onLoadBranch={onLoadBranch} />
            <SourcePages node={node} depth={depth} activePath={activePath} />
            {!node.children?.length && !node.elided && !node.sourcePages?.total && (
              <p className="flex h-7 items-center text-compact text-orb-muted" style={{ paddingLeft: `${indentOf(depth + 1) + 20}px` }}>
                Empty
              </p>
            )}
          </>
        )}
      </div>
    );
  });
}

/**
 * What is inside a folder that the first read of the tree could not fit: a button that fetches
 * exactly that branch, or, once fetched and still too long, where the rest are found.
 */
function Elided({ node, depth, onLoadBranch }) {
  const branch = node.branch ?? null;
  if (!node.elided) return null;
  const padding = { paddingLeft: `${indentOf(depth + 1) + 20}px` };

  if (branch?.error) return <p className="flex h-7 items-center text-compact text-orb-coral" style={padding}>{branch.error}</p>;
  if (branch?.loading) return <p className="flex h-7 items-center text-compact text-orb-muted" style={padding}>Loading…</p>;
  if (branch?.children) {
    return (
      <p className="flex min-h-7 items-center py-1 text-compact text-orb-muted" style={padding}>
        {node.elided.toLocaleString()} more here. Search finds them.
      </p>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onLoadBranch?.(node.path)}
      className="flex h-7 w-full items-center text-left text-compact text-orb-muted transition-colors hover:text-orb-cyan"
      style={padding}
    >
      Show {node.elided.toLocaleString()} more
    </button>
  );
}

/**
 * The pages of the site a folder shows beneath its own files: the pages its listing links to,
 * shown by reference with a globe, because none of them lives here — each is a copy under Sources.
 */
function SourcePages({ node, depth, activePath }) {
  const library = useLibrary();
  const pages = node.sourcePages?.pages ?? [];
  if (!pages.length) return null;
  const more = (node.sourcePages.total ?? pages.length) - pages.length;
  return (
    <>
      {pages.map((page) => (
        <Row key={`${node.path}→${page.path}`} node={page} depth={depth + 1} reference active={page.path === activePath} />
      ))}
      {more > 0 && (
        <button
          type="button"
          onClick={(event) => library.open(node.path, event)}
          className="flex h-7 w-full items-center text-left text-compact text-orb-muted transition-colors hover:text-orb-cyan"
          style={{ paddingLeft: `${indentOf(depth + 1) + 20}px` }}
        >
          {more.toLocaleString()} more in this folder
        </button>
      )}
    </>
  );
}

/**
 * One row: a folder that opens and closes, or a file that opens.
 *
 * A copy of a page under Sources shows a dot rather than an icon: filled when the knowledge base
 * is written from it, hollow when it is stored and left out — the one fact about a copy somebody
 * scanning the list wants. A page a folder shows by reference keeps its globe.
 */
function Row({ node, depth = 0, reference = false, expanded = false, active = false, onToggle }) {
  const library = useLibrary();
  const isFolder = node.kind === "folder";
  const copy = !isFolder && !reference && isSourcePath(node.path);
  const RoleIcon = ROLE_ICONS[node.role ?? LEGACY_ROLES[node.path]];
  const title = node.title || node.name;
  const count = isFolder ? (node.children?.length ?? 0) + (node.elided ?? 0) + (node.sourcePages?.total ?? 0) : 0;
  const activity = library.activity?.get(node.path);
  const dirty = Object.values(library.drafts).some((draft) => draft?.dirty && draft.path === node.path);
  const behind = useLibraryFreshness().byPath.get(node.path) ?? null;
  const actions = isFolder;
  const top = isFolder && depth === 0;

  // Hover, keyboard focus and an open menu all reveal a folder's buttons, so the "+" is reachable
  // without a mouse and stays put while its menu is open.
  const reveal = "group-hover/row:opacity-100 group-focus-within/row:opacity-100 group-has-[[data-popup-open]]/row:opacity-100";
  const conceal = actions ? "group-hover/row:invisible group-focus-within/row:invisible group-has-[[data-popup-open]]/row:invisible" : "";

  function press(event) {
    if (isFolder) onToggle(node.path);
    else library.open(node.path, event);
  }

  return (
    <div
      className={cn(
        "group/row relative flex h-7 items-center rounded-md text-compact transition-colors",
        active
          ? "bg-orb-raised text-orb-white"
          : top
            ? "font-medium text-orb-white hover:bg-orb-raised/60"
            : "text-orb-gray hover:bg-orb-raised/60 hover:text-orb-white",
      )}
      // The summary is a hover hint on the row rather than on its button: as the button's `title` it
      // would become the button's accessible name, and a screen reader would read a paragraph.
      title={reference
        ? `A page of the site, stored in Sources${node.summary ? `: ${node.summary}` : ""}`
        : copy
          ? `${node.chosen ? "The knowledge base is written from this page" : "Stored, left out of the writing"}${node.url ? ` · ${node.url}` : ""}`
          : node.summary || undefined}
    >
      <button
        type="button"
        onClick={press}
        onAuxClick={(event) => { if (!isFolder && event.button === 1) library.open(node.path, event); }}
        aria-expanded={isFolder ? expanded : undefined}
        aria-current={active ? "page" : undefined}
        className="flex h-7 min-w-0 flex-1 items-center gap-1.5 pr-2 text-left"
        style={{ paddingLeft: `${indentOf(depth)}px` }}
      >
        <span aria-hidden="true" className="flex w-3.5 shrink-0 justify-center text-orb-muted">
          {isFolder && (expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />)}
        </span>
        <span aria-hidden="true" className={cn("flex w-4 shrink-0 justify-center", reference ? "text-orb-cyan" : active ? "text-orb-white" : "text-orb-muted")}>
          {copy ? (
            <span className={cn("size-[7px] rounded-full", node.chosen ? "bg-orb-gray" : "border-[1.5px] border-orb-muted")} />
          ) : reference ? (
            <Globe className="size-[15px]" />
          ) : RoleIcon ? (
            <RoleIcon className="size-[15px]" />
          ) : isFolder ? (
            <Folder className="size-[15px]" />
          ) : (
            <FileText className="size-[15px]" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {copy && <span className="sr-only">{node.chosen ? ", used for the knowledge base" : ", left out of the knowledge base"}</span>}
        {activity && <span className={cn("shrink-0 text-2xs font-normal whitespace-nowrap", activity.tone)}>{activity.label}</span>}
        {dirty && <span aria-label="Unsaved changes" className="size-1.5 shrink-0 rounded-full bg-orb-white" />}
        {behind && !isFolder && (
          <span role="img" aria-label={`Behind the site: ${behindLabel(behind)}`} title={`Behind the site: ${behindLabel(behind)}`} className="size-1.5 shrink-0 rounded-full bg-orb-orange" />
        )}
        {node.locked && <Lock aria-label="Locked: agents stay out" className="size-3 shrink-0 text-orb-gray" />}
        {node.hasUserContent && !isFolder && <UserPen aria-label="Has your writing" className="size-3 shrink-0 text-orb-gray" />}
        {isFolder && !expanded && count > 0 && (
          <span className={cn("shrink-0 text-2xs font-normal tabular-nums text-orb-muted", conceal)}>{count.toLocaleString()}</span>
        )}
      </button>
      {actions && (
        <span className={cn("absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 transition-opacity", reveal)}>
          {library.canEdit && !isFixedFolder(node.path) && !isSourcePath(node.path) && <NewInFolder node={node} />}
          {/* For somebody who may only read, the menu keeps its one way to the folder's page and
              offers nothing that changes it — as it does for the folders code writes. */}
          <FolderMenu
            node={node}
            busy={library.busy}
            withLock={library.canEdit}
            fixed={!library.canEdit || isFixedFolder(node.path) || isSourcePath(node.path)}
            onOpenFolder={(target, event) => library.open(target.path, event)}
            onEdit={(target) => library.editNode(target.path)}
            onMove={library.move}
            onDelete={library.remove}
            onToggleLock={library.toggleLock}
            onReorder={library.reorder}
            canReorder={library.canReorder}
            trigger={
              <button
                type="button"
                aria-label={`More for ${title}`}
                disabled={library.busy}
                className="flex size-6 items-center justify-center rounded-md text-orb-gray hover:bg-orb-line hover:text-orb-white data-popup-open:bg-orb-line data-popup-open:text-orb-white"
              >
                <MoreHorizontal aria-hidden="true" className="size-3.5" />
              </button>
            }
          />
        </span>
      )}
    </div>
  );
}

/** The "+" on a folder: a file or a subfolder inside it, or a folder at the top level. */
function NewInFolder({ node }) {
  const library = useLibrary();
  const title = node.title || node.name;
  const full = depthOf(node.path) >= LIBRARY_LIMITS.depth;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={`New in ${title}`}
            disabled={library.busy}
            className="flex size-6 items-center justify-center rounded-md bg-orb-line text-orb-white hover:bg-orb-line/80"
          >
            <Plus aria-hidden="true" className="size-3.5" />
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-57">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-2.5 pt-1.5 pb-1 text-2xs font-medium uppercase tracking-[0.12em] text-orb-muted">
            In {title}
          </DropdownMenuLabel>
          <DropdownMenuItem disabled={full} onClick={() => library.startCreate("file", node.path)}>
            <FilePlus2 aria-hidden="true" className="text-orb-gray" /> New file
          </DropdownMenuItem>
          <DropdownMenuItem disabled={full} onClick={() => library.startCreate("folder", node.path)}>
            <FolderPlus aria-hidden="true" className="text-orb-gray" /> New subfolder
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-orb-gray" onClick={() => library.startCreate("folder", "/")}>
          <Folder aria-hidden="true" /> New folder at top level
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * How far in a row sits: a step of fourteen pixels a level, with the chevron's column kept on
 * files too, so a glance down the list reads as one column of names with the hierarchy in the gutter.
 */
function indentOf(depth) {
  return 6 + depth * 14;
}

/** What the two dots under Sources mean, said once below them. */
function SourceLegend() {
  return (
    <div className="mx-2 mt-3 flex flex-col gap-1.5 rounded-lg border border-orb-line px-3 py-2.5 text-xs text-orb-muted">
      <span className="flex items-center gap-2">
        <span aria-hidden="true" className="size-[7px] shrink-0 rounded-full bg-orb-gray" />
        the knowledge base is written from it
      </span>
      <span className="flex items-center gap-2">
        <span aria-hidden="true" className="size-[7px] shrink-0 rounded-full border-[1.5px] border-orb-muted" />
        stored, left out of the writing
      </span>
    </div>
  );
}

/**
 * The files somebody bookmarked in this workspace, kept in this browser.
 *
 * A short list of the handful of files a person returns to, which in a Library of a few hundred
 * is otherwise a search every time.
 */
function Bookmarks({ activePath }) {
  const library = useLibrary();
  if (!library.bookmarks.length) {
    return (
      <p className="px-2.5 py-1 text-compact leading-snug text-orb-muted">
        No bookmarks yet. Bookmark a file from the “⋯” at the top of it, and it is kept here, in this browser.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-px">
      {library.bookmarks.map((entry) => {
        const node = library.index.get(entry.path);
        const Icon = isSourcePath(entry.path) ? Globe : node?.kind === "folder" ? Folder : FileText;
        return (
          <li key={entry.path} className={cn("group/row flex h-7 items-center rounded-md pr-1 text-compact", entry.path === activePath ? "bg-orb-raised text-orb-white" : "text-orb-gray hover:bg-orb-raised/60 hover:text-orb-white")}>
            <button type="button" onClick={(event) => library.open(entry.path, event)} className="flex h-7 min-w-0 flex-1 items-center gap-2 pl-2 text-left">
              <Icon aria-hidden="true" className={cn("size-[15px] shrink-0", isSourcePath(entry.path) ? "text-orb-cyan" : "text-orb-muted")} />
              <span className="truncate">{library.labelOf(entry.path)}</span>
            </button>
            <button
              type="button"
              aria-label={`Remove the bookmark on ${library.labelOf(entry.path)}`}
              onClick={() => library.toggleBookmark(entry.path)}
              className="flex size-6 items-center justify-center rounded-md text-orb-muted opacity-0 transition-opacity group-hover/row:opacity-100 hover:text-orb-white focus-visible:opacity-100"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** How a run's state reads in the strip's one line. */
const STATUS_LABELS = Object.freeze({
  queued: "queued",
  running: "working now",
  succeeded: "idle",
  failed: "last run failed",
  cancelled: "last run stopped",
});

/**
 * The agent, at the foot of the explorer: what it is doing, the switch that sets it to work, and
 * the two records of what it did.
 *
 * There is no Run now. Nobody starts this agent: it reads each page your crawl brings back and
 * rewrites the Library when what those pages say has changed, so a button would only ever start a
 * run with nothing new to read. What a person decides is whether it works at all, which is the
 * switch — and while a run is in flight, Stop sits beside it: ending this run and switching the
 * agent off are different things.
 */
function AgentStrip() {
  const library = useLibrary();
  const { work, phases, state } = library;
  const { run, inFlight, working } = work;
  const ready = (state?.readiness?.markdownPages ?? 0) > 0;
  const waiting = Boolean(state?.structure?.needsChoice);
  const status = inFlight ? (STATUS_LABELS[run?.status] ?? "working now") : run ? STATUS_LABELS[run.status] ?? "idle" : "not run yet";
  const failed = !inFlight && run?.status === "failed";
  const last = work.setup?.lastRunAt ?? run?.finishedAt ?? run?.startedAt;
  const line = inFlight
    ? runHeadline(phases) ?? (work.events.length ? describeRunEvent(work.events.at(-1)) : "Starting…")
    : !ready
      ? "Crawl your site first"
      : waiting
        ? "Waiting for you to choose its folders"
        : [status, last ? `wrote ${formatDate(last)}` : null, working ? null : "paused"].filter(Boolean).join(" · ");
  const switchLabel = working
    ? "The agent is set to work: it rewrites the Library whenever a crawl finds a change. Press to pause it."
    : "The agent is paused: your site is still crawled, the Library is left as it is. Press to set it to work.";

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-orb-line px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "relative flex size-7 shrink-0 items-center justify-center rounded-full border-[1.5px]",
            inFlight ? "border-orb-lime/60 text-orb-lime" : "border-orb-line text-orb-gray",
          )}
        >
          <Library aria-hidden="true" className="size-3.5" />
          {inFlight && (
            <span aria-hidden="true" className="pointer-events-none absolute -inset-px rounded-full motion-safe:animate-[orbik-orbit_6s_linear_infinite]">
              <span className="absolute -top-[3px] left-[11px] size-1.5 rounded-full bg-orb-lime" />
            </span>
          )}
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-compact font-medium text-orb-white">Knowledge base agent</p>
          <p role="status" className={cn("truncate text-xs", inFlight ? "text-orb-lime" : failed ? "text-orb-coral" : "text-orb-muted")}>
            {line}
          </p>
        </div>
        {library.canEdit && <button
          type="button"
          role="switch"
          aria-checked={working}
          aria-label={switchLabel}
          title={switchLabel}
          onClick={work.toggleWorking}
          disabled={work.busy || !ready}
          className={cn(
            "relative h-5 w-[34px] shrink-0 rounded-full transition-colors disabled:opacity-50",
            working ? "bg-orb-lime" : "bg-orb-line",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "absolute top-0.5 size-4 rounded-full transition-all",
              working ? "right-0.5 bg-orb-black" : "left-0.5 bg-orb-gray",
            )}
          />
        </button>}
      </div>
      <div className="flex gap-1.5">
        {inFlight ? (
          <>
            <StripButton pressed={library.inspector.run} onClick={() => library.inspector.setRun((value) => !value)}>This run</StripButton>
            {library.canEdit && (
              <StripButton onClick={work.stop} disabled={work.busy || run?.cancelRequested}>
                <Square aria-hidden="true" className="size-3" /> {run?.cancelRequested ? "Stopping…" : "Stop"}
              </StripButton>
            )}
          </>
        ) : (
          <>
            <StripButton onClick={(event) => library.openView(VIEWS.changes, event)}>What changed</StripButton>
            <StripButton onClick={(event) => library.openView(VIEWS.ledger, event)}>Source ledger</StripButton>
          </>
        )}
      </div>
    </div>
  );
}

/** One of the agent strip's two pill buttons. */
function StripButton({ pressed, children, ...props }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className="inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-full border border-orb-line text-xs font-medium text-orb-white transition-colors hover:bg-orb-raised disabled:opacity-50 aria-pressed:bg-orb-raised"
      {...props}
    >
      {children}
    </button>
  );
}
