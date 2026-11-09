"use client";

import { AlertCircle, Database, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";

/**
 * One line saying what a question will be answered from.
 *
 * It exists because an empty answer has three completely different causes and a person cannot tell
 * them apart: the site does not say it, nothing has been indexed yet, or the index is offline. The
 * first is an answer; the other two are "come back in a minute" and "something is broken", and a
 * chat that renders all three as "I could not find that" teaches people to distrust the ones that
 * are true.
 *
 * The same line is shown on the Library page, from the same read, so the two pages cannot describe
 * one index differently.
 *
 * @param {object} props
 * @param {object|null} props.index the index status from the API
 * @param {string} [props.className]
 */
export function IndexStatus({ index, className }) {
  if (!index) return null;

  const { tone, Icon, text } = describe(index);
  return (
    <p
      role="status"
      className={cn(
        "flex items-start gap-2 text-xs",
        tone === "error" ? "text-destructive" : tone === "busy" ? "text-orb-gray" : "text-orb-muted",
        className,
      )}
    >
      <Icon aria-hidden="true" className={cn("mt-px size-3.5 shrink-0", tone === "busy" && "animate-spin")} />
      <span>{text}</span>
    </p>
  );
}

/**
 * Turns the status into the sentence and the mark that go with it.
 *
 * Ordered by what a person most needs to know: something is wrong, then something is in progress,
 * then what is there. A workspace with a healthy index and one page still to embed should read as
 * working, not as broken.
 */
function describe(index) {
  if (index.error) {
    return {
      tone: "error",
      Icon: AlertCircle,
      text: `${index.error.message} ${index.chunks ? `Answers below come from ${count(index.chunks, "section")} indexed earlier.` : "Nothing is indexed yet."}`,
    };
  }
  if (!index.sources) {
    return {
      tone: "plain",
      Icon: Database,
      text: "Nothing to search yet. Crawl the site, and the pages are indexed within a minute of the crawl finishing.",
    };
  }
  if (!index.chunks) {
    return {
      tone: "busy",
      Icon: Loader2,
      text: `Indexing ${count(index.sources, "source")}. Questions can be answered as soon as the first pass finishes.`,
    };
  }
  const parts = [
    `${count(index.chunks, "section")} from ${count(index.pages, "page")}`,
    index.libraryFiles ? `${count(index.libraryFiles, "Library file")}` : null,
  ].filter(Boolean);
  const body = parts.length > 1 ? `${parts[0]} and ${parts[1]}` : parts[0];
  return {
    tone: index.pending ? "busy" : "plain",
    Icon: index.pending ? Loader2 : Database,
    text: [
      `Searching ${body}`,
      index.indexedAt ? `, updated ${formatDate(index.indexedAt)}` : "",
      ".",
      index.pending ? ` ${count(index.pending, "source")} still to index.` : "",
    ].join(""),
  };
}

/** A count with its noun, pluralised the ordinary way. */
function count(value, noun) {
  return `${(value ?? 0).toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;
}
