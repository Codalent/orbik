"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { RowList } from "@/components/ui/panel";
import { getCrawlFindings } from "@/lib/api/crawl";
import { cn } from "@/lib/utils";

/** Pages fetched per request, and per press of "show more". */
const PAGE_SIZE = 50;

/**
 * What each finding lists, and how its list is introduced. The kinds are the API's
 * (`GET /crawl/findings?kind=`), and each is counted there by the same filter as the figure that
 * opens it, so "Broken 9" opens nine rows.
 */
export const FINDINGS = Object.freeze({
  broken: {
    title: "Broken pages",
    description: "Pages that answered with an error when they were last fetched. Select one to see what it answered and which pages link to it.",
  },
  orphans: {
    title: "Pages nothing links to",
    description: "Pages no other page on the site links to: the crawl found them through the sitemap alone.",
  },
  duplicates: {
    title: "Duplicate URLs",
    description: "Addresses that lead to a page already counted, each with the page it is folded into.",
  },
});

/**
 * The pages behind one of the crawl page's figures, as a flat list in place of the tree.
 *
 * A tree of collapsed folders answers "what is under /docs"; somebody who has just read "Broken 9"
 * is asking which nine, and should not have to open every folder to find them. Each row opens the
 * page's detail panel, as a row in the tree does.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 * @param {"broken"|"orphans"|"duplicates"} props.kind
 * @param {(urlHash: string) => void} props.onSelect opens a page's detail panel
 * @param {string|null} [props.selectedHash] the page whose panel is open
 * @param {() => void} props.onClear goes back to the tree of every page
 */
export function CrawlFindings({ workspaceId, kind, onSelect, selectedHash = null, onClear }) {
  const [state, setState] = useState({ items: [], total: 0, loading: true, failed: false });
  const finding = FINDINGS[kind];

  /** Applies one page of rows, appending so "show more" extends rather than redraws. */
  const receive = useCallback((result, skip) => {
    setState((current) => ({
      items: skip === 0 ? result.items : [...current.items, ...result.items],
      total: result.total,
      loading: false,
      failed: false,
    }));
  }, []);

  // The starting state is already "loading", and the component is remounted for another kind,
  // so the effect only starts the request.
  useEffect(() => {
    let active = true;
    getCrawlFindings(workspaceId, { kind, limit: PAGE_SIZE, skip: 0 })
      .then((result) => { if (active) receive(result, 0); })
      .catch(() => { if (active) setState((current) => ({ ...current, loading: false, failed: true })); });
    return () => { active = false; };
  }, [kind, receive, workspaceId]);

  /** Loads the next page, or retries the first after a failure. */
  function load(skip) {
    setState((current) => ({ ...current, loading: true, failed: false }));
    getCrawlFindings(workspaceId, { kind, limit: PAGE_SIZE, skip })
      .then((result) => receive(result, skip))
      .catch(() => setState((current) => ({ ...current, loading: false, failed: true })));
  }

  const remaining = state.total - state.items.length;
  // A duplicate often differs from its page only by scheme or host (`http://`, `www.`), which a
  // path alone would hide, so duplicates are shown in full.
  const show = (url) => (kind === "duplicates" ? url : pathOf(url));

  return (
    <section aria-labelledby="crawl-findings-heading" className="p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2 id="crawl-findings-heading" className="font-display text-lg font-bold text-orb-white">
          {finding.title}
          {!state.loading || state.items.length ? <span className="ml-2 font-sans text-sm font-normal tabular-nums text-orb-muted">{state.total.toLocaleString()}</span> : null}
        </h2>
        <Button type="button" variant="ghost" size="sm" onClick={onClear}>
          <X aria-hidden="true" className="size-4" />
          Show every page
        </Button>
      </div>
      <p className="mt-1 text-xs text-orb-muted">{finding.description}</p>

      <div className="mt-4">
        {state.failed ? (
          <p role="alert" className="text-sm text-orb-coral">
            This list could not be loaded.{" "}
            <button type="button" className="underline underline-offset-2" onClick={() => load(state.items.length)}>Try again</button>
          </p>
        ) : state.loading && !state.items.length ? (
          <p className="text-sm text-orb-muted">Loading…</p>
        ) : !state.items.length ? (
          <p className="text-sm text-orb-muted">None. The last crawl found nothing here.</p>
        ) : (
          <RowList>
            {state.items.map((item) => (
              <li key={item.urlHash}>
                <button
                  type="button"
                  onClick={() => onSelect(item.urlHash)}
                  aria-current={item.urlHash === selectedHash ? "true" : undefined}
                  className={cn(
                    "flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left transition-colors hover:bg-orb-raised/70 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-orb-lime sm:px-4",
                    item.urlHash === selectedHash && "bg-orb-raised",
                  )}
                >
                  <span className="min-w-[11rem] flex-1 truncate font-mono text-[0.8rem] text-orb-white" title={item.url}>{show(item.url)}</span>
                  {item.duplicateOf && (
                    <span className="flex min-w-0 items-center gap-1.5 text-xs text-orb-muted">
                      <ArrowRight aria-hidden="true" className="size-3 shrink-0" />
                      <span className="sr-only">duplicate of</span>
                      <span className="truncate font-mono" title={item.duplicateOf.url ?? undefined}>{item.duplicateOf.url ? show(item.duplicateOf.url) : "another page"}</span>
                    </span>
                  )}
                  <span className={cn("shrink-0 font-mono text-[0.8rem] tabular-nums", item.status >= 400 ? "text-orb-coral" : "text-orb-gray")}>
                    {item.status ?? (item.uncrawled ? "not crawled" : "–")}
                  </span>
                </button>
              </li>
            ))}
          </RowList>
        )}

        {remaining > 0 && !state.failed && (
          <button
            type="button"
            disabled={state.loading}
            onClick={() => load(state.items.length)}
            className="mt-2 rounded-md px-1.5 py-0.5 text-sm text-orb-cyan hover:bg-orb-raised disabled:opacity-60"
          >
            {state.loading ? "Loading…" : `Show ${remaining.toLocaleString()} more`}
          </button>
        )}
      </div>
    </section>
  );
}

/** A page's address without its host, as the tree shows it; the full address is in its title. */
function pathOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return url;
  }
}
