"use client";

import { useMemo } from "react";
import { Globe, RefreshCw } from "lucide-react";

import { LibraryMarkdown, blockAuthorsOf } from "./LibraryMarkdown";
import { useLibrary } from "./libraryContext";
import { FreshnessNote } from "./LibraryFreshness";
import { OpenQuestionsPanel, isOpenQuestionsFile } from "./LibraryOpenQuestions";
import { useAuth } from "@/lib/auth/AuthProvider";
import { formatDate } from "@/lib/format";
import {
  LIBRARY_ROLES,
  authorLabel,
  entryRoleOf,
  formatRelative,
  formatShortDate,
  hostAndPath,
  isSourcePath,
  keptPassagesLabel,
  passagesOf,
  personLabel,
} from "@/lib/library/library";

/** What the two files every Library has are, said on the file itself, wherever they are kept. */
const ROLE_LABELS = Object.freeze({
  [LIBRARY_ROLES.overview]: "Front page",
  [LIBRARY_ROLES.index]: "What to read for which job",
});

/**
 * Where a page's sources open: beside it, unless a modifier key asks for a tab.
 *
 * Checking a sentence against the page it came from is the reason a note and its source are ever
 * open together, so the plain click is the split; Cmd, Ctrl or Alt still give a tab.
 */
export function sourceTarget(event) {
  return event?.metaKey || event?.ctrlKey || event?.altKey || event?.button === 1 ? "tab" : "right";
}

/**
 * One Library file, open to read: a file of the knowledge base, or the copy of a page of the site.
 *
 * What is the person's own is marked as theirs while they read, not only while they edit, since
 * "is my correction still there" is a question asked on the way past rather than on the way in.
 * The pages the file was written from close it, one press each from being read beside it.
 *
 * A copy of a page says so before anything else: which address, when it was copied, and whether
 * the knowledge base is written from it — it is the site's words, not the company's, and nobody
 * edits it here.
 *
 * @param {object} props
 * @param {object} props.node the open file
 * @param {string} props.idPrefix prefixes the identifiers of its headings
 * @param {{action: string, at: string|null}|null} [props.runWrite] what a run in flight did to it
 * @param {() => void} [props.onSeeChange] opens History on the version the run just wrote
 */
export function LibraryDocument({ node, idPrefix, runWrite = null, onSeeChange }) {
  const library = useLibrary();
  const source = isSourcePath(node.path);
  const entryRole = entryRoleOf(node, library.roles);
  const userBlocks = useMemo(() => new Set((node.userBlocks ?? []).map((block) => block.trim())), [node.userBlocks]);
  const blockAuthors = useMemo(() => blockAuthorsOf(node), [node]);
  const viewerId = useAuth().user?.id ?? null;
  const passages = passagesOf(node, viewerId);
  const evidence = (node.sources ?? []).filter((item) => item.copyPath);
  const url = node.page?.url ?? node.url ?? null;

  return (
    <article className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 pt-8 pb-16 md:px-10">
      <div className="mx-auto max-w-[45rem]">
        {runWrite && (
          // Said on the file, because this is where somebody reading it would otherwise wonder why
          // the text just moved under them — and whether what they wrote survived. It did: an
          // agent's write that drops a person's block is refused.
          <p className="mb-6 flex items-center gap-3 rounded-2xl bg-orb-raised px-3 py-2.5 text-compact text-orb-gray" role="status">
            <RefreshCw aria-hidden="true" className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              This run {runWrite.action === "created" ? "wrote" : "rewrote"} the file {formatRelative(runWrite.at)}.
              {node.protectedBlocks > 0 && (!passages.allMine ? " What people wrote in it is still here." : node.protectedBlocks === 1 ? " Your passage is still here." : ` Your ${node.protectedBlocks} passages are still here.`)}
            </span>
            {onSeeChange && (
              <button type="button" onClick={onSeeChange} className="shrink-0 font-medium whitespace-nowrap text-orb-cyan hover:text-orb-white">
                See what changed
              </button>
            )}
          </p>
        )}

        {!source && !runWrite && <FreshnessNote node={node} />}

        <div id={`${idPrefix}top`} className="flex scroll-mt-8 flex-wrap items-center gap-2">
          <span className="font-mono text-xs break-all text-orb-muted">{node.path}</span>
          {ROLE_LABELS[entryRole] && (
            <span className="rounded-full border border-orb-line px-2 text-2xs leading-5 text-orb-gray">{ROLE_LABELS[entryRole]}</span>
          )}
        </div>
        <h2 className="mt-1.5 font-display text-title leading-tight font-bold tracking-[-0.015em] text-orb-white">
          {node.title || node.name}
        </h2>
        {node.summary && !source && <p className="mt-1.5 text-[0.9375rem] leading-relaxed text-orb-gray">{node.summary}</p>}

        <p className="mt-3.5 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-orb-line pb-5 text-xs tabular-nums text-orb-muted">
          {source ? (
            <>
              <span className="rounded-full bg-orb-raised px-2 leading-[22px] text-orb-white">
                {node.chosen ? "Used to write the knowledge base" : "Stored, left out of the writing"}
              </span>
              {url && <a href={url} target="_blank" rel="noreferrer" className="text-orb-cyan hover:text-orb-white">{hostAndPath(url)}</a>}
              {node.updatedAt && <><span aria-hidden="true">·</span><span>Copied {formatShortDate(node.updatedAt)}, word for word</span></>}
              {node.page?.published && <><span aria-hidden="true">·</span><span>Published {formatShortDate(node.page.published)}</span></>}
              <span aria-hidden="true">·</span>
              <span>{(node.words ?? 0).toLocaleString()} words</span>
            </>
          ) : (
            <>
              {authorLabel(node) && <span className="rounded-full bg-orb-raised px-2 leading-[22px] text-orb-white">{authorLabel(node)}</span>}
              <span>Revision {node.revision}</span>
              {node.updatedAt && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    {runWrite ? "Written by this run" : node.updatedBy?.kind === "user" ? `Edited by ${personLabel(node.updatedBy, "you", viewerId)} ${formatDate(node.updatedAt)}` : node.updatedBy?.kind === "agent" ? `Written by the agent ${formatDate(node.updatedAt)}` : formatDate(node.updatedAt)}
                  </span>
                </>
              )}
              {node.protectedBlocks > 0 && (
                <><span aria-hidden="true">·</span><span>{keptPassagesLabel(node, viewerId)}</span></>
              )}
              {node.locked && <><span aria-hidden="true">·</span><span className="text-orb-cyan">Locked: agents stay out</span></>}
            </>
          )}
        </p>

        <div className="pt-5">
          {isOpenQuestionsFile(node) && <OpenQuestionsPanel node={node} />}
          {String(node.markdown ?? "").trim() ? (
            <LibraryMarkdown
              markdown={node.markdown}
              userBlocks={source ? null : userBlocks}
              blockAuthors={blockAuthors}
              onOpen={library.open}
              titleOf={library.titleOf}
              idPrefix={idPrefix}
            />
          ) : (
            <p className="text-sm text-orb-muted">
              {source
                ? "This copy is empty: the page had no text the crawler could keep."
                : `This file is empty. ${node.locked ? "It is locked, so only you can write in it." : "Edit it, or let the agent fill it on its next run."}`}
            </p>
          )}
        </div>

        {!source && evidence.length > 0 && (
          <div className="mt-7 flex flex-wrap items-center gap-1.5 text-[0.9375rem] text-orb-gray">
            <span className="mr-1">Evidence:</span>
            {evidence.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={(event) => library.open(item.copyPath, sourceTarget(event))}
                onAuxClick={(event) => { if (event.button === 1) library.open(item.copyPath, "tab"); }}
                title={`${item.title || item.url} — opens beside this file`}
                className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border border-orb-line bg-orb-black px-2 text-xs text-orb-cyan transition-colors hover:border-orb-cyan/50 hover:text-orb-white"
              >
                <Globe aria-hidden="true" className="size-3 shrink-0" />
                <span className="truncate">{item.copyPath.replace(/^\/sources\/website\//, "")}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
