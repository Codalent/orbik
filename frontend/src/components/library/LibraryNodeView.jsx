"use client";

import { useEffect, useRef, useState } from "react";
import {
  Bookmark,
  BookmarkMinus,
  Columns2,
  Copy,
  ExternalLink,
  FilePlus2,
  FolderPlus,
  History,
  Lock,
  LockOpen,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import useSWR from "swr";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { LibraryBlockEditor, draftBody, startDraft } from "./LibraryBlockEditor";
import { LibraryDocument } from "./LibraryDocument";
import { LibraryFileEditor } from "./LibraryFileEditor";
import { LibraryFolder, LibraryFolderAside, FolderMenu } from "./LibraryFolder";
import { LibraryInspector } from "./LibraryInspector";
import { PANE_ICON_BUTTON, PaneBody, ViewHeader } from "./LibraryPaneParts";
import { useLibrary } from "./libraryContext";
import { libraryNodePath } from "@/lib/api/library";
import { LIBRARY_LIMITS, entryRoleOf, isFixedFolder, isSourcePath, writingStatus } from "@/lib/library/library";
import { cn } from "@/lib/utils";

/**
 * One Library node in a tab: read from the API, and shown as what it is.
 *
 * A folder shows its page — summary, then what is in it. A copy of a page of the site is shown
 * read-only, saying so, with the live page one press away. A file of the knowledge base is read,
 * or edited block by block; the two are the same tab in two states, switched in the header or
 * with ⌘E, because the whole point of the Library is that correcting it is ordinary.
 *
 * The node is cached under its path, so two panes showing one file share one read, and each is
 * read again whenever the tree says something was written — a run rewriting the file on screen
 * replaces it rather than leaving the version from before the run.
 *
 * @param {object} props
 * @param {object} props.pane
 * @param {object} props.tab
 * @param {string} props.path
 * @param {boolean} props.focused
 */
export function LibraryNodeView({ pane, tab, path, focused }) {
  const library = useLibrary();
  const { workspaceId, state, index } = library;
  const listed = index.get(path);
  // The page lands on the overview, and a Library that has only been copied so far has none: that
  // is a Library with nothing written yet, not a file that failed to open.
  const overviewPending = Boolean(state) && path === library.overviewPath && !listed;
  const read = useSWR(overviewPending ? null : libraryNodePath(workspaceId, path));
  const node = read.data?.node ?? null;
  const mutate = read.mutate;

  const stamp = state?.stats?.updatedAt ?? "";
  const lastStamp = useRef(stamp);
  useEffect(() => {
    const previous = lastStamp.current;
    lastStamp.current = stamp;
    if (previous && previous !== stamp) mutate();
  }, [stamp, mutate]);

  const title = node?.title || library.labelOf(path);
  const idPrefix = `${pane.id}-`;

  if (overviewPending) {
    return (
      <>
        <ViewHeader pane={pane} tab={tab} path={path} title="Overview" />
        <PaneBody focused={focused}>
          <div className="flex-1 p-8">
            <div className="max-w-lg">
              <h2 className="font-display text-lg font-bold text-orb-white">The overview has not been written yet</h2>
              <p className="mt-2 text-sm text-orb-gray">
                {writingStatus({ coverage: state.coverage, working: library.work.working, inFlight: library.work.inFlight })}
              </p>
            </div>
          </div>
        </PaneBody>
      </>
    );
  }

  if (!node) {
    return (
      <>
        <ViewHeader pane={pane} tab={tab} path={path} title={title} />
        <PaneBody focused={focused}>
          {read.error ? (
            <div className="flex-1 p-8">
              <h2 className="font-display text-lg font-bold text-orb-white">
                {read.error.status === 404 ? "This file is not in the Library any more" : "This file could not be opened"}
              </h2>
              <p className="mt-2 max-w-lg text-sm text-orb-gray">
                {read.error.status === 404
                  ? `Nothing is stored at ${path}. It may have been moved, renamed or deleted since this tab opened it.`
                  : read.error.message ?? "Try again in a moment."}
              </p>
              <Button type="button" variant="secondary" size="sm" className="mt-4" onClick={() => library.closeTab(pane.id, tab.id)}>
                Close this tab
              </Button>
            </div>
          ) : (
            <div aria-busy="true" className="flex-1 px-10 pt-9">
              <div className="mx-auto max-w-[45rem] animate-pulse space-y-3">
                <div className="h-3 w-48 rounded bg-orb-raised" />
                <div className="h-7 w-80 rounded bg-orb-raised" />
                <div className="h-3 w-full max-w-md rounded bg-orb-raised" />
              </div>
            </div>
          )}
        </PaneBody>
      </>
    );
  }

  if (node.kind === "folder") return <FolderView pane={pane} tab={tab} node={node} focused={focused} onSaved={mutate} />;
  if (isSourcePath(node.path)) return <SourceView pane={pane} tab={tab} node={node} focused={focused} idPrefix={idPrefix} />;
  if (tab.editing && library.canEdit) return <EditView pane={pane} tab={tab} node={node} focused={focused} reread={mutate} />;
  return <FileView pane={pane} tab={tab} node={node} focused={focused} idPrefix={idPrefix} />;
}

/** Copies a file's Markdown, and says for a moment whether it could. */
function useCopy() {
  const [notice, setNotice] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text ?? "");
      setNotice("Copied");
    } catch {
      setNotice("Copying is not available here");
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNotice(null), 2000);
  }
  return [notice, copy];
}

/** Reading and Editing, as one control: the two states of a file. */
function ModeSwitch({ editing, onReading, onEditing }) {
  const option = "inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium transition-colors";
  return (
    <div role="group" aria-label="Mode" className="hidden rounded-full border border-orb-line bg-orb-black p-0.5 sm:flex">
      <button type="button" aria-pressed={!editing} onClick={onReading} className={cn(option, editing ? "text-orb-gray hover:text-orb-white" : "bg-orb-raised text-orb-white")}>
        Reading
      </button>
      <button type="button" aria-pressed={editing} onClick={onEditing} className={cn(option, editing ? "bg-orb-raised text-orb-white" : "text-orb-gray hover:text-orb-white")}>
        Editing
      </button>
    </div>
  );
}

/** The "⋯" of a file or a copy: bookmark it, open it beside itself, and the rare, consequential rest. */
function NodeMenu({ node, movable = false }) {
  const library = useLibrary();
  const bookmarked = library.isBookmarked(node.path);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button type="button" aria-label="More" title="More" disabled={library.busy} className={PANE_ICON_BUTTON}>
            <MoreHorizontal aria-hidden="true" className="size-4" />
          </button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => library.toggleBookmark(node.path)}>
          {bookmarked
            ? <><BookmarkMinus aria-hidden="true" className="size-3.5" /> Remove the bookmark</>
            : <><Bookmark aria-hidden="true" className="size-3.5" /> Bookmark</>}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => library.open(node.path, "right")}>
          <Columns2 aria-hidden="true" className="size-3.5" /> Open to the right
        </DropdownMenuItem>
        {movable && (
          <>
            <DropdownMenuItem onClick={() => library.move(node)}>
              <Pencil aria-hidden="true" className="size-3.5" /> Move or rename…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => library.remove(node)}>
              <Trash2 aria-hidden="true" className="size-3.5" /> Delete file
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A file of the knowledge base, open to read. */
function FileView({ pane, tab, node, focused, idPrefix }) {
  const library = useLibrary();
  const [notice, copy] = useCopy();
  // The overview and the index are found by role and move with the folder they are in; neither is
  // moved on its own or deleted from here.
  const movable = !entryRoleOf(node, library.roles) && library.canEdit;
  const lockLabel = node.locked ? "Unlock: let agents write here again" : "Lock: keep agents out";
  const runWrite = library.work.inFlight ? library.phases.writes.find((write) => write.path === node.path) ?? null : null;
  const edit = () => library.setTabEditing(pane.id, tab.id, true);

  return (
    <>
      <ViewHeader pane={pane} tab={tab} path={node.path} title={node.title || node.name}>
        {notice && <span role="status" className="mr-1 text-xs text-orb-muted">{notice}</span>}
        {library.canEdit && (
          <>
            <ModeSwitch editing={false} onReading={() => {}} onEditing={edit} />
            <button type="button" aria-label="Edit" title="Edit (⌘E)" onClick={edit} className={cn(PANE_ICON_BUTTON, "sm:hidden")}>
              <Pencil aria-hidden="true" className="size-4" />
            </button>
          </>
        )}
        <button type="button" aria-label="History" title="History" disabled={library.busy} onClick={() => library.openHistory(node)} className={PANE_ICON_BUTTON}>
          <History aria-hidden="true" className="size-4" />
        </button>
        {library.canEdit && (
          <button type="button" aria-label={lockLabel} title={lockLabel} aria-pressed={node.locked} disabled={library.busy} onClick={() => library.toggleLock(node)} className={PANE_ICON_BUTTON}>
            {node.locked ? <LockOpen aria-hidden="true" className="size-4 text-orb-cyan" /> : <Lock aria-hidden="true" className="size-4" />}
          </button>
        )}
        <button type="button" aria-label="Copy as Markdown" title="Copy as Markdown" onClick={() => copy(node.markdown)} className={PANE_ICON_BUTTON}>
          <Copy aria-hidden="true" className="size-4" />
        </button>
        <NodeMenu node={node} movable={movable} />
      </ViewHeader>
      <PaneBody focused={focused} inspector={<LibraryInspector node={node} idPrefix={idPrefix} onAddTag={library.canEdit ? edit : undefined} />}>
        <LibraryDocument
          node={node}
          idPrefix={idPrefix}
          runWrite={runWrite}
          onSeeChange={() => library.openHistory(node, { latest: true })}
        />
      </PaneBody>
    </>
  );
}

/** A copy of a page of the site: read-only, with the live page one press away. */
function SourceView({ pane, tab, node, focused, idPrefix }) {
  const library = useLibrary();
  const [notice, copy] = useCopy();
  const url = node.page?.url ?? node.url ?? null;

  return (
    <>
      <ViewHeader pane={pane} tab={tab} path={node.path} title={library.labelOf(node.path)}>
        {notice && <span role="status" className="mr-1 text-xs text-orb-muted">{notice}</span>}
        <span className="hidden h-6 items-center gap-1.5 rounded-full border border-dashed border-orb-line px-2.5 text-xs text-orb-gray sm:inline-flex">
          <Lock aria-hidden="true" className="size-3" /> Copy of the site · read-only
        </span>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" aria-label="Open the live page" title="Open the live page" className={PANE_ICON_BUTTON}>
            <ExternalLink aria-hidden="true" className="size-4" />
          </a>
        )}
        <button type="button" aria-label="Copy as Markdown" title="Copy as Markdown" onClick={() => copy(node.markdown)} className={PANE_ICON_BUTTON}>
          <Copy aria-hidden="true" className="size-4" />
        </button>
        <NodeMenu node={node} />
      </ViewHeader>
      <PaneBody focused={focused} inspector={<LibraryInspector node={node} idPrefix={idPrefix} />}>
        <LibraryDocument node={node} idPrefix={idPrefix} />
      </PaneBody>
    </>
  );
}

/**
 * A folder: its page, or, in editing, its name and summary.
 *
 * The folders code writes — Sources and what is under it — have no actions: their paths and their
 * places are how everything else finds them.
 */
function FolderView({ pane, tab, node, focused, onSaved }) {
  const library = useLibrary();
  const fixed = isFixedFolder(node.path) || isSourcePath(node.path);
  // Nothing that changes a folder is drawn for somebody who may only read the Library.
  const editable = !fixed && library.canEdit;
  const full = node.depth >= LIBRARY_LIMITS.depth;
  const title = node.title || node.name;
  const lockLabel = node.locked ? "Unlock this folder: let agents write here again" : "Lock this folder: keep agents out";

  if (tab.editing && editable) {
    return (
      <>
        <ViewHeader pane={pane} tab={tab} path={node.path} title={title} />
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <LibraryFileEditor
            key={node.path}
            node={node}
            busy={library.busy}
            onCancel={() => library.setTabEditing(pane.id, tab.id, false)}
            onToggleLock={library.toggleLock}
            onSave={async (body) => {
              const saved = await library.saveNode(node, body);
              if (saved) {
                await onSaved();
                library.setTabEditing(pane.id, tab.id, false);
              }
            }}
          />
        </div>
      </>
    );
  }

  return (
    <>
      <ViewHeader pane={pane} tab={tab} path={node.path} title={title}>
        {editable && (
          <>
            <button type="button" aria-label="New file here" title="New file here" disabled={library.busy || full} onClick={() => library.startCreate("file", node.path)} className={PANE_ICON_BUTTON}>
              <FilePlus2 aria-hidden="true" className="size-4" />
            </button>
            <button type="button" aria-label="New subfolder here" title="New subfolder here" disabled={library.busy || full} onClick={() => library.startCreate("folder", node.path)} className={PANE_ICON_BUTTON}>
              <FolderPlus aria-hidden="true" className="size-4" />
            </button>
            <button type="button" aria-label={lockLabel} title={lockLabel} aria-pressed={node.locked} disabled={library.busy} onClick={() => library.toggleLock(node)} className={PANE_ICON_BUTTON}>
              {node.locked ? <LockOpen aria-hidden="true" className="size-4 text-orb-cyan" /> : <Lock aria-hidden="true" className="size-4" />}
            </button>
            <FolderMenu
              node={node}
              busy={library.busy}
              onEdit={() => library.setTabEditing(pane.id, tab.id, true)}
              onMove={library.move}
              onDelete={library.remove}
              onToggleLock={library.toggleLock}
              onReorder={library.reorder}
              canReorder={library.canReorder}
              trigger={
                <button type="button" aria-label="More for this folder" title="More" disabled={library.busy} className={PANE_ICON_BUTTON}>
                  <MoreHorizontal aria-hidden="true" className="size-4" />
                </button>
              }
            />
          </>
        )}
      </ViewHeader>
      <PaneBody focused={focused} inspector={fixed ? null : <LibraryFolderAside node={node} />}>
        <LibraryFolder
          node={node}
          header={false}
          canEdit={library.canEdit}
          crumbs={[]}
          busy={library.busy}
          onOpen={(path) => library.open(path, "current")}
          onCreate={library.startCreate}
          onEdit={() => library.setTabEditing(pane.id, tab.id, true)}
          onMove={library.move}
          onDelete={library.remove}
          onToggleLock={library.toggleLock}
          onReorder={library.reorder}
          canReorder={library.canReorder}
        />
      </PaneBody>
    </>
  );
}

/**
 * A file of the knowledge base, in editing.
 *
 * The draft is the tab's, held by the workspace, so another tab can be looked at without losing it
 * and the tab says it has unsaved changes. Done saves it and goes back to reading; Reading goes
 * back without saving and keeps the draft; Discard drops it.
 */
function EditView({ pane, tab, node, focused, reread }) {
  const library = useLibrary();
  const held = library.drafts[tab.id];
  const draft = held && held.path === node.path ? held : startDraft(node);
  const [saving, setSaving] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const valid = draft.title.trim() && draft.summary.trim();

  /**
   * Saves the draft. The file is read again before the draft is dropped, so the editor never
   * flashes the version from before the save in between.
   */
  async function save({ stay = false } = {}) {
    if (!draft.dirty) {
      if (!stay) library.setTabEditing(pane.id, tab.id, false);
      return;
    }
    if (!valid || saving) return;
    setSaving(true);
    try {
      const saved = await library.saveNode(node, draftBody(node, draft));
      if (!saved) return;
      await reread();
      library.setDraft(tab.id, null);
      if (!stay) library.setTabEditing(pane.id, tab.id, false);
    } finally {
      setSaving(false);
    }
  }

  async function discard() {
    if (draft.dirty && !(await confirm({ title: "Discard your changes to this file?", confirmLabel: "Discard changes", destructive: true }))) return;
    library.setTabEditing(pane.id, tab.id, false, { discard: true });
  }

  return (
    <>
      <ViewHeader pane={pane} tab={tab} path={node.path} title={draft.title || node.title || node.name}>
        <ModeSwitch editing onReading={() => library.setTabEditing(pane.id, tab.id, false)} onEditing={() => {}} />
        {draft.dirty && (
          <Button type="button" variant="ghost" size="sm" onClick={discard} disabled={saving}>Discard</Button>
        )}
        <Button
          type="button"
          size="sm"
          onClick={() => save()}
          disabled={saving || library.busy || (draft.dirty && !valid)}
          title={draft.dirty && !valid ? "A file needs a title and a summary" : "Save and go back to reading"}
        >
          {saving ? "Saving…" : "Done"}
        </Button>
      </ViewHeader>
      <div className="flex min-h-0 flex-1">
        <LibraryBlockEditor
          node={node}
          draft={draft}
          onDraft={(next) => library.setDraft(tab.id, next)}
          onSave={() => save({ stay: true })}
          showAside={focused && !library.split && library.inspector.open}
        />
      </div>
      {confirmDialog}
    </>
  );
}
