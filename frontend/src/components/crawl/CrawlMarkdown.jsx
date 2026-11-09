"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, Copy, Download, FileText, Search } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import { NeutralLoading } from "@/components/NeutralLoading";
import { getCrawlPageMarkdown, listCrawlMarkdown } from "@/lib/api/crawl";
import { cn } from "@/lib/utils";

/**
 * The site as a set of documents: every page's Markdown, listed by path on the left and read on
 * the right.
 *
 * It is laid out like documentation rather than like the crawl, because that is what the files
 * are for. The crawl view asks "what is wrong with this site"; this one asks "what does this site
 * say", and the answer to that is read one page at a time with the others a click away.
 *
 * The list groups files under their first path segment, folded by default except the one that
 * holds the open page, so a two-thousand-page site is a dozen folders rather than a scroll.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 */
export function CrawlMarkdown({ workspaceId }) {
  const [index, setIndex] = useState(null);
  const [failed, setFailed] = useState(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(null);
  const [documents, setDocuments] = useState({});
  const [reading, setReading] = useState(false);
  const [raw, setRaw] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const items = [];
        let skip = 0;
        let total = 0;
        // Read the whole index: the list is the navigation, and a navigation that ends at page
        // two hundred with a "more" button is a list nobody can search.
        do {
          const page = await listCrawlMarkdown(workspaceId, { limit: 500, skip });
          items.push(...page.items);
          total = page.total;
          skip += page.items.length;
          if (!page.items.length) break;
        } while (skip < total);
        if (active) setIndex(items);
      } catch (error) {
        if (active) setFailed(error?.message ?? "The pages could not be loaded.");
      }
    })();
    return () => { active = false; };
  }, [workspaceId]);

  const open = useCallback(async (item) => {
    setSelected(item);
    setNotice(null);
    if (documents[item.urlHash]) return;
    setReading(true);
    try {
      const text = await getCrawlPageMarkdown(workspaceId, item.urlHash);
      setDocuments((current) => ({ ...current, [item.urlHash]: text }));
    } catch {
      setNotice("This page's Markdown could not be loaded.");
    } finally {
      setReading(false);
    }
  }, [documents, workspaceId]);

  const groups = useMemo(() => groupByFolder(index ?? [], filter), [index, filter]);
  const text = selected ? documents[selected.urlHash] ?? null : null;
  const parsed = useMemo(() => (text ? splitFrontMatter(text) : null), [text]);

  async function copy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied.");
    } catch {
      setNotice("Copying is not available here.");
    }
  }

  function download() {
    if (!text || !selected) return;
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${filenameFor(selected.url)}.md`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  if (failed) return <p className="p-6 text-sm text-orb-coral">{failed}</p>;
  if (!index) return <NeutralLoading inline label="Loading the Markdown library" />;

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside aria-label="Pages" className="flex w-full shrink-0 flex-col border-b border-orb-line md:w-80 md:border-b-0 md:border-r">
        <div className="border-b border-orb-line p-3">
          <h1 className="font-display text-lg font-bold text-orb-white">Markdown</h1>
          <p className="mt-0.5 text-xs text-orb-muted">
            {index.length === 0 ? "No pages rendered yet." : `${index.length.toLocaleString()} ${index.length === 1 ? "page" : "pages"} as documents.`}
          </p>
          <label className="mt-3 flex items-center gap-2 rounded-md border border-orb-line bg-orb-black/30 px-2">
            <Search aria-hidden="true" className="size-3.5 shrink-0 text-orb-muted" />
            <span className="sr-only">Filter pages by path or title</span>
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter by path or title"
              className="h-8 w-full bg-transparent text-sm text-orb-white placeholder:text-orb-muted focus:outline-none"
            />
          </label>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto p-2 md:max-h-none max-h-72">
          {index.length === 0 ? (
            <p className="px-2 py-3 text-xs text-orb-muted">
              Markdown is written for each page when it is crawled. Run a fresh crawl to render every page.
            </p>
          ) : groups.length === 0 ? (
            <p className="px-2 py-3 text-xs text-orb-muted">Nothing matches.</p>
          ) : (
            groups.map((group) => (
              <Folder
                key={group.name}
                group={group}
                selected={selected}
                onOpen={open}
                forceOpen={Boolean(filter) || Boolean(selected && group.items.some((item) => item.urlHash === selected.urlHash))}
              />
            ))
          )}
        </nav>
      </aside>

      <main aria-label="Document" className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center p-8">
            <p className="max-w-sm text-center text-sm text-orb-muted">
              {index.length === 0
                ? "Once a crawl has rendered pages, they will be listed on the left."
                : "Choose a page on the left to read it."}
            </p>
          </div>
        ) : (
          <>
            <header className="flex flex-wrap items-start justify-between gap-3 border-b border-orb-line px-6 py-4">
              <div className="min-w-0">
                <h2 className="truncate font-display text-xl font-bold text-orb-white">{parsed?.meta.title || selected.title || pathOf(selected.url)}</h2>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-orb-muted">
                  <a href={selected.url} target="_blank" rel="noreferrer" className="truncate font-mono hover:text-orb-cyan hover:underline">{pathOf(selected.url)}</a>
                  {selected.words ? <span>{selected.words.toLocaleString()} words</span> : null}
                  {selected.updatedAt && <span>changed {new Date(selected.updatedAt).toLocaleDateString()}</span>}
                  {selected.truncated && <span className="text-orb-orange">truncated at 1 MB</span>}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {notice && <span role="status" className="mr-2 text-xs text-orb-muted">{notice}</span>}
                <Button type="button" variant={raw ? "default" : "ghost"} size="sm" onClick={() => setRaw((value) => !value)} aria-pressed={raw}>
                  Raw
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={copy} disabled={!text}>
                  <Copy aria-hidden="true" className="size-3.5" /> Copy
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={download} disabled={!text}>
                  <Download aria-hidden="true" className="size-3.5" /> Download
                </Button>
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
              {reading && !text ? (
                <p className="text-sm text-orb-muted">Loading…</p>
              ) : !text ? (
                <p className="text-sm text-orb-coral">{notice ?? "Nothing to show."}</p>
              ) : raw ? (
                <pre className="whitespace-pre-wrap break-words rounded-lg border border-orb-line bg-orb-black/40 p-4 font-mono text-xs leading-relaxed text-orb-gray">{text}</pre>
              ) : (
                <article className="doc-prose max-w-3xl">
                  {parsed?.meta.description && <p className="mb-6 text-base text-orb-gray">{parsed.meta.description}</p>}
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{parsed?.body ?? text}</ReactMarkdown>
                </article>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

/** One first-level folder of pages, collapsible; the root page and lone pages sit at the top. */
function Folder({ group, selected, onOpen, forceOpen }) {
  const [open, setOpen] = useState(false);
  const isOpen = open || forceOpen;
  if (group.name === "") {
    return group.items.map((item) => <FileRow key={item.urlHash} item={item} depth={0} selected={selected} onOpen={onOpen} />);
  }
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={isOpen}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-orb-gray hover:bg-orb-raised/60 hover:text-orb-white"
      >
        <ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0 text-orb-muted transition-transform", isOpen && "rotate-90")} />
        <span className="min-w-0 flex-1 truncate font-mono text-[0.8rem]">/{group.name}</span>
        <span className="shrink-0 text-xs tabular-nums text-orb-muted">{group.items.length}</span>
      </button>
      {isOpen && group.items.map((item) => <FileRow key={item.urlHash} item={item} depth={1} selected={selected} onOpen={onOpen} />)}
    </div>
  );
}

/** One document in the list: its title when it has one, its path underneath. */
function FileRow({ item, depth, selected, onOpen }) {
  const current = selected?.urlHash === item.urlHash;
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      aria-current={current ? "page" : undefined}
      style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}
      className={cn(
        "flex w-full items-start gap-2 rounded-md py-1.5 pr-2 text-left transition-colors",
        current ? "bg-orb-raised text-orb-white" : "text-orb-gray hover:bg-orb-raised/60 hover:text-orb-white",
      )}
    >
      <FileText aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-orb-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{item.title || pathOf(item.url)}</span>
        {item.title && <span className="block truncate font-mono text-[0.65rem] text-orb-muted">{pathOf(item.url)}</span>}
      </span>
    </button>
  );
}

/** Groups the index by first path segment, filtered by path or title, folders after the root. */
function groupByFolder(items, filter) {
  const needle = filter.trim().toLowerCase();
  const matching = needle
    ? items.filter((item) => item.url.toLowerCase().includes(needle) || (item.title ?? "").toLowerCase().includes(needle))
    : items;
  const byName = new Map();
  for (const item of matching) {
    const segments = pathOf(item.url).split("/").filter(Boolean);
    const name = segments.length > 1 ? segments[0] : "";
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(item);
  }
  return [...byName.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([name, group]) => ({ name, items: group }));
}

/**
 * Separates the front matter the crawler wrote from the body, reading the few keys it uses.
 *
 * A hand-rolled reader rather than a YAML parser: the crawler writes exactly one shape, six
 * quoted string keys, and that is all this needs to read back.
 */
function splitFrontMatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  for (const line of match[1].split("\n")) {
    const pair = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!pair) continue;
    try {
      meta[pair[1]] = JSON.parse(pair[2]);
    } catch {
      meta[pair[1]] = pair[2];
    }
  }
  return { meta, body: text.slice(match[0].length) };
}

function pathOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

function filenameFor(url) {
  const path = pathOf(url).replace(/^\/+|\/+$/g, "") || "index";
  return path.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
}
