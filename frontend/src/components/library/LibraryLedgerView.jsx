"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import useSWR from "swr";

import { PaneBody, ViewHeader } from "./LibraryPaneParts";
import { useLibrary } from "./libraryContext";
import { agentSourcesPath } from "@/lib/api/knowledge";
import { locateLibraryPage } from "@/lib/api/library";
import { formatShortDate, hostAndPath, LIBRARY_AGENT_SLUG } from "@/lib/library/library";
import { cn } from "@/lib/utils";

/** How many pages the ledger reads at once; a site larger than this is filtered by address. */
const LEDGER_LIMIT = 500;

/** The three ways the ledger can be read. */
const HALVES = Object.freeze([
  { value: "all", label: "All" },
  { value: "used", label: "Used" },
  { value: "left", label: "Left out" },
]);

/**
 * The source ledger: every page of the site the agent decided about, and what it decided.
 *
 * It answers the one question people reliably ask about an agent whose inputs are chosen for it —
 * why is my best blog post not in here? — with the reason recorded for each page at the moment it
 * was decided, so the honest answer is a list rather than an explanation somebody writes
 * afterwards. It used to be folded into the run's panel; it is a tab now, because a list of a few
 * hundred pages is something to filter and work through, not a footnote.
 *
 * The left-out half can be argued with. Every reason is a rule the system applied, and a rule is
 * wrong sometimes. "Include" records that the knowledge base should be written from a page; that
 * happens on the agent's next write run, so the row says "Queued", never "Included", until it has.
 * The page chosen in the list is shown beside it — why it was left out, what including it does —
 * with its copy one press away.
 *
 * @param {object} props
 * @param {object} props.pane
 * @param {object} props.tab
 * @param {boolean} props.focused
 */
export function LibraryLedgerView({ pane, tab, focused }) {
  const library = useLibrary();
  const counts = library.state?.sources ?? { used: 0, excluded: 0 };
  const total = counts.used + counts.excluded;
  const [half, setHalf] = useState(counts.excluded ? "left" : "all");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(null);
  // Keyed by page, so a row that has been asked for keeps saying so while its neighbours stay
  // clickable — and a second press cannot queue it twice.
  const [asked, setAsked] = useState({});

  const { data, error } = useSWR(agentSourcesPath(library.workspaceId, LIBRARY_AGENT_SLUG, {
    relevant: half === "all" ? undefined : half === "used",
    limit: LEDGER_LIMIT,
  }));
  const items = useMemo(() => {
    const term = filter.trim().toLowerCase();
    const all = data?.items ?? [];
    return term ? all.filter((item) => `${item.url} ${item.title ?? ""}`.toLowerCase().includes(term)) : all;
  }, [data, filter]);
  const chosen = items.find((item) => (item.key ?? item.url) === selected) ?? items[0] ?? null;
  const site = library.state?.coverage?.pages ? hostOf(items[0]?.url) : null;

  /** Asks for one page, and leaves the row saying what happened either way. */
  async function include(item) {
    if (!item.key || asked[item.key]) return;
    setAsked((current) => ({ ...current, [item.key]: "asking" }));
    try {
      await library.include(item.key);
      setAsked((current) => ({ ...current, [item.key]: "queued" }));
    } catch (failure) {
      setAsked((current) => ({ ...current, [item.key]: failure?.message ?? "That could not be sent." }));
    }
  }

  /** Opens the copy of a page beside the ledger, found by its address. */
  async function openCopy(item, event) {
    try {
      const found = await locateLibraryPage(library.workspaceId, item.url);
      library.open(found.path, event?.metaKey || event?.ctrlKey || event?.altKey ? "tab" : "right");
    } catch (failure) {
      library.reportError(failure?.message ?? "The copy of that page could not be found.");
    }
  }

  return (
    <>
      <ViewHeader pane={pane} tab={tab} title="Source ledger" />
      <PaneBody
        focused={focused}
        inspector={chosen && <Selected item={chosen} state={asked[chosen.key]} onInclude={library.canEdit ? () => include(chosen) : null} onOpenCopy={(event) => openCopy(chosen, event)} />}
      >
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-6 md:px-7">
          <h2 className="font-display text-2xl leading-8 font-bold tracking-[-0.035em] text-orb-white">Source ledger</h2>
          <p className="mt-1 mb-4 text-sm text-orb-gray">
            Every page of {site ?? "your site"} the agent has decided about, and whether the knowledge base is written from it.
          </p>

          <div className="mb-3.5 flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Show" className="flex rounded-full border border-orb-line bg-orb-black p-0.5">
              {HALVES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={half === option.value}
                  onClick={() => { setHalf(option.value); setSelected(null); }}
                  className={cn(
                    "inline-flex h-[26px] items-center rounded-full px-3 text-xs font-medium tabular-nums transition-colors",
                    half === option.value ? "bg-orb-raised text-orb-white" : "text-orb-gray hover:text-orb-white",
                  )}
                >
                  {option.label}{" "}
                  {option.value === "all" ? total.toLocaleString() : option.value === "used" ? counts.used.toLocaleString() : counts.excluded.toLocaleString()}
                </button>
              ))}
            </div>
            <label className="flex h-8 min-w-48 flex-1 items-center gap-2 rounded-full bg-orb-line/50 px-3 text-compact text-orb-muted focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-ring/40">
              <Search aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="sr-only">Filter by address</span>
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter by address"
                className="min-w-0 flex-1 bg-transparent text-orb-white outline-none placeholder:text-orb-muted"
              />
            </label>
          </div>

          {error && <p className="text-sm text-orb-coral">{error.message ?? "The ledger could not be read."}</p>}
          {!data && !error && <p className="text-sm text-orb-muted">Loading…</p>}
          {data && !items.length && (
            <p className="text-sm text-orb-muted">{filter ? "No page's address matches that." : "Nothing here yet."}</p>
          )}

          {items.length > 0 && (
            <table className="w-full table-fixed border-collapse text-compact">
              <thead>
                <tr className="text-left text-2xs tracking-[0.12em] text-orb-muted uppercase">
                  <th scope="col" className="border-b border-orb-line px-2.5 py-2 font-medium">Page</th>
                  <th scope="col" className="hidden w-[34%] border-b border-orb-line px-2.5 py-2 font-medium sm:table-cell">Why</th>
                  <th scope="col" className="w-28 border-b border-orb-line px-2.5 py-2 text-right font-medium xl:w-52"><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const id = item.key ?? item.url;
                  const current = chosen && (chosen.key ?? chosen.url) === id;
                  return (
                    <tr key={id} className={cn("transition-colors", current ? "bg-orb-raised" : "hover:bg-orb-raised/60")}>
                      <td className="border-b border-orb-line p-0">
                        <button type="button" onClick={() => setSelected(id)} aria-pressed={current} className="block w-full px-2.5 py-2.5 text-left">
                          <span className="block break-words text-orb-white">{item.title || hostAndPath(item.url)}</span>
                          <span className="block truncate text-xs text-orb-muted">
                            {pathOf(item.url)}{item.reviewedAt ? ` · decided ${formatShortDate(item.reviewedAt)}` : ""}
                          </span>
                        </button>
                      </td>
                      <td className="hidden border-b border-orb-line px-2.5 py-2.5 align-middle break-words text-orb-gray sm:table-cell">
                        {item.relevant ? <span className="text-orb-white">Used</span> : null}
                        {item.relevant && item.reason ? " · " : null}
                        {item.reason}
                      </td>
                      <td className="border-b border-orb-line px-2.5 py-2.5 text-right">
                        {library.canEdit && !item.relevant && item.kind === "page" && item.key && item.includable !== false && (
                          <IncludeAction state={asked[item.key]} onInclude={() => include(item)} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {(data?.total ?? 0) > (data?.items?.length ?? 0) && (
            <p className="mt-3 text-xs text-orb-muted">
              Showing the first {LEDGER_LIMIT.toLocaleString()} of {data.total.toLocaleString()}. Filter by address to find the rest.
            </p>
          )}
        </div>
      </PaneBody>
    </>
  );
}

/**
 * The page chosen in the ledger: what it is, why it was decided as it was, and what including it
 * would do.
 */
function Selected({ item, state, onInclude, onOpenCopy }) {
  const includable = Boolean(onInclude) && !item.relevant && item.kind === "page" && item.key && item.includable !== false;
  return (
    <aside aria-label="Selected page" className="flex w-75 shrink-0 flex-col gap-5 overflow-y-auto border-l border-orb-line p-4 text-compact text-orb-gray">
      <section>
        <Heading>Selected</Heading>
        <p className="text-[0.9375rem] font-medium text-orb-white">{item.title || hostAndPath(item.url)}</p>
        <a href={item.url} target="_blank" rel="noreferrer" className="mt-0.5 block text-xs break-all text-orb-cyan hover:text-orb-white">{hostAndPath(item.url)}</a>
      </section>
      <section>
        <Heading>{item.relevant ? "Why it is used" : "Why it was left out"}</Heading>
        <p className="leading-snug">
          {item.reason ?? (item.relevant
            ? "It is among the pages the knowledge base is written from."
            : "The knowledge base is written from up to 80 pages, chosen by how many pages link to each, and this one was not among them.")}
        </p>
      </section>
      {includable && (
        <section>
          <Heading>If you include it</Heading>
          <p className="leading-snug">The next write run reads it alongside the chosen pages. The copy under Sources stays as it is either way.</p>
        </section>
      )}
      <div className="flex flex-wrap gap-2">
        {includable && (
          state === "queued" ? (
            <span className="inline-flex h-9 items-center rounded-full border border-orb-lime/50 px-4 text-xs text-orb-lime">Queued for the next write run</span>
          ) : (
            <button
              type="button"
              onClick={onInclude}
              disabled={state === "asking"}
              className="inline-flex h-9 items-center rounded-full bg-orb-lime px-4 text-sm font-medium text-orb-black hover:bg-orb-lime/80 disabled:opacity-50"
            >
              {state === "asking" ? "Sending…" : "Include"}
            </button>
          )
        )}
        <button
          type="button"
          onClick={onOpenCopy}
          className="inline-flex h-9 items-center rounded-full border border-orb-line px-4 text-sm font-medium text-orb-white hover:bg-orb-raised"
        >
          Open the copy
        </button>
      </div>
      {state && state !== "asking" && state !== "queued" && <p className="text-xs text-orb-coral">{state}</p>}
    </aside>
  );
}

/**
 * The "Include" control on one left-out page: nothing has happened, it is being sent, or it is
 * queued — "queued" rather than "included", because the knowledge base is written from it on the
 * agent's next run, and a label claiming it is in already would be the one thing this ledger
 * exists to prevent.
 */
function IncludeAction({ state, onInclude }) {
  if (state === "queued") {
    return <span className="inline-flex h-7 items-center rounded-full border border-orb-lime/50 px-3 text-xs text-orb-lime">Queued for the next write run</span>;
  }
  if (state && state !== "asking") return <span className="text-xs text-orb-coral">{state}</span>;
  return (
    <button
      type="button"
      onClick={onInclude}
      disabled={state === "asking"}
      className="inline-flex h-7 items-center rounded-full border border-orb-line px-3 text-xs font-medium text-orb-white hover:bg-orb-raised disabled:opacity-50"
    >
      {state === "asking" ? "Sending…" : "Include"}
    </button>
  );
}

function Heading({ children }) {
  return <h3 className="mb-1.5 font-sans text-2xs font-medium tracking-[0.12em] text-orb-muted uppercase">{children}</h3>;
}

/** A page's path and query, which is what tells one page of a site from another. */
function pathOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return url;
  }
}

/** A URL's host, without `www.`. */
function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}
