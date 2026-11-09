"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, FileText, Folder } from "lucide-react";

import { getCrawlTree } from "@/lib/api/crawl";
import { describeFrequency } from "@/lib/crawl/format";
import { cn } from "@/lib/utils";

/** Children fetched per branch, and per press of "show more". */
const PAGE_SIZE = 20;

/**
 * The columns, in order. One per property, so a row reads across like a ledger line and the
 * same fact is always in the same place: a broken count under "Broken" on every row, never a
 * chip that appears on some rows and not others.
 */
const COLUMNS = Object.freeze([
  // The path has no width: in a fixed layout it takes whatever the numbered columns leave, and
  // a path longer than that is cut with an ellipsis rather than pushing the numbers off the
  // table. Every other column is sized for its widest plausible value.
  { key: "path", label: "Path", align: "left", width: null },
  { key: "pages", label: "Pages", align: "right", width: "4.5rem" },
  { key: "status", label: "Status", align: "right", width: "4.5rem" },
  { key: "broken", label: "Broken", align: "right", width: "4.5rem" },
  { key: "noindex", label: "Noindex", align: "right", width: "4.75rem" },
  { key: "orphan", label: "Orphan", align: "right", width: "4.5rem" },
  { key: "uncrawled", label: "Not crawled", align: "right", width: "6rem" },
  { key: "recrawl", label: "Recrawl", align: "left", width: "7rem" },
]);

/**
 * Shows a site the way its owner thinks about it: as a tree of routes, laid out as a table.
 *
 * A tree, because a site's structure is the thing its owner already has a mental model of, and
 * "is anything under /docs broken" is answered by a folder row, not by scanning URLs. A table,
 * because every row carries the same eight facts and a person comparing two folders wants the
 * numbers under each other, not in a ribbon of badges of varying length.
 *
 * The only colour is on a problem. Zero is drawn as a quiet dash so the eye skips it; a count
 * above zero in the broken, noindex, or orphan column is the one thing on the row that is
 * coloured, and "Manual" under recrawl is the other — the row nobody has chosen a frequency for.
 *
 * Every branch is fetched when it is opened and never before. That is what keeps a fifty-thousand
 * URL site openable: the browser holds the dozen nodes somebody has actually looked at, and "show
 * more" is a request rather than a slice of an array nobody should have downloaded.
 *
 * With a `selection`, the same table becomes a picker: a checkbox column appears, rows toggle
 * instead of opening a panel, and choosing a folder chooses everything under it. The tree is
 * shared rather than duplicated so the picker shows exactly what the page list shows.
 *
 * @param {object} props
 * @param {string} props.workspaceId workspace whose crawl is shown
 * @param {string|null} [props.selectedHash] page whose detail panel is open, highlighted in the tree
 * @param {(urlHash: string) => void} [props.onSelect] opens a page's detail panel
 * @param {{hashes: Set<string>, paths: Set<string>}} [props.selection] chosen pages and folders;
 *   its presence turns the tree into a picker
 * @param {(target: {kind: "page", urlHash: string} | {kind: "folder", path: string}) => void}
 *   [props.onToggle] adds or removes one row from the selection
 * @param {string|number} [props.refreshKey] change it to reload every open branch
 * @param {boolean} [props.embedded] omit the section heading, for use inside a panel
 */
export function CrawlTree({
  workspaceId,
  selectedHash = null,
  onSelect,
  selection,
  onToggle,
  refreshKey = 0,
  embedded = false,
}) {
  const selectable = Boolean(selection && onToggle);
  const allSelected = selectable && selection.paths.has("/");

  return (
    <section aria-labelledby="crawl-tree-heading" className={cn(embedded ? "" : "p-6")}>
      {!embedded && (
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 id="crawl-tree-heading" className="font-display text-lg font-bold text-orb-white">Pages</h2>
          <p className="text-xs text-orb-muted">Grouped by path. Duplicate URLs are folded into the page they duplicate.</p>
        </div>
      )}

      {/*
        The table scrolls sideways inside its own frame on a narrow screen rather than squeezing
        eight columns into three hundred pixels; the page itself never scrolls sideways. Vertically
        it grows to whatever it holds and the page scrolls around it, because a second scrollbar
        inside the first made opening a branch move rows inside a box a third the height of the
        screen while the rest sat still.
      */}
      <div className={cn("overflow-x-auto rounded-xl border border-orb-line", !embedded && "mt-4")}>
        <table role="treegrid" aria-label={embedded ? "Pages" : undefined} aria-labelledby={embedded ? undefined : "crawl-tree-heading"} className="w-full min-w-[52rem] table-fixed border-collapse text-sm">
          <colgroup>
            {selectable && <col style={{ width: "2.25rem" }} />}
            {COLUMNS.map((column) => <col key={column.key} style={column.width ? { width: column.width } : undefined} />)}
          </colgroup>
          <thead>
            <tr className="border-b border-orb-line bg-orb-raised/40 text-xs text-orb-muted">
              {selectable && (
                <th scope="col" className="w-8 pl-3 pr-1 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select every page"
                    checked={allSelected}
                    onChange={() => onToggle({ kind: "folder", path: "/" })}
                    className="size-3.5 accent-orb-lime"
                  />
                </th>
              )}
              {COLUMNS.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cn(
                    "whitespace-nowrap px-3 py-2 font-medium",
                    column.align === "right" ? "text-right" : "text-left",
                    column.key === "path" && !selectable && "pl-4",
                  )}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody key={refreshKey}>
            <Branch
              workspaceId={workspaceId}
              path="/"
              depth={0}
              open
              selectedHash={selectedHash}
              onSelect={onSelect}
              selection={selectable ? selection : null}
              onToggle={onToggle}
              inherited={allSelected}
            />
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Loads and renders the rows of one path: its own page, then its children.
 *
 * Kept as its own component so each branch owns its own loading, paging and failure state. A
 * single reducer over the whole tree would make expanding one node a re-render of every other,
 * and would put an error opening `/blog` in front of somebody looking at `/docs`.
 *
 * Renders table rows straight into the shared body — not a nested table — so every level shares
 * one set of columns and the numbers stay aligned however deep the tree goes.
 */
function Branch({ workspaceId, path, depth, open, selectedHash, onSelect, selection, onToggle, inherited }) {
  const [state, setState] = useState({ page: null, children: [], total: 0, loading: true, failed: false });
  const [loadedTo, setLoadedTo] = useState(0);

  /** Applies one page of children, appending so "show more" extends rather than redraws. */
  const receive = useCallback((result, skip) => {
    setState((current) => ({
      page: skip === 0 ? result.page ?? null : current.page,
      children: skip === 0 ? result.children : [...current.children, ...result.children],
      total: result.total,
      loading: false,
      failed: false,
    }));
    setLoadedTo(skip + result.children.length);
  }, []);

  // The first page is loaded when the branch opens. Nothing is set synchronously here: the
  // starting state is already "loading", so the effect only starts the request and lets the
  // response update state, rather than re-rendering once on the way in.
  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    getCrawlTree(workspaceId, { path, limit: PAGE_SIZE, skip: 0 })
      .then((result) => { if (active) receive(result, 0); })
      .catch(() => { if (active) setState((current) => ({ ...current, loading: false, failed: true })); });
    return () => { active = false; };
  }, [open, path, receive, workspaceId]);

  /** Loads the next page, or retries the first after a failure. */
  function loadMore(skip) {
    setState((current) => ({ ...current, loading: true, failed: false }));
    getCrawlTree(workspaceId, { path, limit: PAGE_SIZE, skip })
      .then((result) => receive(result, skip))
      .catch(() => setState((current) => ({ ...current, loading: false, failed: true })));
  }

  if (!open) return null;

  const columns = COLUMNS.length + (selection ? 1 : 0);

  if (state.failed) {
    return (
      <NoteRow depth={depth} columns={columns} tone="coral">
        This branch could not be loaded.{" "}
        <button type="button" className="underline underline-offset-2" onClick={() => loadMore(0)}>Try again</button>
      </NoteRow>
    );
  }

  if (state.loading && !state.children.length) {
    return <NoteRow depth={depth} columns={columns}>Loading…</NoteRow>;
  }

  if (!state.children.length && !state.page) {
    return <NoteRow depth={depth} columns={columns}>{depth === 0 ? "No pages have been discovered yet." : "Nothing below this."}</NoteRow>;
  }

  const remaining = state.total - loadedTo;
  const rowProps = { parentPath: path, depth, selectedHash, onSelect, selection, onToggle, inherited, workspaceId };

  return (
    <>
      {/* The page that lives at this path itself — the homepage at the root, `/blog` inside the
          blog folder. It is nobody's child, so without this row it would have nowhere to be. */}
      {state.page && <Node key={`${path}#self`} child={indexRow(path, state.page)} {...rowProps} />}
      {state.children.map((child) => (
        <Node key={`${path}/${child.segment}`} child={child} {...rowProps} />
      ))}

      {remaining > 0 && (
        <NoteRow depth={depth} columns={columns}>
          <button
            type="button"
            disabled={state.loading}
            onClick={() => loadMore(loadedTo)}
            className="rounded-md px-1.5 py-0.5 text-sm text-orb-cyan hover:bg-orb-raised disabled:opacity-60"
          >
            {state.loading ? "Loading…" : `Show ${remaining.toLocaleString()} more`}
          </button>
        </NoteRow>
      )}
    </>
  );
}

/**
 * One row: a page that opens a panel, or a folder that opens a branch. In a picker, a page or a
 * folder that toggles its checkbox instead, with the chevron still opening the branch.
 *
 * The whole row is the target — a person aims at the line, not at the seven-pixel chevron — and
 * the button in the first cell is the same action for the keyboard, so there is one thing to
 * press whichever way somebody arrives.
 */
function Node({ child, parentPath, depth, selectedHash, onSelect, selection, onToggle, inherited, workspaceId }) {
  const [open, setOpen] = useState(false);
  const isFolder = child.kind === "folder";
  const path = child.label ?? (parentPath === "/" ? `/${child.segment}` : `${parentPath}/${child.segment}`);
  const highlighted = Boolean(!selection && child.urlHash && child.urlHash === selectedHash);

  const own = selection ? (isFolder ? selection.paths.has(path) : selection.hashes.has(child.urlHash)) : false;
  const checked = inherited || own;
  const target = isFolder ? { kind: "folder", path } : { kind: "page", urlHash: child.urlHash };

  /** What clicking the row does: toggles in a picker, expands a folder, or opens a page. */
  function activate() {
    if (selection) {
      if (!inherited) onToggle(target);
      return;
    }
    if (isFolder) setOpen((value) => !value);
    else onSelect?.(child.urlHash);
  }

  return (
    <>
      <tr
        role="row"
        aria-level={depth + 1}
        aria-expanded={isFolder ? open : undefined}
        aria-selected={selection ? checked : highlighted}
        onClick={activate}
        className={cn(
          "cursor-pointer border-t border-orb-line/50 transition-colors",
          "hover:bg-orb-raised/70",
          (highlighted || (selection && own)) && "bg-orb-raised",
          selection && inherited && "bg-orb-raised/50",
          open && !highlighted && !own && "bg-orb-raised/30",
        )}
      >
        {selection && (
          <td role="gridcell" className="pl-3 pr-1 py-1.5">
            <input
              type="checkbox"
              aria-label={`Select ${path}`}
              checked={checked}
              disabled={inherited}
              title={inherited ? "Selected with its folder" : undefined}
              onChange={() => onToggle(target)}
              onClick={(event) => event.stopPropagation()}
              className="size-3.5 accent-orb-lime disabled:opacity-60"
            />
          </td>
        )}

        {/* Path: the tree lives in this one column. Depth is indentation, kind is the icon, and
            the folder's state is the chevron. Everything to the right is flat. */}
        <td role="gridcell" className={cn("min-w-0 overflow-hidden py-1.5 pr-3", highlighted ? "border-l-2 border-l-orb-lime" : "border-l-2 border-l-transparent")}>
          <div style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }} className="flex w-full min-w-0 items-center gap-2">
            {isFolder ? (
              <button
                type="button"
                aria-label={`${open ? "Collapse" : "Expand"} ${path}`}
                aria-expanded={open}
                onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
                className="grid size-5 shrink-0 place-items-center rounded-sm text-orb-muted hover:text-orb-white focus-visible:outline-2 focus-visible:outline-orb-lime"
              >
                <ChevronRight aria-hidden="true" className={cn("size-3.5 transition-transform", open && "rotate-90")} />
              </button>
            ) : (
              <span aria-hidden="true" className="size-5 shrink-0" />
            )}
            {isFolder
              ? <Folder aria-hidden="true" className="size-3.5 shrink-0 text-orb-muted" />
              : <FileText aria-hidden="true" className="size-3.5 shrink-0 text-orb-muted" />}
            <button
              type="button"
              aria-label={isFolder ? `${child.segment || path}, ${child.pages} pages` : path}
              title={path}
              onClick={(event) => { event.stopPropagation(); activate(); }}
              className={cn(
                "min-w-0 flex-1 truncate rounded-sm text-left font-mono text-[0.8rem] focus-visible:outline-2 focus-visible:outline-orb-lime focus-visible:outline-offset-2",
                child.pattern?.includes("[") ? "text-orb-cyan" : "text-orb-white",
              )}
            >
              {path}
            </button>
            {child.role && (
              <span className="shrink-0 rounded-sm bg-orb-raised px-1 py-px font-mono text-[0.6rem] text-orb-muted" title={child.role === "home" ? "The site's homepage" : "The page at this folder's own path"}>
                {child.role}
              </span>
            )}
          </div>
        </td>

        <Count value={isFolder ? child.pages : null} tone="plain" />
        <StatusCell child={child} />
        <Count value={child.broken} tone="coral" />
        <Count value={child.notIndexable} tone="orange" />
        <Count value={child.orphans} tone="orange" />
        <Count value={child.uncrawled} tone="plain" />
        <RecrawlCell child={child} />
      </tr>

      {isFolder && (
        <Branch
          workspaceId={workspaceId}
          path={path}
          depth={depth + 1}
          open={open}
          selectedHash={selectedHash}
          onSelect={onSelect}
          selection={selection}
          onToggle={onToggle}
          inherited={checked}
        />
      )}
    </>
  );
}

/**
 * A number in a column, or a dash where there is nothing to count.
 *
 * Zero is not printed. A column of zeros is noise that hides the one row with a two in it; a
 * column of dashes with one coloured number in it is a finding. Null means the column does not
 * apply — a page has no page count — and is drawn the same way.
 */
function Count({ value, tone }) {
  const show = Number.isInteger(value) && value > 0;
  return (
    <td role="gridcell" className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-[0.8rem] tabular-nums">
      {show
        ? <span className={cn(tone === "coral" && "text-orb-coral", tone === "orange" && "text-orb-orange", tone === "plain" && "text-orb-gray")}>{value.toLocaleString()}</span>
        : <Dash />}
    </td>
  );
}

/**
 * The HTTP status a page came back with; for a folder, the worst status under it, and only when
 * that is worth knowing. "Everything under /docs is 200" is what the dash already says.
 */
function StatusCell({ child }) {
  const isFolder = child.kind === "folder";
  const status = child.worstStatus;
  const show = status !== null && status !== undefined && (!isFolder || status >= 400);
  return (
    <td role="gridcell" className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-[0.8rem] tabular-nums">
      {show
        ? <span className={cn(status >= 400 ? "text-orb-coral" : "text-orb-gray")} title={isFolder ? "Worst status under this folder" : undefined}>{status}</span>
        : <Dash />}
    </td>
  );
}

/**
 * How often this is recrawled, where there is one answer: a page, or a folder whose pages all
 * share one route. "Manual" is coloured because it is the row nobody has chosen for yet, and a
 * page on manual trigger is fetched only when somebody asks. A folder spanning several routes has
 * no single answer, and says so quietly.
 */
function RecrawlCell({ child }) {
  const hours = child.intervalHours;
  return (
    <td role="gridcell" className="whitespace-nowrap px-3 py-1.5 text-left text-xs">
      {hours === undefined
        ? <span className="text-orb-muted">{child.kind === "folder" ? "varies" : ""}</span>
        : hours === null
          ? <span className="text-orb-orange" title="Crawled only when you ask">Manual</span>
          : <span className="text-orb-gray">{describeFrequency(hours)}</span>}
    </td>
  );
}

/** A full-width row for a branch's loading, failure, empty, and show-more states. */
function NoteRow({ depth, columns, tone, children }) {
  return (
    <tr className="border-t border-orb-line/50">
      <td colSpan={columns} style={{ paddingLeft: `${depth * 1.25 + 2.1}rem` }} className={cn("py-1.5 pr-3 text-sm", tone === "coral" ? "text-orb-coral" : "text-orb-muted")}>
        {children}
      </td>
    </tr>
  );
}

function Dash() {
  return <span aria-hidden="true" className="text-orb-line">–</span>;
}

/**
 * Shapes a path's own page as a row, in the same vocabulary as its children.
 *
 * Labelled with the full path rather than a segment, because its segment is its parent's: the
 * row for `/blog` inside the `/blog` folder has to say which of the two it is. The homepage is
 * the one page whose path is nothing at all, so it is named for what it is.
 */
function indexRow(path, page) {
  const home = path === "/";
  return {
    segment: "",
    label: home ? "/" : path,
    role: home ? "home" : "index",
    kind: "page",
    pattern: page.routePattern,
    intervalHours: page.intervalHours,
    pages: 1,
    broken: page.status >= 400 ? 1 : 0,
    notIndexable: page.indexable ? 0 : 1,
    orphans: page.orphan ? 1 : 0,
    uncrawled: page.uncrawled ? 1 : 0,
    worstStatus: page.status ?? null,
    urlHash: page.urlHash,
    url: page.url,
  };
}
