"use client";

import {
  ArrowDown,
  ArrowUp,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  Lock,
  LockOpen,
  MoreHorizontal,
  Pencil,
  Trash2,
  UserPen,
} from "lucide-react";


import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LibraryBreadcrumb } from "./LibraryFile";
import { pathOf } from "@/lib/format";
import {
  LIBRARY_AGENT_SLUG,
  LIBRARY_LIMITS,
  authorLabel,
  formatRelative,
  formatShortDate,
  isFixedFolder,
} from "@/lib/library/library";

/** Small numbers in words, for the one sentence that says how much room is left below a folder. */
const NUMBER_WORDS = Object.freeze(["no", "one", "two", "three", "four", "five", "six"]);

/**
 * One folder, open: what belongs in it, and what is in it.
 *
 * A folder here is a document as well as a container. Its summary is what an agent reads to
 * decide whether something belongs inside it, so the page leads with that, then lists what the
 * folder holds with each child's own summary — the listing is how somebody tells, without opening
 * six files, which one answers their question. Making a file or a subfolder here is one press,
 * because a folder page is where somebody is standing when they decide one is missing.
 *
 * @param {object} props
 * @param {object} props.node the folder, with its children
 * @param {Array<{path: string, label: string}>} props.crumbs the folders above this one
 * @param {boolean} props.busy
 * @param {boolean} [props.compact] whether the toolbar has to give up room
 * @param {(kind: "folder"|"file", parentPath: string) => void} props.onCreate
 * @param {boolean} [props.header] whether it draws its own bar of breadcrumb and actions; the
 *   Library page's panes draw one of their own above it
 *
 * `canEdit` false — a read-only member of the workspace — lists the folder the same way, without
 * the ways to change it, and says nothing about why: the role is shown elsewhere.
 */
export function LibraryFolder({ node, crumbs, busy, compact = false, header = true, canEdit = true, onOpen, onCreate, onEdit, onMove, onDelete, onToggleLock, onReorder, canReorder }) {
  const children = node.children ?? [];
  const sourcePages = node.sourcePages?.pages ?? [];
  const full = node.depth >= LIBRARY_LIMITS.depth;
  const lockLabel = node.locked ? "Unlock this folder: let agents write here again" : "Lock this folder: stop agents writing here";

  return (
    <article className="flex min-w-0 flex-1 flex-col">
      {header && (
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-orb-line pl-4 pr-4 md:pl-10">
        <LibraryBreadcrumb crumbs={crumbs} current={node.title || node.name} onOpen={onOpen} />

        {canEdit && (
          <div role="toolbar" aria-label="Folder actions" className="flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mr-1"
              onClick={() => onCreate("file", node.path)}
              disabled={busy || full}
            >
              <FilePlus2 aria-hidden="true" className="size-3.5" /> New file
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => onCreate("folder", node.path)} disabled={busy || full}>
              <FolderPlus aria-hidden="true" className="size-3.5" /> New subfolder
            </Button>
            {!compact && (
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
            )}
            <FolderMenu
              node={node}
              busy={busy}
              withLock={compact}
              fixed={isFixedFolder(node.path)}
              onEdit={onEdit}
              onMove={onMove}
              onDelete={onDelete}
              onToggleLock={onToggleLock}
              onReorder={onReorder}
              canReorder={canReorder}
            />
          </div>
        )}
      </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 pt-7 md:px-10">
        <span className="font-mono text-xs text-orb-muted">{node.path}</span>
        <h2 className="mt-2 font-display text-title font-bold leading-tight tracking-[-0.015em] text-orb-white">
          {node.title || node.name}
        </h2>
        {node.summary && <p className="mt-1.5 max-w-xl text-[0.9375rem] leading-relaxed text-orb-gray">{node.summary}</p>}

        <p className="mt-3.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-orb-muted">
          {authorLabel(node) && (
            <span className="rounded-full bg-orb-raised px-2 py-0.5 text-orb-gray">{authorLabel(node)}</span>
          )}
          <span>
            {children.length
              ? `Folder · ${contentsOf(children)}`
              : `Created ${formatRelative(node.createdAt)}`}
          </span>
          {node.sourcePages?.total > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>{node.sourcePages.total.toLocaleString()} {node.sourcePages.total === 1 ? "page" : "pages"} from the site</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span>Level {node.depth} of {LIBRARY_LIMITS.depth}</span>
          {node.locked && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-orb-cyan">Locked: agents do not write here</span>
            </>
          )}
        </p>

        <div className="mt-5.5 mb-2 h-px bg-orb-line" />

        {children.length ? (
          <ul className="flex flex-col">
            {children.map((child) => (
              <li key={child.path}>
                <button
                  type="button"
                  onClick={() => onOpen(child.path)}
                  className="-mx-3 flex w-[calc(100%+1.5rem)] items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-orb-raised/60"
                >
                  {child.kind === "folder"
                    ? <Folder aria-hidden="true" className="size-4 shrink-0 text-orb-muted" />
                    : <FileText aria-hidden="true" className="size-4 shrink-0 text-orb-muted" />}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-1.5 text-sm font-medium text-orb-white">
                      <span className="truncate">{child.title || child.name}</span>
                      {child.locked && <Lock aria-label="Locked: agents do not write here" className="size-3 shrink-0 text-orb-muted" />}
                      {child.hasUserContent && child.kind === "file" && (
                        <UserPen aria-label="Has your writing" className="size-3.5 shrink-0 text-orb-muted" />
                      )}
                    </span>
                    {child.summary && <span className="truncate text-compact text-orb-gray">{child.summary}</span>}
                  </span>
                  <span className="shrink-0 text-xs whitespace-nowrap text-orb-muted">
                    {[authorLabel(child), formatShortDate(child.updatedAt)].filter(Boolean).join(" · ")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : sourcePages.length ? null : canEdit ? (
          <EmptyFolder node={node} full={full} busy={busy} onCreate={onCreate} />
        ) : (
          <p className="mt-4 text-sm text-orb-gray">Nothing in this folder yet.</p>
        )}

        {sourcePages.length > 0 && (
          <SourcePageList sourcePages={node.sourcePages} onOpen={onOpen} />
        )}
      </div>
    </article>
  );
}

/**
 * The pages of the site a folder shows with its own files.
 *
 * A folder can name a page of the site that lists others — a case-studies page, a blog's index —
 * and the pages that listing links to are shown here by reference. None of them is in this
 * folder: each is stored once, under Sources, exactly as the site published it, and opening one
 * opens that copy. The heading says which page the set comes from, so what is listed here is
 * checkable against the site.
 */
function SourcePageList({ sourcePages, onOpen }) {
  const { url, total, pages } = sourcePages;
  return (
    <section className="mt-6">
      <h3 className="flex flex-wrap items-baseline gap-x-2 text-2xs font-medium uppercase tracking-[0.12em] text-orb-muted">
        Pages from the site
        <span className="font-normal normal-case tracking-normal">
          {total.toLocaleString()} listed on{" "}
          {url
            ? <a href={url} target="_blank" rel="noreferrer" className="font-mono hover:text-orb-cyan hover:underline">{pathOf(url)}</a>
            : "a page of the site"}
          , stored in Sources
        </span>
      </h3>
      <ul className="mt-2 flex flex-col">
        {pages.map((page) => (
          <li key={page.path}>
            <button
              type="button"
              onClick={() => onOpen(page.path)}
              className="-mx-3 flex w-[calc(100%+1.5rem)] items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-orb-raised/60"
            >
              <Globe aria-hidden="true" className="size-4 shrink-0 text-orb-muted" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-orb-white">{page.title || page.name}</span>
                {page.summary && <span className="truncate text-compact text-orb-gray">{page.summary}</span>}
              </span>
              <span className="shrink-0 text-xs whitespace-nowrap text-orb-muted">{formatShortDate(page.updatedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
      {total > pages.length && (
        <p className="mt-2 text-xs text-orb-muted">
          Showing the first {pages.length.toLocaleString()}. All {total.toLocaleString()} are under Sources.
        </p>
      )}
    </section>
  );
}

/**
 * The rail beside a folder: why its summary matters, who made it, and how deep it sits.
 *
 * Each of the three answers a question a person has about a folder and cannot see from the page.
 * "Who made it" matters more than it looks: a folder a person made or edited is one agents may
 * file into but never rename, move or delete, and that rule is what makes it safe to organise the
 * Library by hand.
 *
 * @param {object} props
 * @param {object} props.node the open folder
 */
export function LibraryFolderAside({ node }) {
  return (
    <aside
      aria-label="About this folder"
      className="flex w-full shrink-0 flex-col gap-6 overflow-y-auto border-t border-orb-line py-5 pr-4 pl-5 md:w-64 md:border-t-0 md:border-l"
    >
      <Section label="Why the summary matters">
        Agents read a folder’s summary to decide what to file here, and file into folders that exist
        before making new ones.
      </Section>
      <Section label="Who made it">{madeBy(node)}</Section>
      <Section label="How deep">{howDeep(node.depth)}</Section>
    </aside>
  );
}

/** One titled paragraph of the folder's rail. */
function Section({ label, children }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-2xs font-medium uppercase tracking-[0.12em] text-orb-muted">{label}</h3>
      <p className="text-compact leading-snug text-orb-gray">{children}</p>
    </section>
  );
}

/**
 * The folder's own menu: edit, lock when the toolbar has no room for it, rename or move, reorder,
 * delete.
 *
 * Deleting is offered only for an empty folder, because that is the only kind the Library will
 * delete; a folder that still holds something says so instead of failing after the press.
 *
 * Renaming changes the path, because a path follows its name: `02 Offer` renamed `Offer` is
 * `/offer`, and every link to it is rewritten. Moving up or down changes only the order. The
 * folders code writes (`fixed`) — Brand and Sources — offer neither: their path and their place
 * are how everything else finds them.
 */
export function FolderMenu({ node, busy, withLock = false, fixed = false, onOpenFolder, onEdit, onMove, onDelete, onToggleLock, onReorder, canReorder, trigger }) {
  const count = (node.children?.length ?? 0) + (node.elided ?? 0);
  const up = !fixed && canReorder ? canReorder(node, -1) : false;
  const down = !fixed && canReorder ? canReorder(node, 1) : false;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={trigger ?? (
          <Button type="button" variant="ghost" size="icon-sm" aria-label="More: edit, move, delete" disabled={busy}>
            <MoreHorizontal aria-hidden="true" className="size-3.5" />
          </Button>
        )}
      />
      <DropdownMenuContent align="end">
        {/* In the explorer a folder's row opens and closes it, so its page — the summary and what
            is inside, each with its own — is one press deeper. */}
        {onOpenFolder && (
          <>
            <DropdownMenuItem onClick={(event) => onOpenFolder(node, event)}>
              <FolderOpen aria-hidden="true" className="size-3.5" /> Open folder page
            </DropdownMenuItem>
            {!fixed && <DropdownMenuSeparator />}
          </>
        )}
        {!fixed && (
          <DropdownMenuItem onClick={() => onEdit(node)}>
            <Pencil aria-hidden="true" className="size-3.5" /> Edit name and summary
          </DropdownMenuItem>
        )}
        {withLock && (
          <DropdownMenuItem onClick={() => onToggleLock(node)}>
            {node.locked
              ? <><LockOpen aria-hidden="true" className="size-3.5" /> Unlock: let agents write here</>
              : <><Lock aria-hidden="true" className="size-3.5" /> Lock: stop agents writing here</>}
          </DropdownMenuItem>
        )}
        {!fixed && <DropdownMenuItem onClick={() => onMove(node)}>Rename or move…</DropdownMenuItem>}
        {onReorder && !fixed && (
          <>
            <DropdownMenuItem disabled={!up} onClick={() => onReorder(node, -1)}>
              <ArrowUp aria-hidden="true" className="size-3.5" /> Move up
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!down} onClick={() => onReorder(node, 1)}>
              <ArrowDown aria-hidden="true" className="size-3.5" /> Move down
            </DropdownMenuItem>
          </>
        )}
        {!fixed && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={count > 0} onClick={() => onDelete(node)}>
              <Trash2 aria-hidden="true" className="size-3.5" />
              {count > 0 ? `Delete: empty it first (${count.toLocaleString()} inside)` : "Delete folder"}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A folder with nothing in it yet, and the two ways to put something there. */
function EmptyFolder({ node, full, busy, onCreate }) {
  return (
    <div className="mt-4 flex flex-col items-center gap-3 rounded-4xl border border-dashed border-orb-line px-8 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-full border border-dashed border-orb-line text-orb-muted">
        <Folder aria-hidden="true" className="size-4.5" />
      </span>
      <div className="flex max-w-md flex-col gap-1">
        <h3 className="text-base font-medium text-orb-white">Nothing in this folder yet</h3>
        <p className="text-sm text-orb-gray">
          {full
            ? `This folder is as deep as the Library goes, level ${LIBRARY_LIMITS.depth} of ${LIBRARY_LIMITS.depth}, so nothing can be made inside it.`
            : node.locked
              ? "Add a file, or a subfolder to group them further. It is locked, so agents will not file anything here."
              : "Add a file, or a subfolder to group them further. On its next run the agent can also file here anything that fits the summary."}
        </p>
      </div>
      {!full && (
        <div className="mt-1 flex gap-2">
          <Button type="button" variant="secondary" onClick={() => onCreate("file", node.path)} disabled={busy}>
            <FilePlus2 aria-hidden="true" className="size-3.5" /> New file here
          </Button>
          <Button type="button" variant="ghost" onClick={() => onCreate("folder", node.path)} disabled={busy}>
            <FolderPlus aria-hidden="true" className="size-3.5" /> New subfolder
          </Button>
        </div>
      )}
    </div>
  );
}

/** "6 files", "4 files and 2 subfolders": what a folder holds, in the words of its meta line. */
function contentsOf(children) {
  const folders = children.filter((child) => child.kind === "folder").length;
  const files = children.length - folders;
  return [
    files ? `${files.toLocaleString()} ${files === 1 ? "file" : "files"}` : null,
    folders ? `${folders.toLocaleString()} ${folders === 1 ? "subfolder" : "subfolders"}` : null,
  ].filter(Boolean).join(" and ");
}

/**
 * Who made a folder, and what that means for what agents may do to it.
 *
 * The rule is the store's: an agent may not rename, move or delete a folder a person has saved,
 * whether they made it or only edited its name or summary since.
 */
function madeBy(node) {
  const agent = node.authors?.agent === LIBRARY_AGENT_SLUG ? "The Library agent" : "An agent";
  const byAgent = Boolean(node.authors?.agent);
  const byUser = node.authors?.user === true;
  if (byUser && !byAgent) {
    return `You. Agents can file into it, but never rename, move or delete it. ${node.locked ? "It is locked, so they stay out of it entirely." : "Lock it to keep them out entirely."}`;
  }
  if (byUser) {
    return `${agent}, and you have edited it since, so agents can still file into it but never rename, move or delete it.`;
  }
  return `${agent}. You can rename, move or lock it. Subfolders you add here are yours: agents never rename, move or delete them.`;
}

/** How deep a folder sits, and how much room is left below it. */
function howDeep(depth) {
  const room = LIBRARY_LIMITS.depth - depth;
  const levels = `Level ${depth} of ${LIBRARY_LIMITS.depth}.`;
  if (room <= 0) return `${levels} That is as deep as paths go, so nothing can be made inside this folder.`;
  const limit = NUMBER_WORDS[LIBRARY_LIMITS.depth] ?? LIBRARY_LIMITS.depth;
  return `${levels} Paths go ${limit} levels deep, so there is room for ${NUMBER_WORDS[room] ?? room} more ${room === 1 ? "level" : "levels"} below this one.`;
}
