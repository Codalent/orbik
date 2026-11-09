"use client";

import { useMemo, useState } from "react";
import { ExternalLink, Globe, Plus } from "lucide-react";
import useSWR from "swr";

import { sourceTarget } from "./LibraryDocument";
import { useLibrary } from "./libraryContext";
import { SourceMoved, useLibraryFreshness } from "./LibraryFreshness";
import { libraryBacklinksPath } from "@/lib/api/library";
import { useAuth } from "@/lib/auth/AuthProvider";
import { hostAndPath, isSourcePath, passagesOf } from "@/lib/library/library";
import { headingsOf } from "@/lib/library/markdown";
import { cn } from "@/lib/utils";

/**
 * The inspector beside an open file: how to move inside it, where it came from, what links to it,
 * and how it is tagged.
 *
 * "Written from" is the reason it exists. It answers "where did this sentence come from", and each
 * page opens beside the file rather than on the live site, as the copy the sentence was written
 * from — the live page may have changed since. "Linked from" is the other direction of the file's
 * own links: which files rely on this one, with the line each says it in, so a person changing a
 * file can see what they might be changing under somebody else's sentence.
 *
 * For a copy of a page the second section is the question people actually ask about one: is the
 * knowledge base written from it, and if not, can it be.
 *
 * @param {object} props
 * @param {object} props.node the open file
 * @param {string} props.idPrefix the prefix its headings were rendered with
 * @param {() => void} [props.onAddTag] starts editing, where tags are changed
 */
export function LibraryInspector({ node, idPrefix, onAddTag }) {
  const library = useLibrary();
  const source = isSourcePath(node.path);
  const headings = useMemo(() => headingsOf(node.markdown ?? ""), [node.markdown]);
  const sources = (node.sources ?? []).filter((item) => !(source && item.copyPath === node.path));
  const tags = node.tags ?? [];
  const allPages = sources.every((item) => item.kind === "page");
  const passages = passagesOf(node, useAuth().user?.id ?? null);
  // Which of the pages it was written from moved since, to mark them in "Written from".
  const moved = useLibraryFreshness().byPath.get(node.path) ?? null;

  /** Scrolls the pane to a heading. Not a `#` link: two panes may show the same file. */
  function jump(id) {
    document.getElementById(`${idPrefix}${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <aside
      aria-label="Inspector"
      className="flex w-70 shrink-0 flex-col gap-6 overflow-y-auto border-l border-orb-line p-4"
    >
      <Section label="On this page">
        <nav aria-label="On this page" className="flex flex-col">
          <button type="button" onClick={() => jump("top")} className="truncate py-[3px] text-left text-compact text-orb-white hover:text-orb-cyan">
            {node.title || node.name}
          </button>
          {headings.map((heading) => (
            <button
              key={heading.id}
              type="button"
              onClick={() => jump(heading.id)}
              className={cn("truncate py-[3px] text-left text-compact text-orb-gray hover:text-orb-white", heading.depth > 2 ? "pl-6" : "pl-3")}
            >
              {heading.text}
            </button>
          ))}
        </nav>
      </Section>

      {source ? (
        <SourceSelection node={node} />
      ) : sources.length > 0 && (
        <Section
          label={`Written from ${sources.length.toLocaleString()} ${allPages ? (sources.length === 1 ? "page" : "pages") : (sources.length === 1 ? "source" : "sources")}`}
        >
          <ul className="-mx-1.5 flex flex-col gap-px">
            {sources.map((item) => {
              const label = item.title || (item.url ? hostAndPath(item.url) : item.path || item.key);
              const inner = (
                <>
                  <Globe aria-hidden="true" className="mt-[3px] size-[13px] shrink-0 text-orb-cyan" />
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-center">
                      <span className="truncate text-compact text-orb-white">{label}</span>
                      <SourceMoved entry={moved} sourceKey={item.key} />
                    </span>
                    {item.url && <span className="block truncate text-xs text-orb-muted">{hostAndPath(item.url)}</span>}
                  </span>
                </>
              );
              return (
                <li key={`${item.kind}:${item.key}`} className="min-w-0">
                  {item.copyPath ? (
                    <button
                      type="button"
                      onClick={(event) => library.open(item.copyPath, sourceTarget(event))}
                      onAuxClick={(event) => { if (event.button === 1) library.open(item.copyPath, "tab"); }}
                      title="Open the copy beside this file"
                      className="flex w-full gap-2 rounded-md px-1.5 py-1 text-left hover:bg-orb-raised"
                    >
                      {inner}
                    </button>
                  ) : item.url ? (
                    <a href={item.url} target="_blank" rel="noreferrer" className="flex gap-2 rounded-md px-1.5 py-1 hover:bg-orb-raised">{inner}</a>
                  ) : (
                    <span className="flex gap-2 px-1.5 py-1">{inner}</span>
                  )}
                </li>
              );
            })}
          </ul>
          {node.hasUserContent && (
            <p className="mt-2 text-xs leading-snug text-orb-muted">
              {!passages.allMine
                ? "The passages people wrote have no source: they are what your team knows, not what the site says."
                : node.protectedBlocks === 1
                  ? "Your passage has no source: it is what you know, not what the site says."
                  : "Your passages have no source: they are what you know, not what the site says."}
            </p>
          )}
        </Section>
      )}

      <Backlinks path={node.path} />

      {!source && (
        <Section label="Tags">
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <span key={tag} className="rounded-full bg-orb-raised px-2.5 text-xs leading-6 text-orb-gray">{tag}</span>
            ))}
            {onAddTag && (
              <button
                type="button"
                onClick={onAddTag}
                className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-orb-line px-2.5 text-xs text-orb-gray hover:border-orb-muted hover:text-orb-white"
              >
                <Plus aria-hidden="true" className="size-3" /> Add a tag
              </button>
            )}
          </div>
        </Section>
      )}
    </aside>
  );
}

/**
 * The files that link to this one, each with the line the link is in.
 *
 * Read from the API rather than worked out from the tree, because the tree holds no file's text: a
 * list built from whatever the page happened to have loaded would be a partial answer presented
 * as a whole one.
 */
function Backlinks({ path }) {
  const library = useLibrary();
  const { data, error } = useSWR(libraryBacklinksPath(library.workspaceId, path));
  const links = data?.links ?? [];

  return (
    <Section label={data?.total ? `Linked from ${data.total.toLocaleString()}` : "Linked from"}>
      {error ? (
        <p className="text-xs text-orb-muted">The files that link here could not be read.</p>
      ) : !data ? (
        <p className="text-xs text-orb-muted">Loading…</p>
      ) : !links.length ? (
        <p className="text-xs leading-snug text-orb-muted">No file links here yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {links.map((link) => (
            <li key={link.path}>
              <button
                type="button"
                onClick={(event) => library.open(link.path, event)}
                className="w-full rounded-md border border-orb-line bg-orb-black px-2 py-1.5 text-left transition-colors hover:border-orb-muted"
              >
                <span className="block truncate text-compact text-orb-white">{link.title || link.name}</span>
                {link.context && (
                  <span className="mt-0.5 line-clamp-3 block text-xs leading-[17px] text-orb-muted">
                    <ReadableContext text={link.context} target={path} />
                  </span>
                )}
              </button>
            </li>
          ))}
          {data.total > links.length && (
            <li className="text-xs text-orb-muted">and {(data.total - links.length).toLocaleString()} more</li>
          )}
        </ul>
      )}
    </Section>
  );
}

/** A Library path written out in a line of text. */
const PATH_IN_TEXT = /\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*/g;

/**
 * The line a link sits in, with every path the page knows read as its file's title — an agent
 * writes `see /02-offer/pricing` — and the link to this file set in white, so the eye finds it.
 */
function ReadableContext({ text, target }) {
  const library = useLibrary();
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(PATH_IN_TEXT)) {
    const title = library.titleOf(match[0]);
    if (!title) continue;
    parts.push(text.slice(last, match.index));
    parts.push(
      <span key={match.index} className={match[0] === target ? "text-orb-white" : undefined}>{title}</span>,
    );
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

/**
 * Whether the knowledge base is written from this page, and the way to ask for it when it is not.
 *
 * "Include" is a request, not an edit: the next write run reads the page alongside the chosen
 * ones, and the copy stays exactly as it is either way — which the button's result says, because
 * the press is instant and the run is not.
 */
function SourceSelection({ node }) {
  const library = useLibrary();
  const [asked, setAsked] = useState(null);
  const key = (node.sources ?? []).find((item) => item.kind === "page")?.key ?? null;
  const url = node.page?.url ?? node.url ?? null;

  async function include() {
    setAsked("asking");
    try {
      await library.include(key);
      setAsked("queued");
    } catch (failure) {
      setAsked(failure?.message ?? "That could not be sent.");
    }
  }

  return (
    <Section label="In the knowledge base">
      <p className="text-compact leading-snug text-orb-gray">
        {node.chosen
          ? "Chosen: the knowledge base is written from this page, and the next write run reads it again when it changes."
          : "Left out: the knowledge base is written from up to 80 pages, chosen by how many pages link to each, and this one was not among them."}
      </p>
      {!node.chosen && key && library.canEdit && (
        asked === "queued" ? (
          <p className="mt-2.5 inline-flex h-7 items-center rounded-full border border-orb-lime/50 px-3 text-xs text-orb-lime">Queued for the next write run</p>
        ) : (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={include}
              disabled={asked === "asking"}
              className="inline-flex h-8 items-center rounded-full bg-orb-lime px-3.5 text-compact font-medium text-orb-black hover:bg-orb-lime/80 disabled:opacity-50"
            >
              {asked === "asking" ? "Sending…" : "Include"}
            </button>
            {asked && asked !== "asking" && <span className="text-xs text-orb-coral">{asked}</span>}
          </div>
        )
      )}
      {url && (
        <a href={url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-xs text-orb-cyan hover:text-orb-white">
          <ExternalLink aria-hidden="true" className="size-3" /> Open the live page
        </a>
      )}
    </Section>
  );
}

/** A titled block of the inspector. */
function Section({ label, children }) {
  return (
    <section>
      <h3 className="mb-2 font-sans text-2xs font-medium tracking-[0.12em] text-orb-muted uppercase">{label}</h3>
      {children}
    </section>
  );
}
