"use client";

import { useMemo, useState } from "react";
import {
  ChevronRight,
  Copy,
  History,
  Lock,
  LockOpen,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useParams } from "next/navigation";

import { LibraryMarkdown, blockAuthorsOf } from "./LibraryMarkdown";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/lib/auth/AuthProvider";
import { formatDate } from "@/lib/format";
import {
  LIBRARY_ROLES,
  authorLabel,
  entryRoleOf,
  formatRelative,
  keptPassagesLabel,
  passagesOf,
  personLabel,
} from "@/lib/library/library";

/** What the two files every Library has are, said on the file itself, wherever they are kept. */
const ROLE_LABELS = Object.freeze({
  [LIBRARY_ROLES.overview]: "Front page",
  [LIBRARY_ROLES.index]: "What to read for which job",
});

/** The identifier of a file's title, which the contents rail links to as its first entry. */
export const FILE_TOP_ID = "library-file-top";

/**
 * One Library file, open to read.
 *
 * Reading and editing are the same place in two states rather than two pages, because the whole
 * point of the Library is that correcting it is ordinary — a person who spots a wrong sentence
 * should be two clicks from fixing it. What is theirs is marked as theirs while they read, not
 * only while they edit, since "is my correction still there" is a question asked on the way past
 * rather than on the way in.
 *
 * The toolbar keeps the two everyday actions in words and the rest as icons, with moving and
 * deleting one press deeper: they are rare, consequential, and next to each other in every file
 * browser anybody has used, and a menu is the difference between a considered action and a
 * mis-click. While a run's column is open beside the file there is less room, and the lock and
 * copy fold into that menu too.
 *
 * @param {object} props
 * @param {object} props.node
 * @param {Array<{path: string, label: string}>} props.crumbs the folders above this file
 * @param {boolean} props.busy
 * @param {boolean} [props.compact] whether the toolbar has to give up room
 * @param {{action: string, at: string|null}|null} [props.runWrite] what a run in flight did to this file
 * @param {{overviewPath?: string|null, indexPath?: string|null}} [props.roles] where the entry points are
 */
export function LibraryFile({
  node,
  roles = {},
  crumbs,
  busy,
  compact = false,
  runWrite = null,
  onOpen,
  onEdit,
  onDelete,
  onMove,
  onToggleLock,
  onOpenRevisions,
}) {
  const [notice, setNotice] = useState(null);
  const { workspaceId } = useParams();
  const userBlocks = useMemo(
    () => new Set((node.userBlocks ?? []).map((block) => block.trim())),
    [node.userBlocks],
  );
  const blockAuthors = useMemo(() => blockAuthorsOf(node), [node]);
  const viewerId = useAuth().user?.id ?? null;
  const passages = passagesOf(node, viewerId);
  // The overview and the index are found by role and move with the folder they are in; neither is
  // moved on its own or deleted from here.
  const entryRole = entryRoleOf(node, roles);
  const movable = !entryRole;
  const deletable = !entryRole;
  const lockLabel = node.locked ? "Unlock: let agents write here again" : "Lock: stop agents writing here";

  async function copy() {
    try {
      await navigator.clipboard.writeText(node.markdown ?? "");
      setNotice("Copied.");
    } catch {
      setNotice("Copying is not available here.");
    }
  }

  return (
    <article className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-orb-line pl-4 pr-4 md:pl-10">
        <LibraryBreadcrumb crumbs={crumbs} current={node.title || node.name} onOpen={onOpen} />

        <div role="toolbar" aria-label="File actions" className="flex shrink-0 items-center gap-0.5">
          {notice && <span role="status" className="mr-1 text-xs text-orb-muted">{notice}</span>}
          <Button type="button" variant="secondary" size="sm" className="mr-1" onClick={onEdit} disabled={busy}>
            <Pencil aria-hidden="true" className="size-3.5" /> Edit
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenRevisions(node)} disabled={busy}>
            <History aria-hidden="true" className="size-3.5" /> History
          </Button>
          {!compact && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => onToggleLock(node)}
                disabled={busy}
                aria-label={lockLabel}
                title={lockLabel}
              >
                {node.locked
                  ? <LockOpen aria-hidden="true" className="size-3.5 text-orb-cyan" />
                  : <Lock aria-hidden="true" className="size-3.5" />}
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" onClick={copy} aria-label="Copy as Markdown" title="Copy as Markdown">
                <Copy aria-hidden="true" className="size-3.5" />
              </Button>
            </>
          )}
          {(compact || movable || deletable) && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={compact ? "More: lock, copy, move, delete" : "More: move, delete"}
                    disabled={busy}
                  >
                    <MoreHorizontal aria-hidden="true" className="size-3.5" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                {compact && (
                  <>
                    <DropdownMenuItem onClick={() => onToggleLock(node)}>
                      {node.locked
                        ? <><LockOpen aria-hidden="true" className="size-3.5" /> Unlock: let agents write here</>
                        : <><Lock aria-hidden="true" className="size-3.5" /> Lock: stop agents writing here</>}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={copy}>
                      <Copy aria-hidden="true" className="size-3.5" /> Copy as Markdown
                    </DropdownMenuItem>
                  </>
                )}
                {movable && <DropdownMenuItem onClick={() => onMove(node)}>Move or rename…</DropdownMenuItem>}
                {deletable && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => onDelete(node)}>
                      <Trash2 aria-hidden="true" className="size-3.5" /> Delete file
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 pt-7 md:px-10">
        {runWrite && (
          // Said on the file rather than only in the run's column, because this is where somebody
          // reading it would otherwise wonder why the text just moved under them — and whether
          // what they wrote survived. It did: an agent's write that drops a person's block is
          // refused, so "still here" is a fact about the store, not reassurance.
          <p className="mb-5.5 flex items-center gap-3 rounded-2xl bg-orb-raised px-3 py-2.5 text-compact text-orb-gray" role="status">
            <RefreshCw aria-hidden="true" className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              This run {runWrite.action === "created" ? "wrote" : "rewrote"} the file {formatRelative(runWrite.at)}.
              {node.protectedBlocks > 0 && (
                !passages.allMine
                  ? " What people wrote in it is still here."
                  : node.protectedBlocks === 1
                    ? " Your passage is still here."
                    : ` Your ${node.protectedBlocks} passages are still here.`
              )}
            </span>
            <button
              type="button"
              onClick={() => onOpenRevisions(node, { latest: true })}
              className="shrink-0 font-medium whitespace-nowrap text-orb-cyan hover:text-orb-white"
            >
              See what changed
            </button>
          </p>
        )}

        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-orb-muted">{node.path}</span>
          {ROLE_LABELS[entryRole] && (
            <span className="rounded-full border border-orb-line px-2 py-px text-2xs text-orb-muted">
              {ROLE_LABELS[entryRole]}
            </span>
          )}
        </div>
        <h2
          id={FILE_TOP_ID}
          className="mt-2 scroll-mt-7 font-display text-title font-bold leading-tight tracking-[-0.015em] text-orb-white"
        >
          {node.title || node.name}
        </h2>
        {node.summary && <p className="mt-1.5 max-w-xl text-[0.9375rem] leading-relaxed text-orb-gray">{node.summary}</p>}

        <p className="mt-3.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-orb-muted">
          {authorLabel(node) && (
            <span className="rounded-full bg-orb-raised px-2 py-0.5 text-orb-gray">{authorLabel(node)}</span>
          )}
          <span>Revision {node.revision}</span>
          {runWrite ? (
            <>
              <span aria-hidden="true">·</span>
              <span>Written by this run</span>
            </>
          ) : node.updatedAt && (
            <>
              <span aria-hidden="true">·</span>
              <span>
                {node.updatedBy?.kind === "user"
                  ? `Edited by ${personLabel(node.updatedBy, "you", viewerId)} `
                  : node.updatedBy?.kind === "agent" ? "Written by the agent " : ""}
                {formatDate(node.updatedAt)}
              </span>
            </>
          )}
          {node.locked && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-orb-cyan">Locked: agents do not write here</span>
            </>
          )}
          {node.protectedBlocks > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>{keptPassagesLabel(node, viewerId)}</span>
            </>
          )}
        </p>

        <div className="mt-5.5 mb-5 h-px bg-orb-line" />

        <FileBody node={node} userBlocks={userBlocks} blockAuthors={blockAuthors} onOpen={onOpen} />
      </div>
    </article>
  );
}

/**
 * Where a file or folder sits, and the way back up.
 *
 * Titles rather than path segments, because the breadcrumb is read as a sentence about where you
 * are. It starts at the workspace, which is what the Library's root is named after; the root is
 * not a node — there is no page for "the whole Library" — so it names where you are rather than
 * offering to take you nowhere.
 *
 * @param {object} props
 * @param {Array<{path: string, label: string}>} props.crumbs the root, then each folder above
 * @param {string} props.current the open node's title
 * @param {(path: string) => void} props.onOpen
 */
export function LibraryBreadcrumb({ crumbs, current, onOpen }) {
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-compact text-orb-muted">
      {crumbs.map((crumb) => (
        <span key={crumb.path} className="flex min-w-0 shrink items-center gap-1.5">
          {crumb.path === "/" ? (
            <span className="truncate">{crumb.label}</span>
          ) : (
            <button type="button" onClick={() => onOpen(crumb.path)} className="truncate hover:text-orb-white">
              {crumb.label}
            </button>
          )}
          <ChevronRight aria-hidden="true" className="size-3 shrink-0" />
        </span>
      ))}
      <span aria-current="page" className="truncate font-medium text-orb-white">{current}</span>
    </nav>
  );
}

/**
 * A file's Markdown, with the person's own passages set apart, or a line saying it is empty.
 */
function FileBody({ node, userBlocks, blockAuthors, onOpen }) {
  if (!String(node.markdown ?? "").trim()) {
    return (
      <p className="text-sm text-orb-muted">
        This file is empty. {node.locked ? "It is locked, so only you can write in it." : "Edit it, or let the agent fill it on its next run."}
      </p>
    );
  }
  return <LibraryMarkdown markdown={node.markdown} userBlocks={userBlocks} blockAuthors={blockAuthors} onOpen={(path) => onOpen(path)} className="max-w-xl" />;
}
