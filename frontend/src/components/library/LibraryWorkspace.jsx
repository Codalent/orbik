"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { FilePlus2, FolderPlus, Play } from "lucide-react";
import useSWR from "swr";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { LibraryCreateDialog } from "./LibraryCreateDialog";
import { LibraryExplorer, LibraryExplorerStrip } from "./LibraryExplorer";
import { LibraryMoveDialog } from "./LibraryMoveDialog";
import { LibraryPane } from "./LibraryPane";
import { LibraryQuickSwitcher } from "./LibraryQuickSwitcher";
import { LibraryRevisions } from "./LibraryRevisions";
import { LibraryStatusBar } from "./LibraryStatusBar";
import { LibraryContext, targetOf } from "./libraryContext";
import { useAgentWork } from "@/lib/agents/useAgentWork";
import * as api from "@/lib/api/library";
import { includeAgentSource } from "@/lib/api/knowledge";
import { WORKSPACES_PATH } from "@/lib/api/workspaces";
import { formatDate } from "@/lib/format";
import {
  LEGACY_OVERVIEW_PATH,
  LIBRARY_AGENT_SLUG,
  depthOf,
  findInTree,
  hostAndPath,
  indexTree,
  isFixedFolder,
  isSourcePath,
  joinPath,
  parentPathOf,
  slugifySegment,
  writingStatus,
} from "@/lib/library/library";
import { changesOf, runPhases, treeActivity } from "@/lib/library/runActivity";
import * as tabs from "@/lib/library/workspaceTabs";
import { useCan } from "@/lib/workspaces/roles";

/**
 * The Library: a workspace's knowledge as a file browser people and agents share, laid out the way
 * a notes app is — an explorer on the left, files in tabs, and an inspector beside the open one.
 *
 * The page used to show one file at a time between a tree and a rail. That was enough to read a
 * Library and not enough to work in one: checking a sentence against the page it was written from
 * meant losing the sentence, and comparing two files meant remembering one of them. So files open
 * in tabs that remember where they have been, a second pane opens to the right for the page a note
 * cites, and a quick switcher (⌘O) jumps to any file by its name or finds the passage that answers
 * a question by its meaning.
 *
 * Everything that writes is still here and still goes through the same API: a person edits a file
 * block by block and what they write is kept, folders are made, renamed, reordered and locked,
 * History restores. The agent sits at the foot of the explorer as the Library's other writer, and
 * the source ledger — which pages it writes from, and which it left out — is a tab of its own.
 *
 * A phone has room for the file and nothing beside it, and the file is what somebody came to read,
 * so below `md` the page opens on it: the explorer and the inspector each slide in over it as a
 * sheet, from buttons in the tab strip, and go away again once they have opened something.
 *
 * The tabs are remembered per workspace in this browser, and the open file is the page's `?path=`,
 * so a reload, a bookmark or a citation from the ask page lands on a file rather than on the
 * overview.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 */
export function LibraryWorkspace({ workspaceId }) {
  // A `?path=` opens that file. It is how a citation on the ask page reaches the file it names, and
  // it is kept equal to the file on screen, so the address bar always says where somebody is.
  const requestedPath = useSearchParams().get("path");
  // Read from the browser while the page is still loading the Library, so what it paints first is
  // already the tabs somebody left rather than the overview and then their tabs.
  const [layout, setLayout] = useState(() => tabs.loadLayout(workspaceId) ?? tabs.initialLayout());
  const [followed, setFollowed] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [revealed, setRevealed] = useState(null);
  // Branches fetched on demand, keyed by path. Held beside the tree rather than merged into it,
  // because a refresh replaces the tree wholesale on every run write and a splice would be lost
  // each time. Merged at render instead.
  const [branches, setBranches] = useState({});
  const [explorer, setExplorer] = useState({ open: true, mode: "files" });
  // Below `md` the explorer and the inspector are each a sheet over the file rather than a column
  // beside it; these say whether either is open.
  const [explorerSheet, setExplorerSheet] = useState(false);
  const [inspectorSheet, setInspectorSheet] = useState(false);
  const [inspectable, setInspectable] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [runRail, setRunRail] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [bookmarks, setBookmarks] = useState(() => tabs.loadBookmarks(workspaceId));
  // Unsaved edits, by tab: the editor's own state, lifted here so switching tabs does not lose it.
  const [drafts, setDrafts] = useState({});
  const [history, setHistory] = useState(null);
  const [creating, setCreating] = useState(null);
  const [moving, setMoving] = useState(null);
  const [running, setRunning] = useState(false);
  const [actionError, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [seeded, setSeeded] = useState(false);
  // True for the one render after the first read, so whatever is on screen then is not revealed.
  const [starting, setStarting] = useState(false);
  const [structureSeen, setStructureSeen] = useState(null);
  const [confirm, confirmDialog] = useConfirm();

  // The tree and its figures are one cached read, re-read when the tab is looked at again — which
  // is how a file somebody else's AI or another window wrote shows up without a reload. While a
  // structure is being proposed the page looks again every few seconds.
  const libraryRead = useSWR(api.libraryPath(workspaceId), {
    refreshInterval: (latest) => (latest?.structure?.needsChoice && (!latest.structure.suggestion || latest.structure.suggestion.status === "pending") ? 8000 : 0),
  });
  const state = libraryRead.data ?? null;
  const mutateLibrary = libraryRead.mutate;
  const loading = !libraryRead.data && !libraryRead.error;

  /** Re-reads the Library after something wrote to it. */
  const refresh = useCallback(async () => {
    try {
      await mutateLibrary();
    } catch {
      // What was last read stays on screen; the next focus or write reads it again.
    }
  }, [mutateLibrary]);

  const overviewPath = state?.overviewPath ?? LEGACY_OVERVIEW_PATH;
  const structure = state?.structure ?? null;
  const waitingOnStructure = Boolean(structure?.needsChoice);

  // The Library always starts with every folder shut but the first, and — when no tabs were
  // remembered and no file was asked for — the overview. Adjusted during render, as the deep link
  // below is, so nothing is painted open and then shut.
  if (state && !seeded) {
    setSeeded(true);
    setStarting(true);
    setExpanded(new Set(topFolders(state.tree).slice(0, 1)));
    const empty = !layout.panes.some((pane) => pane.tabs.length);
    if (empty && !requestedPath) setLayout((current) => tabs.openLocation(current, tabs.nodeLocation(overviewPath)));
  }

  // Following a citation while the page is already open moves to it — in a tab of its own, so the
  // file somebody was reading is still there behind it.
  if (requestedPath !== followed) {
    setFollowed(requestedPath);
    if (requestedPath && /^(?:\/[a-z0-9-]+)+$/.test(requestedPath)) {
      setLayout((current) => tabs.openLocation(current, tabs.nodeLocation(requestedPath), { target: "tab" }));
    }
  }

  // The structure step opens as a tab whenever the Library starts waiting on a choice — once, so
  // a person who closes it to look around is not dragged back; the alert brings it back.
  const structureKey = waitingOnStructure ? `${structure.reason ?? "choice"}` : null;
  if (state && structureKey !== structureSeen) {
    setStructureSeen(structureKey);
    if (structureKey) {
      setLayout((current) => (tabs.hasLocation(current, { view: tabs.VIEWS.structure })
        ? current
        : tabs.openLocation(current, { view: tabs.VIEWS.structure }, { target: "tab" })));
    }
  }

  const focused = tabs.focusedPane(layout);
  const active = tabs.activeLocation(layout);
  const activePath = active.view === tabs.VIEWS.node ? active.path : null;

  // Whatever is on screen is shown in the tree: opening a file, stepping Back, or choosing a tab
  // opens the folders above it. Not what is on screen when the page starts — a remembered tab, a
  // deep link, the overview — so the starting view stays the first folder open and the rest shut.
  if (starting) {
    setStarting(false);
    setRevealed(activePath);
  } else if (activePath !== revealed) {
    setRevealed(activePath);
    if (activePath && seeded) setExpanded((current) => new Set([...current, ...ancestorsOf(activePath)]));
  }

  // The address bar says which file is on screen. Replaced rather than pushed: Back and Forward
  // belong to the tab, and a browser history of every file opened would make leaving the page a
  // hundred presses of Back.
  useEffect(() => {
    if (!seeded) return;
    const current = new URLSearchParams(window.location.search).get("path");
    if (current === activePath || (!current && !activePath)) return;
    window.history.replaceState(null, "", activePath ? `?path=${activePath}` : window.location.pathname);
  }, [activePath, seeded]);

  useEffect(() => { tabs.saveLayout(workspaceId, layout); }, [workspaceId, layout]);
  useEffect(() => { tabs.saveBookmarks(workspaceId, bookmarks); }, [workspaceId, bookmarks]);
  useEffect(() => { if (activePath) tabs.rememberRecent(workspaceId, { path: activePath }); }, [workspaceId, activePath]);

  // The Library's root is named after the workspace. The list is the one the shell already read,
  // from the same cache, so this asks for nothing.
  const workspaces = useSWR(WORKSPACES_PATH).data;
  const workspaceName = workspaces?.items?.find((workspace) => workspace.id === workspaceId)?.name ?? null;
  const rootLabel = workspaceName ?? "Library";
  // Whether this person may change the Library: member and above. A read-only member reads it
  // all — every file, every copy, every history — with nothing that writes drawn on the page.
  const canEdit = useCan("member", workspaceId);

  const work = useAgentWork({ workspaceId, agentSlug: LIBRARY_AGENT_SLUG, onFinished: refresh });

  // The inspector follows the run: it shows the run while one is in flight, since a person who set
  // the agent to work is waiting to see something happen, and the file's own rail when it is over.
  if (work.inFlight !== running) {
    setRunning(work.inFlight);
    setRunRail(work.inFlight);
  }

  const phases = useMemo(() => runPhases(work.events, { inFlight: work.inFlight }), [work.events, work.inFlight]);
  const activity = useMemo(() => treeActivity({ events: work.events, inFlight: work.inFlight }), [work.events, work.inFlight]);
  const changes = useMemo(() => (work.inFlight ? null : changesOf(work.run)), [work.inFlight, work.run]);

  // Each file a run finishes reloads the tree, so a file the run has just made appears in it and
  // every pane showing one it rewrote reads it again.
  const written = phases.writes.length;
  useEffect(() => {
    if (!work.inFlight || !written) return;
    (async () => { await refresh(); })();
  }, [refresh, work.inFlight, written]);

  const tree = useMemo(() => mergeBranches(state?.tree, branches), [state?.tree, branches]);
  const index = useMemo(() => indexTree(tree), [tree]);
  const roles = useMemo(
    () => ({ overviewPath: state?.overviewPath ?? null, indexPath: state?.indexPath ?? null }),
    [state?.overviewPath, state?.indexPath],
  );
  const userPaths = useMemo(() => pathsWithUserContent(tree), [tree]);
  const dirty = Object.values(drafts).some((draft) => draft?.dirty);

  // A window widened past `md` has the explorer and the inspector beside the file again, so a sheet
  // left open on the narrow layout would only cover them.
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 48rem)");
    const close = () => {
      if (!wide.matches) return;
      setExplorerSheet(false);
      setInspectorSheet(false);
    };
    wide.addEventListener("change", close);
    return () => wide.removeEventListener("change", close);
  }, []);

  // Leaving the page with an unsaved edit asks first: the draft lives only in this tab.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /** Runs one write and reloads everything it could have changed. */
  async function perform(action) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      await refresh();
      return result;
    } catch (failure) {
      setError(failure?.message ?? "That did not work.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  /**
   * Opens a file or folder: in place, in a new tab, or in the pane to the right — from a click,
   * its modifier keys decide. A tab holding an unsaved edit is never navigated away from: what
   * would have replaced it opens in a tab beside it.
   */
  function open(path, how) {
    const requested = typeof how === "string" ? how : targetOf(how);
    const tab = tabs.activeTab(tabs.focusedPane(layout));
    const target = requested === "current" && tab && drafts[tab.id]?.dirty ? "tab" : requested;
    setLayout((current) => tabs.openLocation(current, tabs.nodeLocation(path), { target }));
  }

  /** Opens one of the page's own views — the source ledger, what changed — in a tab. */
  function openView(view, how = "tab") {
    const target = typeof how === "string" ? how : targetOf(how);
    setLayout((current) => tabs.openLocation(current, { view }, { target: target === "current" ? "tab" : target }));
  }

  /** Closes a tab, asking first when it holds an edit that was not saved. */
  async function closeTab(paneId, tabId) {
    const draft = drafts[tabId];
    if (draft?.dirty && !(await confirm({
      title: `Close “${draft.title || draft.path}” without saving your changes?`,
      confirmLabel: "Close without saving",
      destructive: true,
    }))) return;
    setDrafts((current) => without(current, tabId));
    setLayout((current) => tabs.closeTab(current, paneId, tabId));
  }

  /** Puts a tab into editing, or takes it out; leaving drops the draft only when asked to. */
  function setTabEditing(paneId, tabId, editing, { discard = false } = {}) {
    if (discard) setDrafts((current) => without(current, tabId));
    setLayout((current) => tabs.setEditing(current, paneId, tabId, editing));
  }

  /** Keeps a tab's draft, or forgets it when given null. */
  const setDraft = useCallback((tabId, draft) => {
    setDrafts((current) => (draft ? { ...current, [tabId]: draft } : without(current, tabId)));
  }, []);

  function toggle(path) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  /**
   * Fetches the children of a folder the first read had to elide.
   *
   * One folder at a time, on purpose: raising the tree's ceiling until everything fits would make
   * every visit download a mirror of the whole site to render a sidebar.
   */
  async function loadBranch(path) {
    if (branches[path]?.children) return;
    setBranches((current) => ({ ...current, [path]: { loading: true } }));
    try {
      const branch = await api.getLibraryTree(workspaceId, path, { depth: 2 });
      setBranches((current) => ({ ...current, [path]: { children: branch.children ?? [], elided: branch.elided ?? 0 } }));
    } catch (failure) {
      setBranches((current) => ({ ...current, [path]: { error: failure?.message ?? "That branch could not be loaded." } }));
    }
  }

  /**
   * Opens the dialog for a new folder or file. Without a parent it starts in the folder somebody
   * is standing in: the open folder, or the folder of the open file.
   */
  function startCreate(kind, parent) {
    const here = activePath && index.get(activePath)?.kind === "folder" ? activePath : parentPathOf(activePath ?? overviewPath);
    setCreating({ kind, parent: parent ?? (isSourcePath(here) ? "/" : here) });
  }

  /** Whether a path is taken, according to the server rather than the tree the page holds. */
  async function exists(path) {
    try {
      await api.getLibraryNode(workspaceId, path);
      return true;
    } catch (failure) {
      if (failure?.status === 404) return false;
      throw failure;
    }
  }

  /**
   * Makes what the dialog describes, then opens it: a file in a new tab, ready to write in; a
   * folder on its page. Failures are thrown back to the dialog so the message sits beside the form.
   */
  async function createNode({ kind, path, title, summary, locked }) {
    await api.saveLibraryNode(workspaceId, path, {
      kind,
      title,
      summary,
      ...(kind === "file" ? { markdown: "", tags: [], sources: [] } : {}),
    });
    let lockFailure = null;
    if (locked) {
      try {
        await api.setLibraryNodeLocked(workspaceId, path, true);
      } catch (failure) {
        lockFailure = failure;
      }
    }
    setCreating(null);
    await refresh();
    setLayout((current) => {
      const opened = tabs.openLocation(current, tabs.nodeLocation(path), { target: "tab" });
      const pane = tabs.focusedPane(opened);
      return kind === "file" ? tabs.setEditing(opened, pane.id, pane.active, true) : opened;
    });
    if (kind === "folder") setExpanded((current) => new Set([...current, path]));
    if (lockFailure) setError(`The folder was made, but it could not be locked: ${lockFailure.message}`);
  }

  /** Every tab, bookmark and open branch at or under `from` follows it to `to`. */
  function follow(from, to) {
    const moved = (path) => (path === from || path?.startsWith(`${from}/`) ? (to ? to + path.slice(from.length) : null) : path);
    setLayout((current) => tabs.followPaths(current, moved));
    setBookmarks((current) => current.map((entry) => ({ ...entry, path: moved(entry.path) })).filter((entry) => entry.path));
    setExpanded((current) => new Set([...current].map(moved).filter(Boolean)));
    setBranches({});
  }

  /**
   * Renames or moves a node, then follows it: every tab showing it or anything inside it is moved
   * to its new path. Every link to it was rewritten by the same request.
   */
  async function rename(target, { to, title }) {
    await api.moveLibraryNode(workspaceId, target.path, to, { title });
    setMoving(null);
    follow(target.path, to);
    await refresh();
  }

  /** The siblings a node is ordered among, without the fixed folders code writes. */
  function siblingsOf(target) {
    const parent = parentPathOf(target.path);
    const container = parent === "/" ? tree : findInTree(tree, parent);
    return (container?.children ?? []).filter((child) => !isFixedFolder(child.path));
  }

  function canReorder(target, by) {
    const siblings = siblingsOf(target);
    const at = siblings.findIndex((child) => child.path === target.path);
    return at >= 0 && at + by >= 0 && at + by < siblings.length;
  }

  /** Moves a node one place up or down among its siblings, giving every sibling its position. */
  async function reorder(target, by) {
    const siblings = [...siblingsOf(target)];
    const at = siblings.findIndex((child) => child.path === target.path);
    if (at < 0 || at + by < 0 || at + by >= siblings.length) return;
    const [moved] = siblings.splice(at, 1);
    siblings.splice(at + by, 0, moved);
    await perform(async () => {
      for (const [position, child] of siblings.entries()) {
        if (child.order !== position) await api.reorderLibraryNode(workspaceId, child.path, position);
      }
    });
  }

  /**
   * Saves a folder's or a file's new version. A top-level folder's path follows its name, so a
   * new name there is a rename first, links and all, and the rest is saved at the path it now has.
   */
  async function saveNode(target, body) {
    const segment = slugifySegment(body.title);
    const renames = target.kind === "folder" && depthOf(target.path) === 1 && !isFixedFolder(target.path)
      && segment && body.title !== (target.title ?? target.name);
    const to = renames ? joinPath("/", segment) : target.path;
    return perform(async () => {
      if (renames) {
        await api.moveLibraryNode(workspaceId, target.path, to, { title: body.title });
        follow(target.path, to);
      }
      return api.saveLibraryNode(workspaceId, to, body);
    });
  }

  async function chooseStructure(groups) {
    const chosen = await api.chooseLibraryStructure(workspaceId, groups);
    await refresh();
    const start = chosen?.structure?.chosen?.groups?.find((group) => group.start)?.path ?? null;
    setLayout((current) => {
      const closed = tabs.closeLocation(current, { view: tabs.VIEWS.structure });
      return start ? tabs.openLocation(closed, tabs.nodeLocation(start), { target: "tab" }) : closed;
    });
    if (start) setExpanded((current) => new Set([...current, start]));
  }

  async function rebuildStructure() {
    if (!(await confirm({
      title: "Choose the Library's top-level folders again?",
      description: "The agent waits for your choice, then rewrites the Library into it. Locked files and everything you wrote are kept.",
      confirmLabel: "Choose again",
    }))) return;
    await perform(() => api.requestLibraryRebuild(workspaceId));
    setStructureSeen(null);
  }

  async function remove(target) {
    const kind = target.kind === "folder" ? "folder" : "file";
    if (!(await confirm({
      title: `Delete the ${kind} ${target.path}?`,
      description: kind === "file" ? "You can restore it from its history." : null,
      confirmLabel: `Delete ${kind}`,
      destructive: true,
    }))) return;
    const done = await perform(() => api.deleteLibraryNode(workspaceId, target.path));
    if (done !== null) follow(target.path, null);
  }

  function toggleLock(target) {
    return perform(() => api.setLibraryNodeLocked(workspaceId, target.path, !target.locked));
  }

  async function openHistory(target, { latest = false } = {}) {
    try {
      const revisions = await api.listLibraryRevisions(workspaceId, target.path);
      setHistory({
        revisions,
        userBlocks: target.userBlocks ?? [],
        userBlockAuthors: target.userBlockAuthors ?? null,
        initialRevision: latest ? revisions.revisions?.[0]?.revision ?? null : null,
      });
    } catch (failure) {
      setError(failure?.message ?? "That history could not be loaded.");
    }
  }

  /** Asks for the knowledge base to be written from a page it left out, on the agent's next run. */
  async function include(key) {
    await includeAgentSource(workspaceId, LIBRARY_AGENT_SLUG, key);
    await refresh();
  }

  function toggleBookmark(path) {
    setBookmarks((current) => (current.some((entry) => entry.path === path)
      ? current.filter((entry) => entry.path !== path)
      : [...current, { path }]));
  }

  // ⌘O (or Ctrl+O) opens the quick switcher from anywhere on the page; the header's search button,
  // which belongs to the shell, asks for it by event. There is no "/" shortcut: "/" is too common a
  // character to type for it to open anything. ⌘E switches the open file between reading and
  // editing, as it does in the notes apps this page is laid out like.
  const shortcuts = useRef({});
  useEffect(() => {
    shortcuts.current = { layout, index, setTabEditing, canEdit };
  });
  useEffect(() => {
    function onKeyDown(event) {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && !event.shiftKey && !event.altKey && key === "o") {
        event.preventDefault();
        setSwitcherOpen(true);
        return;
      }
      if (mod && !event.shiftKey && !event.altKey && key === "e") {
        const { layout: current, index: known, setTabEditing: edit, canEdit: editable } = shortcuts.current;
        if (!editable) return;
        const pane = tabs.focusedPane(current);
        const tab = tabs.activeTab(pane);
        const location = tabs.locationOf(tab);
        const node = location.view === tabs.VIEWS.node ? known.get(location.path) : null;
        if (!node || node.kind !== "file" || isSourcePath(node.path)) return;
        event.preventDefault();
        edit(pane.id, tab.id, !tab.editing);
      }
    }
    const openSwitcher = () => setSwitcherOpen(true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener(tabs.LIBRARY_SWITCHER_EVENT, openSwitcher);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(tabs.LIBRARY_SWITCHER_EVENT, openSwitcher);
    };
  }, []);

  /** A node's title as the tree knows it, for a link that names it; null when it is not known. */
  const titleOf = useCallback((path) => index.get(path)?.title || null, [index]);

  /** How a tab names what it shows: a copy of a page by its address, everything else by its title. */
  const labelOf = useCallback((path) => {
    const node = index.get(path);
    if (node?.url && isSourcePath(path)) return hostAndPath(node.url);
    return node?.title || node?.name || path.split("/").at(-1);
  }, [index]);

  /** The folders above a node, named as the tree names them, from the workspace down. */
  const crumbsFor = useCallback((path) => {
    const crumbs = [{ path: "/", label: rootLabel }];
    for (const ancestor of ancestorsOf(path)) {
      const found = index.get(ancestor);
      crumbs.push({ path: ancestor, label: found?.title || found?.name || ancestor.split("/").at(-1) });
    }
    return crumbs;
  }, [index, rootLabel]);

  if (loading) return <LibrarySkeleton />;

  const ready = (state?.readiness?.markdownPages ?? 0) > 0;
  const failedRun = state?.latestRun?.status === "failed" ? state.latestRun : null;
  // Empty means nothing at all. A site's pages are copied into Sources as soon as it is crawled,
  // and a page saying "Nothing here yet" over them would hide the one thing that is.
  const empty = Boolean(state) && (state.stats?.nodes ?? 0) === 0 && (state.stats?.sources?.nodes ?? 0) === 0;
  const error = actionError ?? (!state && libraryRead.error ? libraryRead.error.message ?? "The Library could not be loaded." : null);
  const structureOpen = tabs.hasLocation(layout, { view: tabs.VIEWS.structure });

  // Opening something — a file, a view, the switcher or a dialog — from the explorer's or the
  // inspector's sheet puts the sheet away first, so on a phone the file or the dialog is what is in
  // front rather than a sheet over it. From `md` up neither sheet is ever open, and this changes
  // nothing.
  const closingSheets = (action) => (...args) => {
    setExplorerSheet(false);
    setInspectorSheet(false);
    return action(...args);
  };

  // The explorer as both layouts draw it: a column beside the file, or a sheet over it.
  const explorerProps = {
    mode: explorer.mode,
    onMode: (mode) => setExplorer((current) => ({ ...current, mode })),
    expanded,
    onToggle: toggle,
    onCollapseAll: () => setExpanded(new Set()),
    onLoadBranch: loadBranch,
    activePath,
  };

  const library = {
    workspaceId,
    canEdit,
    state,
    tree,
    index,
    roles,
    rootLabel,
    overviewPath,
    busy,
    work,
    phases,
    changes,
    activity,
    userPaths,
    layout,
    split: layout.panes.length > 1,
    drafts,
    bookmarks,
    titleOf,
    labelOf,
    crumbsFor,
    open: closingSheets(open),
    openView: closingSheets(openView),
    openSwitcher: closingSheets(() => setSwitcherOpen(true)),
    closeTab,
    setTabEditing,
    // Opens a node in a tab of its own, already in editing: for a menu outside any tab.
    editNode: closingSheets((path) => setLayout((current) => {
      const opened = tabs.openLocation(current, tabs.nodeLocation(path), { target: "tab" });
      const pane = tabs.focusedPane(opened);
      return tabs.setEditing(opened, pane.id, pane.active, true);
    })),
    setDraft,
    activateTab: (paneId, tabId) => setLayout((current) => tabs.activateTab(current, paneId, tabId)),
    focusPane: (paneId) => setLayout((current) => tabs.focusPane(current, paneId)),
    stepTab: (paneId, tabId, by) => setLayout((current) => tabs.stepTab(current, paneId, tabId, by)),
    addTab: () => setLayout((current) => tabs.addEmptyTab(current)),
    reopenClosed: () => setLayout((current) => tabs.reopenClosed(current)),
    splitRight: () => {
      const location = tabs.activeLocation(layout);
      setLayout((current) => tabs.openLocation(current, location.view === tabs.VIEWS.empty ? { view: tabs.VIEWS.empty } : location, { target: "right" }));
    },
    closePane: (paneId) => setLayout((current) => tabs.closePane(current, paneId)),
    inspector: {
      open: inspectorOpen,
      toggle: () => setInspectorOpen((value) => !value),
      run: runRail,
      setRun: setRunRail,
      // The sheet a phone shows it in, and whether the view in front has anything to show there.
      sheet: inspectorSheet,
      setSheet: setInspectorSheet,
      available: inspectable,
      setAvailable: setInspectable,
    },
    explorerSheet: { open: explorerSheet, show: () => setExplorerSheet(true) },
    startCreate: closingSheets(startCreate),
    move: closingSheets(setMoving),
    remove: closingSheets(remove),
    toggleLock,
    openHistory: closingSheets(openHistory),
    reorder,
    canReorder,
    saveNode,
    chooseStructure,
    suggestStructureAgain: () => perform(() => api.suggestLibraryStructureAgain(workspaceId)),
    rebuildStructure: waitingOnStructure || work.inFlight || !canEdit ? null : rebuildStructure,
    include,
    toggleBookmark,
    isBookmarked: (path) => bookmarks.some((entry) => entry.path === path),
    refresh,
    reportError: setError,
  };

  return (
    <LibraryContext.Provider value={library}>
      <main aria-label="Library" className="flex min-h-0 flex-1 flex-col">
        <h1 className="sr-only">Library</h1>
        {(error || work.error || !ready || failedRun || (waitingOnStructure && !structureOpen)) && (
          <div className="shrink-0 space-y-2 border-b border-orb-line px-4 py-3">
            {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
            {work.error && <Alert variant="destructive" role="alert"><AlertDescription>{work.error}</AlertDescription></Alert>}
            {!ready && (
              <Alert>
                <AlertDescription>
                  The agent reads the Markdown your crawler renders from each page. Crawl your site first,
                  and it will build the Library from what it finds. You can write files yourself meanwhile.
                </AlertDescription>
              </Alert>
            )}
            {waitingOnStructure && !structureOpen && (
              <Alert role="status">
                <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {canEdit
                    ? "The agent is waiting for you to choose how the Library is organised."
                    : "The agent is waiting for a member of this workspace to choose how the Library is organised."}
                  {canEdit && (
                    <Button type="button" size="sm" variant="secondary" onClick={() => openView(tabs.VIEWS.structure)}>
                      Choose the folders
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}
            {/* A failed newest run while the previous run's files are on screen: without this the
                page would present a Library as current when the most recent attempt to update it
                did not finish. */}
            {failedRun && !empty && (
              <Alert role="alert">
                <AlertDescription>
                  The last run failed{failedRun.error?.message ? `: ${failedRun.error.message}` : "."} What is
                  below is from {formatDate(failedRun.startedAt, { time: false })} or earlier.
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}

        {empty ? (
          <EmptyLibrary state={state} ready={ready} busy={busy} work={work} canEdit={canEdit} onCreate={(kind) => startCreate(kind, "/")} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            {explorer.open ? (
              <LibraryExplorer {...explorerProps} onHide={() => setExplorer((current) => ({ ...current, open: false }))} />
            ) : (
              <LibraryExplorerStrip
                onShow={(mode) => setExplorer({ open: true, mode: mode ?? explorer.mode })}
              />
            )}

            <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
              {layout.panes.map((pane, position) => (
                <LibraryPane
                  key={pane.id}
                  pane={pane}
                  position={position}
                  focused={pane.id === focused.id}
                />
              ))}
            </div>
          </div>
        )}

        {/* Below `md` there is no room for the explorer beside the file, so the page opens on the
            file and the explorer — the same one, agent and all — slides in over it from the left,
            from the button at the start of the tab strip. */}
        {!empty && (
          <Sheet open={explorerSheet} onOpenChange={setExplorerSheet}>
            <SheetContent
              side="left"
              showCloseButton={false}
              className="gap-0 border-orb-line bg-orb-space p-0 data-[side=left]:w-[min(20rem,88vw)] md:hidden"
            >
              <SheetTitle className="sr-only">Explorer</SheetTitle>
              <LibraryExplorer {...explorerProps} drawer onHide={() => setExplorerSheet(false)} />
            </SheetContent>
          </Sheet>
        )}

        <LibraryStatusBar activePath={activePath} activeTab={tabs.activeTab(focused)} />

        {switcherOpen && <LibraryQuickSwitcher onClose={() => setSwitcherOpen(false)} />}

        {history && (
          <LibraryRevisions
            revisions={history.revisions}
            initialRevision={history.initialRevision}
            userBlocks={history.userBlocks}
            userBlockAuthors={history.userBlockAuthors}
            busy={busy}
            onClose={() => setHistory(null)}
            onRestore={canEdit ? async (revision) => {
              await perform(() => api.restoreLibraryRevision(workspaceId, history.revisions.path, revision));
              setHistory(null);
            } : null}
          />
        )}

        {moving && canEdit && (
          <LibraryMoveDialog
            node={moving}
            tree={tree}
            rootLabel={rootLabel}
            onMove={(request) => rename(moving, request)}
            onClose={() => setMoving(null)}
          />
        )}

        {confirmDialog}

        {creating && canEdit && (
          <LibraryCreateDialog
            kind={creating.kind}
            parentPath={creating.parent}
            tree={tree}
            rootLabel={rootLabel}
            roles={roles}
            exists={exists}
            onCreate={createNode}
            onClose={() => setCreating(null)}
          />
        )}
      </main>
    </LibraryContext.Provider>
  );
}

/**
 * The Library while its first read is on the way: the explorer's column of folders beside a pane
 * with a tab and a file's title and lines, at the sizes the page draws them, so the page opens
 * in place rather than out of a spinner. Below `md`, where the page opens on the file, only the
 * pane. Only the first read shows it; later reads keep what is on screen.
 */
function LibrarySkeleton() {
  return (
    <main aria-label="Library" className="flex min-h-0 flex-1 flex-col">
      <SkeletonRegion label="Loading the Library" className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="hidden w-68 shrink-0 flex-col border-r border-orb-line md:flex">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-orb-line px-3">
            {[0, 1, 2].map((icon) => <Skeleton key={icon} className="size-5" />)}
          </div>
          <div className="space-y-3 p-3">
            {["w-32", "w-40", "w-28", "w-36", "w-24"].map((width, row) => (
              <div key={row} className={row % 2 ? "flex items-center gap-2 pl-5" : "flex items-center gap-2"}>
                <Skeleton className="size-4 shrink-0" />
                <Skeleton className={`h-3.5 ${width}`} />
              </div>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-end border-b border-orb-line bg-orb-black px-2">
            <Skeleton className="h-9 w-40 rounded-b-none" />
          </div>
          <div className="w-full max-w-3xl space-y-3 px-6 py-8 md:px-10">
            <Skeleton className="h-3 w-48" />
            <Skeleton className="h-7 w-2/3" />
            <div className="space-y-2.5 pt-4">
              {["w-full", "w-11/12", "w-full", "w-4/5", "w-full", "w-3/5"].map((width, line) => (
                <Skeleton key={line} className={`h-3.5 ${width}`} />
              ))}
            </div>
          </div>
        </div>
      </SkeletonRegion>
    </main>
  );
}

/** An object without one key. */
function without(object, key) {
  if (!(key in object)) return object;
  const { [key]: _dropped, ...rest } = object;
  return rest;
}

/**
 * Folds the branches fetched by hand back into the tree the page was served.
 *
 * A pure function over both, rather than a mutation of either: the served tree is replaced on
 * every refresh and the fetched branches outlive it, so the merge has to happen at the moment of
 * rendering or one of the two is always stale.
 */
function mergeBranches(tree, branches) {
  if (!tree || !Object.keys(branches).length) return tree;
  const graft = (node) => {
    const fetched = branches[node.path];
    const children = (fetched?.children ?? node.children ?? []).map(graft);
    return {
      ...node,
      children,
      elided: fetched?.children ? fetched.elided ?? 0 : node.elided ?? 0,
      branch: fetched ?? null,
    };
  };
  return { ...tree, children: (tree.children ?? []).map(graft) };
}

/**
 * A Library with nothing in it yet: the one moment this page has to explain what it is for rather
 * than show it. Both ways in are offered — set the agent to work, or write the first file.
 */
function EmptyLibrary({ state, ready, busy, work, canEdit, onCreate }) {
  const copying = (state?.coverage?.stored ?? 0) > 0 || work.working || work.inFlight;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="max-w-lg text-center">
        <h2 className="font-display text-lg font-bold text-orb-white">Nothing here yet</h2>
        <p className="mt-2 text-sm text-orb-gray">
          {/* A read-only person can do neither thing the copy offers, so they are told what will
              happen rather than what to do. */}
          {!ready
            ? canEdit
              ? "Once your site has been crawled, every page is copied here and the agent writes a Library from the pages your site links to most. You can make folders and files yourself in the meantime."
              : "Once the site has been crawled, every page is copied here and the agent writes a Library from the pages the site links to most."
            : copying
              ? writingStatus({ coverage: state.coverage, working: work.working, inFlight: work.inFlight })
              : canEdit
                ? `Your ${state.readiness.markdownPages.toLocaleString()} rendered pages are being copied into Sources. Set the agent to work and it writes a Library from the pages your site links to most — an overview, an index, and the rest arranged the way you think about the business. You can make a folder yourself in the meantime.`
                : `The site's ${state.readiness.markdownPages.toLocaleString()} rendered pages are being copied into Sources. Once the agent is set to work, it writes a Library from the pages the site links to most.`}
        </p>
        {canEdit && <div className="mt-4 flex justify-center gap-2">
          {ready && !work.working && (
            <Button type="button" size="sm" onClick={work.toggleWorking} disabled={busy || work.busy}>
              <Play aria-hidden="true" className="size-3.5" /> Set the agent to work
            </Button>
          )}
          <Button type="button" variant="secondary" size="sm" onClick={() => onCreate("folder")} disabled={busy}>
            <FolderPlus aria-hidden="true" className="size-3.5" /> New folder
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => onCreate("file")} disabled={busy}>
            <FilePlus2 aria-hidden="true" className="size-3.5" /> New file
          </Button>
        </div>}
      </div>
    </div>
  );
}

/** Every folder a path sits inside: `/customers/case-studies` yields `/customers`. */
export function ancestorsOf(path) {
  if (!path) return [];
  const segments = path.split("/").filter(Boolean);
  return segments.slice(0, -1).map((_segment, index) => `/${segments.slice(0, index + 1).join("/")}`);
}

/**
 * The folders the person chose, in the tree's order; the first of them is what opens by default.
 * Sources is never among them: it is the whole site.
 */
function topFolders(tree) {
  return (tree?.children ?? []).filter((node) => node.kind === "folder" && !isFixedFolder(node.path)).map((node) => node.path);
}

/** Every file in the tree that holds a person's own writing, for the run's "yours kept". */
function pathsWithUserContent(tree) {
  const paths = new Set();
  const walk = (children) => {
    for (const child of children ?? []) {
      if (child.kind === "file" && child.hasUserContent) paths.add(child.path);
      walk(child.children);
    }
  };
  walk(tree?.children);
  return paths;
}
