"use client";

import {
  AlertCircle,
  ArrowRightLeft,
  Check,
  ExternalLink,
  FilePen,
  FileText,
  FolderPlus,
  ListOrdered,
  Loader2,
  MapPin,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { BrandChanges, LeftOut } from "./BrandChanges";
import { FileChip } from "./FileChip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** How sure the answer is, in the words a person would use. */
const CONFIDENCE = Object.freeze({
  high: null,
  medium: "Some of this rests on a single mention.",
  low: "Thin: this rests on one passing mention.",
  none: null,
});

/** A Library path, as the store writes them. */
const LIBRARY_PATH = /^(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

/** Each Library-changing tool, as the mark beside its line. */
const CHANGE_ICONS = Object.freeze({
  "library.write": FilePen,
  "library.mkdir": FolderPlus,
  "library.move": ArrowRightLeft,
  "library.reorder": ListOrdered,
  "library.delete": Trash2,
});

/** Where a Library path opens. */
function libraryHref(workspaceId, path) {
  return `/workspaces/${workspaceId}/library?path=${encodeURIComponent(path)}`;
}

/**
 * One turn of a conversation: a question, or an answer with what it is built on and what it changed.
 *
 * The citations are the component, not a decoration on it. An answer drawn from a site is only
 * worth having if the person can go and check it, so a page citation opens the section that
 * supports the claim and a Library citation opens the file.
 *
 * The changes are the same idea for an action. They are read from the run's own record of the
 * calls it completed, not from what the model wrote in its reply, so "Changed in your Library" is
 * what happened — and each path in it opens where the thing now lives.
 *
 * @param {object} props
 * @param {object} props.message the turn
 * @param {string} props.workspaceId for linking Library paths
 * @param {boolean} [props.pending] whether the run behind this answer is still going
 * @param {boolean} [props.latest] whether this is the last turn, which is the only one a plan
 *   waiting for agreement can be agreed to from
 * @param {(text: string) => void} [props.onReply] sends a reply, for "Go ahead"
 * @param {() => void} [props.onRevise] puts the cursor in the box, for changing the plan
 * @param {() => void} [props.onBrandChanged] re-reads the brand after an undo or an "Add it"
 * @param {boolean} [props.canChange] whether the person may change the brand
 */
export function Answer({ message, workspaceId, pending = false, latest = false, onReply, onRevise, onBrandChanged, canChange = true }) {
  if (message.role === "user") {
    return (
      <li className="flex flex-col items-end gap-1">
        {message.attachments?.length > 0 && (
          <ul className="flex max-w-[88%] flex-wrap justify-end gap-1.5" aria-label="Files sent">
            {message.attachments.map((file) => <li key={file.id}><FileChip workspaceId={workspaceId} file={file} /></li>)}
          </ul>
        )}
        <p className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-orb-raised px-3.5 py-2 text-sm text-orb-white">
          {message.text}
        </p>
        {message.context?.page && (
          <p className="flex max-w-[88%] items-center gap-1 truncate text-2xs text-orb-muted">
            <MapPin aria-hidden="true" className="size-3 shrink-0" />
            <span className="truncate">
              {message.context.page}
              {message.context.libraryPath ? ` · ${message.context.libraryPath}` : ""}
            </span>
          </p>
        )}
      </li>
    );
  }

  const failed = message.status === "failed" || message.status === "cancelled";
  const waiting = pending || (!message.text && !failed);

  return (
    <li className="space-y-3">
      {waiting && (
        <p className="flex items-center gap-2 text-sm text-orb-gray" role="status">
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          Working on it…
        </p>
      )}

      {failed && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            {message.error?.message ?? "This was not answered."}
          </AlertDescription>
        </Alert>
      )}

      {message.text && (
        <>
          {/* Sized inline: `.doc-prose` sets the reading size of a Library file, which is a size
              too large for a column this narrow, and it outranks a utility class. */}
          <div className="doc-prose [&_ol]:pl-5 [&_ul]:pl-5" style={{ fontSize: "0.875rem", lineHeight: 1.6 }}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // A Library path in backticks — which is how the agent is told to write one —
                // opens the file it names. Anything else in backticks stays code.
                code({ children, className, ...rest }) {
                  const text = String(children ?? "");
                  if (!className && LIBRARY_PATH.test(text)) {
                    return (
                      <Link href={libraryHref(workspaceId, text)} className="no-underline">
                        <code {...rest}>{text}</code>
                      </Link>
                    );
                  }
                  return <code className={className} {...rest}>{children}</code>;
                },
              }}
            >
              {message.text}
            </ReactMarkdown>
          </div>

          {/* Said plainly rather than shown as a badge: "the indexed content does not say" is the
              most important thing this chat can tell somebody, and it must not look like a label
              on an answer that otherwise reads as one. */}
          {message.confidence === "none" && (
            <p className="flex items-start gap-2 text-xs text-orb-gray">
              <AlertCircle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
              <span>
                Nothing indexed answers this.
                {message.searched?.length ? ` Searched for: ${message.searched.join("; ")}.` : ""}
              </span>
            </p>
          )}
          {message.confidence && CONFIDENCE[message.confidence] && (
            <p className="text-xs text-orb-gray">{CONFIDENCE[message.confidence]}</p>
          )}
        </>
      )}

      {message.changes?.length > 0 && <Changes changes={message.changes} workspaceId={workspaceId} />}

      {message.brandChanges?.length > 0 && (
        <BrandChanges changes={message.brandChanges} workspaceId={workspaceId} canUndo={canChange} onChanged={onBrandChanged} />
      )}

      {message.leftOut?.length > 0 && (
        <LeftOut items={message.leftOut} workspaceId={workspaceId} canAdd={canChange} onChanged={onBrandChanged} />
      )}

      {message.needsConfirmation && latest && !pending && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={() => onReply?.("Yes, go ahead.")}>
            <Check className="size-3.5" />
            Go ahead
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onRevise?.()}>
            Change the plan
          </Button>
        </div>
      )}

      {message.citations?.length > 0 && <Citations citations={message.citations} workspaceId={workspaceId} />}
    </li>
  );
}

/** What the run changed in the Library, one line per completed call. */
function Changes({ changes, workspaceId }) {
  return (
    <div className="space-y-1.5 rounded-lg border border-orb-line bg-orb-black/30 px-3 py-2.5">
      <p className="text-2xs font-medium uppercase tracking-[0.14em] text-orb-muted">Changed in your Library</p>
      <ul className="space-y-1">
        {changes.map((change, index) => {
          const Icon = CHANGE_ICONS[change.tool] ?? FileText;
          return (
            <li key={`${change.summary}-${index}`} className="flex items-start gap-2 text-xs text-orb-gray">
              <Icon aria-hidden="true" className="mt-px size-3.5 shrink-0 text-orb-lime" />
              <ChangeLine change={change} workspaceId={workspaceId} />
            </li>
          );
        })}
      </ul>
      <p className="text-2xs text-orb-muted">Recorded as yours, via Ask. A file’s earlier versions are in its history.</p>
    </div>
  );
}

/**
 * One change, with the path it ended at opening where the thing now lives. A deleted path, and the
 * old end of a move, are left as text: there is nothing there to open.
 */
function ChangeLine({ change, workspaceId }) {
  const words = change.summary.split(/(\s+)/);
  const paths = words.filter((word) => LIBRARY_PATH.test(word));
  const live = change.tool === "library.delete" ? null : paths.at(-1) ?? null;
  return (
    <span className="min-w-0 break-words">
      {words.map((word, index) => {
        if (!LIBRARY_PATH.test(word)) return <span key={index}>{word}</span>;
        if (word !== live) return <code key={index} className="font-mono text-2xs text-orb-muted">{word}</code>;
        return (
          <Link key={index} href={libraryHref(workspaceId, word)} className="font-mono text-2xs text-orb-cyan hover:underline">
            {word}
          </Link>
        );
      })}
    </span>
  );
}

/** What the answer was built on, as links that open the thing itself. */
function Citations({ citations, workspaceId }) {
  return (
    <div className="space-y-1.5 border-l border-orb-line pl-3">
      <p className="text-2xs font-medium uppercase tracking-[0.14em] text-orb-muted">Sources</p>
      <ul className="space-y-1">
        {citations.map((citation, index) => (
          <li key={`${citation.url ?? citation.path ?? index}-${index}`}>
            <CitationLink citation={citation} workspaceId={workspaceId} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One citation, opening the page section or the Library file it names. */
function CitationLink({ citation, workspaceId }) {
  const label = [citation.title, sectionOf(citation)].filter(Boolean).join(" — ");
  const classes = "inline-flex max-w-full items-start gap-1.5 text-xs text-orb-gray hover:text-orb-white";

  if (citation.sourceKind === "library" && citation.path) {
    return (
      <Link href={libraryHref(workspaceId, citation.path)} className={classes}>
        <FileText aria-hidden="true" className="mt-px size-3.5 shrink-0" />
        <span className="truncate">{label || citation.path}</span>
      </Link>
    );
  }
  if (!citation.url) {
    return <span className={cn(classes, "cursor-default")}>{label || "A source with no address"}</span>;
  }
  return (
    <a href={citation.url} target="_blank" rel="noreferrer noopener" className={classes}>
      <ExternalLink aria-hidden="true" className="mt-px size-3.5 shrink-0" />
      <span className="truncate">{label || citation.url}</span>
    </a>
  );
}

/**
 * The section a citation points at, without repeating the document's own title.
 *
 * The heading path starts with the document, so "Pricing — Pricing — Enterprise" would be the
 * naive rendering of a page called Pricing. The first element is dropped because the title is
 * already beside it.
 */
function sectionOf(citation) {
  const path = citation.headingPath ?? [];
  return path.slice(1).join(" › ");
}
