"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { getCrawlActivity } from "@/lib/api/crawl";
import { pathOf } from "@/lib/format";
import { cn } from "@/lib/utils";

/** How often a running crawl is re-read. Fast enough to read as live, slow enough to be cheap. */
const POLL_MS = 2000;

/** Entries kept on screen. A crawl fetches thousands of pages; a log is read, not archived. */
const VISIBLE_ENTRIES = 40;

/** What each phase is called, in the words someone watching would use. */
const PHASE_LABELS = Object.freeze({
  queued: "Waiting in crawl queue",
  discovering: "Discovering URLs",
  fetching: "Crawling",
  finalizing: "Working out the site's structure",
  idle: "Finished",
});

/**
 * Reads what the crawl is doing, and keeps reading while it is still doing it.
 *
 * The polling lives in a hook rather than in the component because two places show this — the
 * page while a crawl runs, and the logs panel whenever it is open — and two components each
 * running their own timer would double the requests and let the two disagree about what the crawl
 * had reached.
 *
 * @param {object} options
 * @param {string} options.workspaceId workspace being crawled
 * @param {boolean} options.enabled whether to read at all
 * @param {boolean} options.live whether to keep re-reading, which only a running crawl warrants
 */
export function useCrawlActivity({ workspaceId, enabled, live }) {
  const [state, setState] = useState({ entries: [], progress: null, run: null, loaded: false });
  const seen = useRef(new Set());
  const currentRun = useRef(null);

  /**
   * Merges a poll into what is on screen, newest first, without repeating an entry.
   *
   * Which entries are new is worked out before `setState`, never inside the updater. React calls
   * an updater more than once — twice per render in development, and again whenever it replays
   * work — and an updater that writes to `seen` marks every entry as already-shown on its first
   * call, so the second call drops the very entries it was given. The log then reports progress
   * against an empty list, which is exactly the silence it exists to prevent.
   */
  const receive = useCallback((result) => {
    const changed = currentRun.current !== result.run?.id;
    if (changed) { seen.current.clear(); currentRun.current = result.run?.id; }
    const fresh = result.entries.filter((entry) => !seen.current.has(entry.urlHash));
    for (const entry of fresh) seen.current.add(entry.urlHash);
    setState((current) => ({
      entries: [...fresh, ...(changed ? [] : current.entries)].slice(0, VISIBLE_ENTRIES),
      progress: result.progress,
      logs: result.logs ?? [],
      run: result.run,
      loaded: true,
    }));
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let timer = null;

    const poll = () => {
      getCrawlActivity(workspaceId, { limit: 25 })
        .then((result) => {
          if (cancelled) return;
          receive(result);
          // Rescheduled after each response rather than on a fixed interval, so a slow reply
          // cannot stack requests on top of each other.
          if (live) timer = setTimeout(poll, POLL_MS);
        })
        .catch(() => {
          if (!cancelled && live) timer = setTimeout(poll, POLL_MS);
        });
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, live, receive, workspaceId]);

  return state;
}

/**
 * Shows a crawl as it happens: each page fetched, and the URLs it led to.
 *
 * A crawl asked for and answered with nothing reads as broken. It takes minutes, most of it spent
 * on work nobody can see, and the honest fix is not a spinner but the actual sequence of events —
 * which page was fetched, what came back, what it turned up that was new.
 *
 * The entries are page snapshots, which the crawler writes for every page regardless. A dedicated
 * event stream would have doubled the writes of every crawl and still needed a cap, at which point
 * a large crawl goes quiet exactly when someone is watching it.
 *
 * @param {object} props
 * @param {Array<object>} props.entries pages fetched, newest first
 * @param {{phase: string, fetched: number, outstanding: number, discovered: number}|null} props.progress
 * @param {boolean} props.live whether the crawl is still running
 * @param {(urlHash: string) => void} props.onSelect opens a page's detail panel
 * @param {string} [props.className] layout applied by whichever surface is hosting the log
 */
export function CrawlActivityLog({ entries, logs = [], progress, live, onSelect, className }) {
  const total = progress ? progress.fetched + progress.outstanding + (progress.skipped ?? 0) : 0;
  // The page and the logs panel can both be showing a log at once, so the heading cannot own a
  // fixed identifier: two of them would leave every `aria-labelledby` here pointing at whichever
  // one the document happened to reach first.
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className={className}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={headingId} className="flex items-center gap-2 font-display text-sm font-bold text-orb-white">
          {live && (
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 animate-[orbik-beacon_1.8s_ease-in-out_infinite] rounded-full bg-orb-cyan motion-reduce:animate-none"
            />
          )}
          {live ? PHASE_LABELS[progress?.phase] ?? "Crawling" : "Pages fetched"}
        </h2>

        {progress && (
          <p className="text-sm text-orb-muted" aria-live="polite">
            <span className="tabular-nums text-orb-gray">{progress.fetched.toLocaleString()}</span>
            {progress.outstanding > 0 && (
              <> of about <span className="tabular-nums text-orb-gray">{total.toLocaleString()}</span></>
            )}
            {" pages"}
            {progress.discovered > 0 && ` · ${progress.discovered.toLocaleString()} URLs known`}
          </p>
        )}
      </div>

      {progress?.queuePosition && <p className="mt-2 text-sm text-orb-muted">Queue position {progress.queuePosition}. One site is crawled at a time.</p>}
      {progress && (live || total > 0) && (
        <progress aria-label="Crawl progress" max={total || 1} value={total ? progress.fetched : undefined} className="mt-3 h-2 w-full max-w-3xl accent-orb-lime" />
      )}
      {progress?.skipped > 0 && <p className="mt-2 text-sm text-orb-coral">Monthly crawl budget exhausted. {progress.skipped.toLocaleString()} pages deferred.</p>}
      {progress?.rateLimited && (
        <p className="mt-2 text-sm text-orb-coral">
          {progress.rateLimited.host ?? "The site"} is rate limiting the crawler
          {progress.rateLimited.status ? ` (HTTP ${progress.rateLimited.status})` : ""}, so the crawl was stopped.
          {progress.rateLimited.skipped > 0 && ` ${progress.rateLimited.skipped.toLocaleString()} pages deferred to the next crawl.`}
        </p>
      )}
      {progress?.blocked && (
        <p className="mt-2 text-sm text-orb-coral">
          {progress.blocked.host ?? "The site"} is not letting the crawler in
          {progress.blocked.service ? `: ${progress.blocked.service}, the bot protection in front of it, turned it away` : ""}
          {progress.blocked.status ? ` (HTTP ${progress.blocked.status})` : ""}, so the crawl was stopped.
        </p>
      )}
      {logs.length > 0 && <ol aria-label="Crawler live logs" className="mt-3 max-h-48 overflow-y-auto font-mono text-xs text-orb-muted">
        {logs.map((entry) => <li key={entry.id} className="py-1">
          {entry.type.replace("crawler.", "")} · {entry.status} {entry.url ? pathOf(entry.url) : ""}
          {entry.attempts > 1 ? ` · attempt ${entry.attempts}` : ""}{entry.message ? ` · ${entry.message}` : ""}
        </li>)}
      </ol>}

      {/*
        A fixed height rather than a growing list: the log is a window onto something continuous,
        and a panel that grows for ten minutes pushes the site's actual results off the screen.
        The measure is capped because each record is four short fields; stretched to a wide screen
        they drift so far apart that the timing no longer reads as belonging to the URL beside it.
      */}
      <ol className="mt-3 max-h-64 max-w-3xl overflow-y-auto">
        {entries.length === 0 ? (
          <li className="py-1 text-sm text-orb-muted">
            {live ? progress?.phase === "queued" ? "Waiting for the sites ahead to finish…" : "Reading the site's sitemaps and robots.txt…" : "Nothing fetched yet."}
          </li>
        ) : (
          entries.map((entry) => <Entry key={entry.urlHash} entry={entry} onSelect={onSelect} />)
        )}
      </ol>
    </section>
  );
}

/** One fetched page and what it led to. */
function Entry({ entry, onSelect }) {
  const broken = typeof entry.status === "number" && entry.status >= 400;

  return (
    <li className="border-b border-orb-line/40 py-1.5 last:border-0">
      <button
        type="button"
        onClick={() => onSelect(entry.urlHash)}
        className="flex w-full items-baseline gap-3 text-left focus-visible:outline-2 focus-visible:outline-orb-lime"
      >
        <span
          className={cn(
            "w-8 shrink-0 font-mono text-xs tabular-nums",
            broken ? "text-orb-coral" : entry.status >= 300 ? "text-orb-cyan" : "text-orb-gray",
          )}
        >
          {entry.status ?? "—"}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-orb-white">{pathOf(entry.url)}</span>
        {entry.discovered.newUrls > 0 && (
          <span className="shrink-0 font-mono text-xs text-orb-lime">+{entry.discovered.newUrls}</span>
        )}
        <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-orb-muted">
          {entry.elapsedMs === null ? "" : `${entry.elapsedMs} ms`}
        </span>
      </button>

      {entry.discovered.sample.length > 0 && (
        // The addresses, not just the count: "found 3 new" is a number, and what a person watching
        // actually wants to know is which pages their site just revealed.
        <p className="truncate pl-11 font-mono text-[0.7rem] text-orb-muted">
          {entry.discovered.sample.map((url) => pathOf(url)).join("  ")}
          {entry.discovered.newUrls > entry.discovered.sample.length
            && `  +${entry.discovered.newUrls - entry.discovered.sample.length} more`}
        </p>
      )}
    </li>
  );
}
