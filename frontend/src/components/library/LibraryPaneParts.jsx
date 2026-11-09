"use client";

import {
  ArrowLeft,
  ArrowRight,
  FileText,
  Folder,
  Globe,
  History,
  House,
  LayoutGrid,
  List,
  ListTree,
  Pen,
} from "lucide-react";

import { useEffect } from "react";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { LibraryRunRail } from "./LibraryRunRail";
import { useLibrary } from "./libraryContext";
import { LIBRARY_ROLES, isSourcePath } from "@/lib/library/library";
import { VIEWS, canStep } from "@/lib/library/workspaceTabs";
import { cn } from "@/lib/utils";

/**
 * The parts every view of a pane is built from: the bar above it, the body with the inspector
 * beside it, and the icon a tab shows for it. Kept apart from the pane itself so the views can use
 * them without importing the pane that imports them.
 */

/** The pane's small icon buttons: the strip's, and the view header's. */
export const PANE_ICON_BUTTON = "flex size-7 shrink-0 items-center justify-center rounded-md text-orb-muted transition-colors hover:bg-orb-raised hover:text-orb-white disabled:pointer-events-none disabled:opacity-40 aria-pressed:bg-orb-raised aria-pressed:text-orb-white";

/**
 * The bar above a view: Back and Forward through the tab's own history, where the view sits, and
 * the view's own actions.
 *
 * @param {object} props
 * @param {object} props.pane
 * @param {object} props.tab
 * @param {string|null} [props.path] a node's path, for its breadcrumb
 * @param {string} props.title what the view is called, the breadcrumb's last step
 */
export function ViewHeader({ pane, tab, path = null, title, children }) {
  const library = useLibrary();
  // The workspace, then the folder or two above the node: anything deeper is an ellipsis, so a
  // copy of a page five folders down does not squeeze every step to a sliver of a letter.
  const [root, ...ancestors] = path ? library.crumbsFor(path) : [];
  const crumbs = [
    ...(root && !library.split ? [root] : []),
    ...(ancestors.length > 2 ? [{ path: null, label: "…" }] : []),
    ...ancestors.slice(-2),
  ];

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-orb-line pr-3 pl-2">
      <button
        type="button"
        aria-label="Back"
        title="Back"
        disabled={!canStep(tab, -1)}
        onClick={() => library.stepTab(pane.id, tab.id, -1)}
        className={PANE_ICON_BUTTON}
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
      </button>
      <button
        type="button"
        aria-label="Forward"
        title="Forward"
        disabled={!canStep(tab, 1)}
        onClick={() => library.stepTab(pane.id, tab.id, 1)}
        className={PANE_ICON_BUTTON}
      >
        <ArrowRight aria-hidden="true" className="size-4" />
      </button>
      <nav aria-label="Breadcrumb" className="ml-1 flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-compact whitespace-nowrap text-orb-muted">
        {crumbs.map((crumb) => (
          <span key={crumb.path ?? "elided"} className={cn("shrink-0 items-center gap-1.5", crumb.path === "/" ? "hidden xl:flex" : "flex")}>
            {crumb.path === "/" || !crumb.path ? (
              <span className="max-w-40 truncate">{crumb.label}</span>
            ) : (
              <button type="button" onClick={(event) => library.open(crumb.path, event)} className="max-w-40 truncate hover:text-orb-white">
                {crumb.label}
              </button>
            )}
            <span aria-hidden="true">/</span>
          </span>
        ))}
        <span aria-current="page" className="truncate text-orb-white">{title}</span>
      </nav>
      {children && <div className="flex shrink-0 items-center gap-1">{children}</div>}
    </div>
  );
}

/**
 * A view's body, with the inspector beside it when there is room and somebody wants it.
 *
 * While a run is in flight the focused pane's inspector shows the run instead — what it has
 * looked at, read and written so far — until it ends or is put away from the agent strip. With two
 * panes open neither has an inspector: the second pane is the thing beside the file.
 *
 * Below `md` there is no room beside the file, so the focused pane's inspector is a sheet from the
 * right instead, opened from the tab strip; the body tells the strip whether it has one to open.
 * Choosing anything in the sheet puts it away, since what it does — jump to a heading, open a page,
 * start editing a tag — happens behind it.
 *
 * @param {object} props
 * @param {boolean} props.focused
 * @param {import("react").ReactNode} [props.inspector] the view's own inspector
 */
export function PaneBody({ focused, inspector = null, children }) {
  const library = useLibrary();
  const runRail = focused && library.inspector.run && library.work.inFlight;
  const rail = runRail
    ? <LibraryRunRail work={library.work} phases={library.phases} userPaths={library.userPaths} onOpen={(path) => library.open(path, "tab")} />
    : null;
  const side = library.split ? null : rail ?? (library.inspector.open ? inspector : null);
  const sheet = focused ? rail ?? inspector : null;
  const hasSheet = Boolean(sheet);
  const { setAvailable, setSheet } = library.inspector;

  useEffect(() => {
    if (!hasSheet) return undefined;
    setAvailable(true);
    return () => {
      setAvailable(false);
      setSheet(false);
    };
  }, [hasSheet, setAvailable, setSheet]);

  return (
    <div className="flex min-h-0 flex-1">
      {children}
      {side && <div className="hidden min-h-0 shrink-0 lg:flex">{side}</div>}
      {hasSheet && (
        <Sheet open={library.inspector.sheet} onOpenChange={setSheet}>
          <SheetContent
            side="right"
            className="gap-0 border-orb-line bg-orb-space p-0 pt-12 data-[side=right]:w-[min(20rem,88vw)] md:hidden"
          >
            <SheetTitle className="sr-only">{rail ? "This run" : "Inspector"}</SheetTitle>
            {/* The views' inspectors are drawn as a column with its own width and rule; here they
                fill the sheet instead. */}
            <div
              className="flex min-h-0 flex-1 *:w-full! *:flex-1 *:border-0!"
              onClick={(event) => { if (event.target.closest("button, a")) setSheet(false); }}
            >
              {sheet}
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

/** The icon a tab carries: what kind of thing it shows, and a pen while it is being edited. */
export function TabIcon({ location, editing = false, selected = false, className = "size-3.5" }) {
  const library = useLibrary();
  const tone = selected ? "text-orb-white" : "text-orb-muted";
  if (location.view === VIEWS.ledger) return <List aria-hidden="true" className={cn(className, "shrink-0", tone)} />;
  if (location.view === VIEWS.changes) return <History aria-hidden="true" className={cn(className, "shrink-0", tone)} />;
  if (location.view === VIEWS.structure) return <LayoutGrid aria-hidden="true" className={cn(className, "shrink-0", tone)} />;
  if (location.view !== VIEWS.node) return null;
  if (editing) return <Pen aria-hidden="true" className={cn(className, "shrink-0", tone)} />;
  const node = library.index.get(location.path);
  if (isSourcePath(location.path) && node?.kind !== "folder") return <Globe aria-hidden="true" className={cn(className, "shrink-0 text-orb-cyan")} />;
  const role = node?.role ?? (location.path === library.roles.overviewPath ? LIBRARY_ROLES.overview : location.path === library.roles.indexPath ? LIBRARY_ROLES.index : null);
  const Icon = role === LIBRARY_ROLES.overview ? House : role === LIBRARY_ROLES.index ? ListTree : node?.kind === "folder" ? Folder : FileText;
  return <Icon aria-hidden="true" className={cn(className, "shrink-0", tone)} />;
}
