/**
 * The Library page's tabs and panes, as data.
 *
 * The page is a workspace in the sense a code editor or a notes app is one: files open in tabs, a
 * tab remembers where it has been so Back and Forward work inside it, and a second pane opens to
 * the right so a note can be read beside the page it was written from. All of that is state the
 * page owns and nothing the server needs to know, so it is kept here as plain values and pure
 * functions — every change returns a new layout — and the component only decides when to call
 * them.
 *
 * A tab shows one *location*: a Library node by path, or one of the page's own views — the source
 * ledger, what the last run changed, the structure step — or nothing yet. Locations are what is
 * remembered, per workspace, in the browser: reopening the Library puts back the tabs somebody
 * left, which is the whole point of tabs. It is a convenience and nothing more; storage that is
 * missing, full or refused leaves the page opening on the overview as it always did.
 */

/**
 * The event that opens the Library's quick switcher from outside the page: the shell's search
 * button, which sits above the page and holds none of its state.
 */
export const LIBRARY_SWITCHER_EVENT = "orbik:library-switcher";

/** What a tab can show. */
export const VIEWS = Object.freeze({
  node: "node",
  ledger: "ledger",
  changes: "changes",
  structure: "structure",
  empty: "empty",
});

/** At most two panes: a file, and what it is read beside. */
const MAX_PANES = 2;

/** How many closed tabs "Reopen closed tabs" can bring back. */
const MAX_CLOSED = 12;

/** How far back one tab remembers. */
const MAX_HISTORY = 40;

/** How many recently opened files the quick switcher offers before anything is typed. */
const MAX_RECENT = 12;

/** A short identifier for a tab or a pane, unique within one page. */
function makeId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

/** A location showing one Library node. */
export function nodeLocation(path) {
  return { view: VIEWS.node, path };
}

/** Whether two locations show the same thing. */
export function sameLocation(left, right) {
  if (!left || !right || left.view !== right.view) return false;
  return left.view !== VIEWS.node || left.path === right.path;
}

/** What a tab is showing now. */
export function locationOf(tab) {
  return tab?.history?.[tab.at] ?? { view: VIEWS.empty };
}

/** A new tab, showing one location. */
function makeTab(location) {
  return { id: makeId("tab"), history: [location], at: 0, editing: false };
}

/** A new pane, holding the tabs given. */
function makePane(tabs = []) {
  return { id: makeId("pane"), tabs, active: tabs[0]?.id ?? null };
}

/** A layout of one pane with one tab showing `location`, or no tab at all. */
export function initialLayout(location = null) {
  const pane = makePane(location ? [makeTab(location)] : []);
  return { panes: [pane], focus: pane.id, closed: [] };
}

/** The pane that has focus: where "open" opens. */
export function focusedPane(layout) {
  return layout.panes.find((pane) => pane.id === layout.focus) ?? layout.panes[0];
}

/** The tab a pane is showing. */
export function activeTab(pane) {
  return pane?.tabs.find((tab) => tab.id === pane.active) ?? null;
}

/** What the focused pane is showing: the location the URL and the status bar describe. */
export function activeLocation(layout) {
  return locationOf(activeTab(focusedPane(layout)));
}

/** Replaces one pane, by id. */
function withPane(layout, paneId, change) {
  return { ...layout, panes: layout.panes.map((pane) => (pane.id === paneId ? change(pane) : pane)) };
}

/** Replaces one tab of one pane, by id. */
function withTab(pane, tabId, change) {
  return { ...pane, tabs: pane.tabs.map((tab) => (tab.id === tabId ? change(tab) : tab)) };
}

/** Moves a tab to a new location, keeping where it has been so Back can return there. */
function navigate(tab, location) {
  if (sameLocation(locationOf(tab), location)) return tab;
  const history = [...tab.history.slice(0, tab.at + 1), location].slice(-MAX_HISTORY);
  return { ...tab, history, at: history.length - 1, editing: false };
}

/**
 * Opens a location.
 *
 * - `current`, the default: in the tab the focused pane is showing, which remembers where it was;
 *   in a new tab when the pane has none.
 * - `tab`: in a new tab beside it — or the tab already showing it, which is brought forward
 *   rather than duplicated.
 * - `right`: in the second pane, made if there is none, so what was open stays in view beside it.
 */
export function openLocation(layout, location, { target = "current" } = {}) {
  if (target === "right") return openRight(layout, location);
  const pane = focusedPane(layout);
  const current = activeTab(pane);

  if (target === "current" && current) {
    return withPane(layout, pane.id, (each) => withTab(each, current.id, (tab) => navigate(tab, location)));
  }
  const existing = pane.tabs.find((tab) => sameLocation(locationOf(tab), location));
  if (existing) return withPane(layout, pane.id, (each) => ({ ...each, active: existing.id }));
  const tab = makeTab(location);
  const at = current ? pane.tabs.findIndex((each) => each.id === current.id) + 1 : pane.tabs.length;
  return withPane(layout, pane.id, (each) => ({
    ...each,
    tabs: [...each.tabs.slice(0, at), tab, ...each.tabs.slice(at)],
    active: tab.id,
  }));
}

/** Opens a location in the second pane, making it when there is only one. */
function openRight(layout, location) {
  if (layout.panes.length < MAX_PANES) {
    const pane = makePane([makeTab(location)]);
    return { ...layout, panes: [...layout.panes, pane], focus: pane.id };
  }
  const right = layout.panes[layout.panes.length - 1];
  const existing = right.tabs.find((tab) => sameLocation(locationOf(tab), location));
  if (existing) {
    return { ...withPane(layout, right.id, (pane) => ({ ...pane, active: existing.id })), focus: right.id };
  }
  const tab = makeTab(location);
  return {
    ...withPane(layout, right.id, (pane) => ({ ...pane, tabs: [...pane.tabs, tab], active: tab.id })),
    focus: right.id,
  };
}

/** Brings one tab forward and gives its pane focus. */
export function activateTab(layout, paneId, tabId) {
  return { ...withPane(layout, paneId, (pane) => ({ ...pane, active: tabId })), focus: paneId };
}

/** Gives a pane focus without changing what it shows. */
export function focusPane(layout, paneId) {
  return layout.focus === paneId ? layout : { ...layout, focus: paneId };
}

/** Steps one tab back (`-1`) or forward (`1`) through where it has been. */
export function stepTab(layout, paneId, tabId, by) {
  return withPane(layout, paneId, (pane) => withTab(pane, tabId, (tab) => {
    const at = Math.min(Math.max(tab.at + by, 0), tab.history.length - 1);
    return at === tab.at ? tab : { ...tab, at, editing: false };
  }));
}

/** Whether a tab has somewhere to go back or forward to. */
export function canStep(tab, by) {
  if (!tab) return false;
  const at = tab.at + by;
  return at >= 0 && at < tab.history.length;
}

/** Puts one tab into, or out of, editing. */
export function setEditing(layout, paneId, tabId, editing) {
  return withPane(layout, paneId, (pane) => withTab(pane, tabId, (tab) => ({ ...tab, editing })));
}

/** Adds an empty tab to the focused pane: the "+" on the strip. */
export function addEmptyTab(layout) {
  const pane = focusedPane(layout);
  const tab = makeTab({ view: VIEWS.empty });
  return withPane(layout, pane.id, (each) => ({ ...each, tabs: [...each.tabs, tab], active: tab.id }));
}

/**
 * Closes one tab, remembering what it showed so it can be reopened.
 *
 * The neighbour to its right takes over, as in every tabbed application, or to its left when it
 * was the last. A second pane left with no tabs closes, and the first takes focus again.
 */
export function closeTab(layout, paneId, tabId) {
  const pane = layout.panes.find((each) => each.id === paneId);
  if (!pane) return layout;
  const index = pane.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return layout;
  const shown = locationOf(pane.tabs[index]);
  const tabs = pane.tabs.filter((tab) => tab.id !== tabId);
  const active = pane.active === tabId ? (tabs[index] ?? tabs[index - 1] ?? null)?.id ?? null : pane.active;
  const closed = shown.view === VIEWS.empty ? layout.closed : [shown, ...layout.closed].slice(0, MAX_CLOSED);

  if (!tabs.length && layout.panes.length > 1) {
    const panes = layout.panes.filter((each) => each.id !== paneId);
    return { ...layout, panes, focus: layout.focus === paneId ? panes[0].id : layout.focus, closed };
  }
  return { ...withPane(layout, paneId, (each) => ({ ...each, tabs, active })), closed };
}

/** Closes the second pane, moving none of its tabs: the split's own close. */
export function closePane(layout, paneId) {
  if (layout.panes.length < 2) return layout;
  const pane = layout.panes.find((each) => each.id === paneId);
  const panes = layout.panes.filter((each) => each.id !== paneId);
  const closed = [...(pane?.tabs ?? []).map(locationOf).filter((location) => location.view !== VIEWS.empty), ...layout.closed]
    .slice(0, MAX_CLOSED);
  return { ...layout, panes, focus: panes[0].id, closed };
}

/** Opens again, each in a tab of its own, every tab closed since the page opened. */
export function reopenClosed(layout) {
  return layout.closed.reduceRight(
    (next, location) => openLocation(next, location, { target: "tab" }),
    { ...layout, closed: [] },
  );
}

/**
 * Rewrites every location a rename moved, and drops every one a deletion removed.
 *
 * `follow(path)` answers a node's new path, or null when it no longer exists. A tab whose current
 * location is gone shows nothing rather than an error; its history keeps the rest.
 */
export function followPaths(layout, follow) {
  const map = (location) => {
    if (location.view !== VIEWS.node) return location;
    const path = follow(location.path);
    return path ? (path === location.path ? location : nodeLocation(path)) : { view: VIEWS.empty };
  };
  return {
    ...layout,
    panes: layout.panes.map((pane) => ({
      ...pane,
      tabs: pane.tabs.map((tab) => ({ ...tab, history: tab.history.map(map) })),
    })),
    closed: layout.closed.map(map).filter((location) => location.view !== VIEWS.empty),
  };
}

/** Whether any tab shows a location; the structure step is opened once, not once per render. */
export function hasLocation(layout, location) {
  return layout.panes.some((pane) => pane.tabs.some((tab) => sameLocation(locationOf(tab), location)));
}

/** Closes every tab showing a location, wherever it is. */
export function closeLocation(layout, location) {
  let next = layout;
  for (const pane of layout.panes) {
    for (const tab of pane.tabs) {
      if (sameLocation(locationOf(tab), location)) next = closeTab(next, pane.id, tab.id);
    }
  }
  return next;
}

// ─── Remembered in the browser ─────────────────────────────────────────────────────────────────

/** Where one workspace's tabs are remembered. */
const layoutKey = (workspaceId) => `orbik.library.tabs.${workspaceId}`;
/** Where one workspace's bookmarks are remembered. */
const bookmarksKey = (workspaceId) => `orbik.library.bookmarks.${workspaceId}`;
/** Where one workspace's recently opened files are remembered. */
const recentKey = (workspaceId) => `orbik.library.recent.${workspaceId}`;

/** Reads a remembered value, or null when there is none or storage is not available. */
function readStored(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Remembers a value; a browser that refuses is ignored. */
function writeStored(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private windows and full storage refuse; the page works the same without it.
  }
}

/** Whether a stored location is one this page can show. */
function validLocation(location) {
  if (!location || typeof location !== "object") return false;
  if (location.view === VIEWS.node) return typeof location.path === "string" && /^(?:\/[a-z0-9-]+)+$/.test(location.path);
  return [VIEWS.ledger, VIEWS.changes, VIEWS.empty].includes(location.view);
}

/**
 * The tabs this workspace was left with, or null.
 *
 * Each tab is brought back at the location it was showing, without the history behind it, and
 * never in editing: a draft is not kept, so an editor opening on the saved file would look as if
 * the draft had been saved.
 */
export function loadLayout(workspaceId) {
  const stored = readStored(layoutKey(workspaceId));
  if (!stored || !Array.isArray(stored.panes)) return null;
  const panes = stored.panes
    .slice(0, MAX_PANES)
    .map((pane) => {
      const tabs = (Array.isArray(pane?.tabs) ? pane.tabs : []).filter(validLocation).map(makeTab);
      return { ...makePane(tabs), active: tabs[Math.min(Math.max(pane.active ?? 0, 0), tabs.length - 1)]?.id ?? null };
    })
    .filter((pane, index) => index === 0 || pane.tabs.length);
  if (!panes.length) return null;
  return { panes, focus: panes[Math.min(stored.focus ?? 0, panes.length - 1)].id, closed: [] };
}

/** Remembers the tabs, as their current locations only. */
export function saveLayout(workspaceId, layout) {
  writeStored(layoutKey(workspaceId), {
    panes: layout.panes.map((pane) => ({
      tabs: pane.tabs.map(locationOf).map((location) => (location.view === VIEWS.structure ? { view: VIEWS.empty } : location)),
      active: Math.max(pane.tabs.findIndex((tab) => tab.id === pane.active), 0),
    })),
    focus: Math.max(layout.panes.findIndex((pane) => pane.id === layout.focus), 0),
  });
}

/** This workspace's bookmarks: `{path, title}`, in the order they were made. */
export function loadBookmarks(workspaceId) {
  const stored = readStored(bookmarksKey(workspaceId));
  return Array.isArray(stored) ? stored.filter((entry) => typeof entry?.path === "string") : [];
}

/** Remembers this workspace's bookmarks. */
export function saveBookmarks(workspaceId, bookmarks) {
  writeStored(bookmarksKey(workspaceId), bookmarks);
}

/** The files opened most recently in this workspace, newest first. */
export function loadRecent(workspaceId) {
  const stored = readStored(recentKey(workspaceId));
  return Array.isArray(stored) ? stored.filter((entry) => typeof entry?.path === "string") : [];
}

/** Records one file as just opened, and returns the list as it now is. */
export function rememberRecent(workspaceId, entry) {
  const recent = [entry, ...loadRecent(workspaceId).filter((each) => each.path !== entry.path)].slice(0, MAX_RECENT);
  writeStored(recentKey(workspaceId), recent);
  return recent;
}
