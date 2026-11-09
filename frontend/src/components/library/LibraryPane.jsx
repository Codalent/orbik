"use client";

import { useEffect, useRef } from "react";
import { Columns2, PanelLeft, PanelRight, Plus, X } from "lucide-react";

import { LibraryRunChanges } from "./LibraryAgentBar";
import { LibraryLedgerView } from "./LibraryLedgerView";
import { LibraryNodeView } from "./LibraryNodeView";
import { PANE_ICON_BUTTON, PaneBody, TabIcon, ViewHeader } from "./LibraryPaneParts";
import { LibraryStructureChoice } from "./LibraryStructureChoice";
import { useLibrary } from "./libraryContext";
import { VIEWS, activeTab, locationOf } from "@/lib/library/workspaceTabs";
import { cn } from "@/lib/utils";

/** How the page's own views are named on a tab. */
const VIEW_LABELS = Object.freeze({
  [VIEWS.ledger]: "Source ledger",
  [VIEWS.changes]: "What changed",
  [VIEWS.structure]: "Choose the folders",
  [VIEWS.empty]: "New tab",
});

/**
 * One pane of the Library: a strip of tabs, and the view of the tab in front.
 *
 * There are one or two. The second is opened to the right — from a "written from" link, a Shift
 * click, or the split button — so a note can be read beside the page it was written from, and it
 * closes when its last tab does. Whichever was used last has focus, which is where the quick
 * switcher and the explorer open things, and the one whose tab the address bar names. Below `md`
 * there is room for one, so only the focused pane is shown.
 *
 * @param {object} props
 * @param {object} props.pane
 * @param {number} props.position 0 for the left pane, 1 for the right
 * @param {boolean} props.focused
 */
export function LibraryPane({ pane, position, focused }) {
  const library = useLibrary();
  const tab = activeTab(pane);
  const location = locationOf(tab);

  return (
    <section
      aria-label={position === 0 ? "Open files" : "Open files, right pane"}
      onMouseDownCapture={() => { if (!focused) library.focusPane(pane.id); }}
      onFocusCapture={() => { if (!focused) library.focusPane(pane.id); }}
      className={cn(
        "min-h-0 min-w-0 flex-1 flex-col",
        focused ? "flex" : "hidden md:flex",
        position > 0 && "md:border-l md:border-orb-line",
      )}
    >
      <TabStrip pane={pane} position={position} focused={focused} />
      {!tab ? (
        <EmptyView pane={pane} tab={null} focused={focused} />
      ) : location.view === VIEWS.node ? (
        // Keyed by the path as well as the tab, so stepping Back mounts the file it lands on rather
        // than carrying the scroll position and state of the one it left.
        <LibraryNodeView key={`${tab.id}:${location.path}`} pane={pane} tab={tab} path={location.path} focused={focused} />
      ) : location.view === VIEWS.ledger ? (
        <LibraryLedgerView key={tab.id} pane={pane} tab={tab} focused={focused} />
      ) : location.view === VIEWS.changes ? (
        <ChangesView pane={pane} tab={tab} focused={focused} />
      ) : location.view === VIEWS.structure ? (
        <StructureView pane={pane} tab={tab} focused={focused} />
      ) : (
        <EmptyView pane={pane} tab={tab} focused={focused} />
      )}
    </section>
  );
}

/**
 * The pane's tabs, and the controls that belong to the pane rather than to a file: a new tab,
 * splitting to the right or closing the second pane, and showing or hiding the inspector. Below
 * `md`, where neither the explorer nor the inspector fits beside the file, it starts with the
 * button that opens the explorer and ends with the one that opens the inspector, each as a sheet.
 */
function TabStrip({ pane, position, focused }) {
  const library = useLibrary();
  const last = position === library.layout.panes.length - 1;

  return (
    <div className="flex h-11 shrink-0 items-end gap-1 border-b border-orb-line bg-orb-black px-2">
      <button
        type="button"
        aria-label="Open the explorer"
        title="Explorer"
        aria-haspopup="dialog"
        aria-expanded={library.explorerSheet.open}
        onClick={library.explorerSheet.show}
        className={cn(PANE_ICON_BUTTON, "mb-1.5 md:hidden")}
      >
        <PanelLeft aria-hidden="true" className="size-4" />
      </button>
      <div
        role="tablist"
        aria-label={position === 0 ? "Open files" : "Open files, right pane"}
        className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {pane.tabs.map((tab) => (
          <Tab key={tab.id} pane={pane} tab={tab} selected={tab.id === pane.active} focused={focused} />
        ))}
        <button
          type="button"
          aria-label="New tab"
          title="New tab"
          onClick={() => { library.focusPane(pane.id); library.addTab(); }}
          className={cn(PANE_ICON_BUTTON, "mb-1.5 ml-1")}
        >
          <Plus aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      <div className="mb-1.5 flex shrink-0 items-center gap-0.5">
        {library.split ? (
          position > 0 && (
            <button type="button" aria-label="Close the right pane" title="Close the right pane" onClick={() => library.closePane(pane.id)} className={PANE_ICON_BUTTON}>
              <X aria-hidden="true" className="size-4" />
            </button>
          )
        ) : (
          <button type="button" aria-label="Split: open this again to the right" title="Split right" onClick={library.splitRight} className={cn(PANE_ICON_BUTTON, "hidden md:flex")}>
            <Columns2 aria-hidden="true" className="size-4" />
          </button>
        )}
        {last && !library.split && (
          <button
            type="button"
            aria-pressed={library.inspector.open}
            aria-label={library.inspector.open ? "Hide the inspector" : "Show the inspector"}
            title={library.inspector.open ? "Hide the inspector" : "Show the inspector"}
            onClick={library.inspector.toggle}
            className={cn(PANE_ICON_BUTTON, "hidden lg:flex")}
          >
            <PanelRight aria-hidden="true" className="size-4" />
          </button>
        )}
        {focused && library.inspector.available && (
          <button
            type="button"
            aria-label="Open the inspector"
            title="Inspector"
            aria-haspopup="dialog"
            aria-expanded={library.inspector.sheet}
            onClick={() => library.inspector.setSheet(true)}
            className={cn(PANE_ICON_BUTTON, "md:hidden")}
          >
            <PanelRight aria-hidden="true" className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}

/** One tab: what it shows, and its close button, which appears on hover and on the tab in front. */
function Tab({ pane, tab, selected, focused }) {
  const library = useLibrary();
  const location = locationOf(tab);
  const label = location.view === VIEWS.node ? library.labelOf(location.path) : VIEW_LABELS[location.view];
  const dirty = Boolean(library.drafts[tab.id]?.dirty);
  const ref = useRef(null);

  // The tab in front is scrolled into the strip when more tabs are open than it shows — on a phone,
  // two or three — so the file on screen always has its tab in sight. Only the strip scrolls.
  useEffect(() => {
    const strip = ref.current?.parentElement;
    if (!selected || !strip) return;
    const own = ref.current.getBoundingClientRect();
    const view = strip.getBoundingClientRect();
    if (own.left < view.left) strip.scrollLeft -= view.left - own.left;
    else if (own.right > view.right) strip.scrollLeft += own.right - view.right;
  }, [selected, label]);

  return (
    <div
      ref={ref}
      className={cn(
        "group/tab flex h-9 max-w-56 min-w-28 shrink-0 items-center gap-1 rounded-t-[9px] pr-1.5 pl-3 text-compact",
        selected
          ? cn("-mb-px h-[37px] bg-orb-space shadow-[inset_1px_0_0_var(--color-orb-line),inset_-1px_0_0_var(--color-orb-line),inset_0_1px_0_var(--color-orb-line)]", focused ? "text-orb-white" : "text-orb-gray")
          : "text-orb-muted hover:text-orb-white",
      )}
      onAuxClick={(event) => { if (event.button === 1) library.closeTab(pane.id, tab.id); }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        onClick={() => library.activateTab(pane.id, tab.id)}
        title={location.view === VIEWS.node ? location.path : label}
        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
      >
        <TabIcon location={location} editing={tab.editing} selected={selected && focused} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {dirty && <span aria-label="Unsaved changes" className="size-1.5 shrink-0 rounded-full bg-orb-white" />}
      </button>
      <button
        type="button"
        aria-label={`Close ${label}`}
        onClick={() => library.closeTab(pane.id, tab.id)}
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-[5px] text-orb-muted hover:bg-orb-raised hover:text-orb-white focus-visible:opacity-100",
          selected ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100",
        )}
      >
        <X aria-hidden="true" className="size-3" />
      </button>
    </div>
  );
}

/**
 * A tab with nothing in it yet: the ways to put something in it.
 *
 * Only the shortcut that works in a browser is offered as one. ⌘N, ⌘T and ⇧⌘T belong to the
 * browser itself, and a page that printed them would be promising something it cannot keep.
 */
function EmptyView({ pane, tab, focused }) {
  const library = useLibrary();
  const closed = library.layout.closed.length;
  return (
    <>
      {tab && <ViewHeader pane={pane} tab={tab} title="New tab" />}
      <PaneBody focused={focused}>
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3.5 p-8 text-orb-gray">
          <h2 className="font-display text-lg font-bold text-orb-white">No file is open</h2>
          <div className="grid grid-cols-[auto_auto] gap-x-5 gap-y-2 text-compact">
            <button type="button" onClick={library.openSwitcher} className="text-left text-orb-white hover:text-orb-cyan">Go to file</button>
            <kbd className="font-sans text-orb-muted">⌘O</kbd>
            {library.canEdit && (
              <>
                <button type="button" onClick={() => library.startCreate("file")} disabled={library.busy} className="text-left text-orb-white hover:text-orb-cyan disabled:opacity-50">New file</button>
                <span />
              </>
            )}
            <button
              type="button"
              onClick={library.reopenClosed}
              disabled={!closed}
              className="text-left text-orb-white hover:text-orb-cyan disabled:text-orb-muted"
            >
              Reopen closed tabs{closed ? ` (${closed})` : ""}
            </button>
            <span />
          </div>
        </div>
      </PaneBody>
    </>
  );
}

/**
 * What the last run did to the Library, file by file, as a tab of its own.
 *
 * Opened from the agent strip. A file it names opens in a tab beside this one, so the list stays
 * where it was for the next.
 */
function ChangesView({ pane, tab, focused }) {
  const library = useLibrary();
  return (
    <>
      <ViewHeader pane={pane} tab={tab} title="What changed" />
      <PaneBody focused={focused}>
        <LibraryRunChanges
          changes={library.changes}
          run={library.work.run}
          onOpen={(path) => library.open(path, "tab")}
          onRebuild={library.rebuildStructure}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-6 md:px-10"
        />
      </PaneBody>
    </>
  );
}

/** The structure step — the Library's top-level folders, chosen by the person — as a tab. */
function StructureView({ pane, tab, focused }) {
  const library = useLibrary();
  const structure = library.state?.structure;
  return (
    <>
      <ViewHeader pane={pane} tab={tab} title="Choose the folders" />
      <PaneBody focused={focused}>
        {structure?.needsChoice && !library.canEdit ? (
          <p className="flex-1 p-8 text-sm text-orb-gray">
            The agent is waiting for a member of this workspace to choose the Library&apos;s top-level folders. Your role
            here is read-only, so the choice is theirs to make.
          </p>
        ) : structure?.needsChoice ? (
          <LibraryStructureChoice
            key={`${structure.reason}:${structure.suggestion?.generatedAt ?? "none"}`}
            structure={structure}
            working={library.work.working}
            busy={library.busy}
            onChoose={library.chooseStructure}
            onSuggestAgain={library.suggestStructureAgain}
          />
        ) : (
          <p className="flex-1 p-8 text-sm text-orb-gray">The Library&apos;s folders have been chosen. Rename, add or move them in the explorer.</p>
        )}
      </PaneBody>
    </>
  );
}
