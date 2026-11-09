"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Plus, Search, X } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { listCrawlRoutePages, listCrawlRoutes } from "@/lib/api/crawl";
import { MAX_DESIGN_PAGES } from "@/lib/brand/brand";
import { cn } from "@/lib/utils";

/** How many pages of one route the picker lists at once. */
const ROUTE_PAGE_LIMIT = 50;

/**
 * Chooses the pages the Design system agent renders: the crawled routes on one side, the chosen
 * list on the other.
 *
 * Templated pages are the reason this is a picker and not a text box. A blog has one template
 * and four hundred posts; one or two posts stand for all of them, and the route groups the crawler
 * already found — `/blog/[slug]`, 412 pages — are the natural way to say "one of these". A route
 * with a single page is added in one click; a route with many opens to a searchable list. Anything
 * the crawl did not see can be typed in by hand.
 *
 * An empty list may be saved: the agent then chooses its own pages, so emptying the list is how
 * the choice is handed back.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 * @param {object[]} [props.initialPages] pages already chosen, when editing
 * @param {{crawled: boolean, siteUrl: string|null}} [props.readiness]
 * @param {(pages: object[]) => Promise<void>} props.onSave
 * @param {() => void} [props.onCancel]
 * @param {number} [props.limit] how many pages may be chosen
 */
export function PagePicker({
  workspaceId,
  initialPages = [],
  readiness = null,
  onSave,
  onCancel,
  limit = MAX_DESIGN_PAGES,
}) {
  const [selected, setSelected] = useState(() => initialPages.map((page) => ({ url: page.url, label: page.label, pattern: page.pattern ?? null })));
  const [routes, setRoutes] = useState(null);
  const [openRoute, setOpenRoute] = useState(null);
  const [manualUrl, setManualUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    listCrawlRoutes(workspaceId, { limit: 200 })
      .then((response) => { if (!cancelled) setRoutes(response); })
      .catch((failure) => { if (!cancelled) setError(failure?.message ?? "Could not load the crawled routes."); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const selectedUrls = useMemo(() => new Set(selected.map((page) => normalize(page.url))), [selected]);
  const full = selected.length >= limit;

  const add = useCallback((page) => {
    setError(null);
    setSelected((current) => {
      if (current.length >= limit) return current;
      if (current.some((entry) => normalize(entry.url) === normalize(page.url))) return current;
      return [...current, { url: page.url, label: page.label ?? defaultLabel(page.url), pattern: page.pattern ?? null }];
    });
  }, [limit]);

  const remove = useCallback((url) => {
    setSelected((current) => current.filter((entry) => normalize(entry.url) !== normalize(url)));
  }, []);

  function relabel(url, label) {
    setSelected((current) => current.map((entry) => (normalize(entry.url) === normalize(url) ? { ...entry, label } : entry)));
  }

  function addManual() {
    const url = manualUrl.trim();
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("scheme");
    } catch {
      return setError("Enter a full URL, starting with https://.");
    }
    add({ url });
    setManualUrl("");
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave(selected.map((page) => ({ url: page.url, label: page.label?.trim() || undefined, pattern: page.pattern ?? undefined })));
    } catch (failure) {
      setError(failure?.message ?? "Could not save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <section className="min-w-0 space-y-3" aria-labelledby="routes-heading">
          <div className="flex items-center justify-between">
            <h3 id="routes-heading" className="text-sm font-medium text-orb-white">From the crawl</h3>
            {routes?.crawled === false && <span className="text-xs text-orb-muted">The site has not been crawled yet.</span>}
          </div>
          <p className="text-xs text-orb-gray">
            Routes as the crawler found them. A route with many pages is a template: open it and pick one or two pages to stand for all of them.
          </p>
          <div className="max-h-[28rem] overflow-y-auto rounded-xl border border-orb-line">
            {!routes && <p className="p-3 text-sm text-orb-muted">Loading routes…</p>}
            {routes && !routes.items.length && (
              <p className="p-3 text-sm text-orb-muted">
                {routes.crawled ? "The crawl found no routes." : "Crawl the site to choose from its pages, or add URLs by hand below."}
              </p>
            )}
            {routes?.items.map((route) => (
              <RouteRow
                key={route.pattern}
                route={route}
                open={openRoute === route.pattern}
                onToggle={() => setOpenRoute(openRoute === route.pattern ? null : route.pattern)}
                onAdd={add}
                selectedUrls={selectedUrls}
                full={full}
                workspaceId={workspaceId}
              />
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              value={manualUrl}
              onChange={(event) => setManualUrl(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addManual(); } }}
              placeholder={readiness?.siteUrl ? `${readiness.siteUrl.replace(/\/$/, "")}/pricing` : "https://example.com/pricing"}
              aria-label="Add a page by URL"
              autoComplete="off"
              disabled={full}
            />
            <Button type="button" variant="outline" onClick={addManual} disabled={full || !manualUrl.trim()}>
              <Plus className="size-3.5" /> Add URL
            </Button>
          </div>
        </section>

        <section className="min-w-0 space-y-3" aria-labelledby="selected-heading">
          <div className="flex items-center justify-between">
            <h3 id="selected-heading" className="text-sm font-medium text-orb-white">Pages to render</h3>
            <span className={cn("text-xs tabular-nums", full ? "text-orb-orange" : "text-orb-muted")} role="status">{selected.length} / {limit}</span>
          </div>
          <p className="text-xs text-orb-gray">
            These are rendered in a browser, in this order, the first as the home page. Leave the list empty and the agent chooses for itself.
          </p>
          <ol className="max-h-[28rem] space-y-1.5 overflow-y-auto rounded-xl border border-orb-line p-2">
            {!selected.length && (
              <li className="p-2 text-sm text-orb-muted">
                Nothing chosen, so the agent chooses: your home page, then the most linked-to page of each kind of page your site has, up to eight.
              </li>
            )}
            {selected.map((page, index) => (
              <li key={page.url} className="flex items-center gap-2 rounded-lg border border-orb-line/60 bg-orb-black/30 px-2 py-1.5">
                <span className="w-5 shrink-0 text-right text-xs tabular-nums text-orb-muted">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  <input
                    value={page.label}
                    onChange={(event) => relabel(page.url, event.target.value)}
                    className="w-full bg-transparent text-sm text-orb-white outline-none placeholder:text-orb-muted"
                    aria-label={`Name for ${page.url}`}
                    maxLength={120}
                  />
                  <p className="truncate font-mono text-2xs text-orb-muted" title={page.url}>
                    {page.pattern && <span className="mr-1.5 rounded border border-orb-line px-1">{page.pattern}</span>}
                    {page.url}
                  </p>
                </div>
                <Button type="button" variant="ghost" size="icon-xs" onClick={() => remove(page.url)} aria-label={`Remove ${page.label}`}>
                  <X className="size-3.5" />
                </Button>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-orb-line/60 pt-4">
        <p className="text-xs text-orb-muted">
          Each page is rendered at desktop and mobile width in Orbik Cloud. Saving changes what the next derivation looks at; it does not start one.
        </p>
        <div className="flex gap-2">
          {onCancel && <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>}
          <Button type="button" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save pages"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** One crawled route: a single page adds in one click; a template opens to a searchable list. */
function RouteRow({ route, open, onToggle, onAdd, selectedUrls, full, workspaceId }) {
  const [search, setSearch] = useState("");
  const [pages, setPages] = useState(null);
  const [loading, setLoading] = useState(false);
  const single = route.pages === 1;
  const sampleSelected = selectedUrls.has(normalize(route.url));

  useEffect(() => {
    if (!open || single) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      listCrawlRoutePages(workspaceId, { pattern: route.pattern, search, limit: ROUTE_PAGE_LIMIT })
        .then((response) => { if (!cancelled) setPages(response.items); })
        .catch(() => { if (!cancelled) setPages([]); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, search ? 250 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, single, search, route.pattern, workspaceId]);

  return (
    <div className="border-b border-orb-line/60 last:border-b-0">
      <div className="flex items-center gap-2 px-3 py-2">
        {single ? (
          <span className="w-4" aria-hidden="true" />
        ) : (
          <button type="button" onClick={onToggle} className="text-orb-muted hover:text-orb-white" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${route.pattern}`}>
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        )}
        <button type="button" onClick={single ? undefined : onToggle} className={cn("min-w-0 flex-1 text-left", !single && "cursor-pointer")} disabled={single}>
          <span className="font-mono text-sm text-orb-white">{route.pattern}</span>
          <span className="ml-2 text-xs text-orb-muted">{route.pages === 1 ? "1 page" : `${route.pages.toLocaleString()} pages`}{route.pages > 1 ? " · template" : ""}</span>
          {single && <p className="truncate font-mono text-2xs text-orb-muted" title={route.url}>{route.url}</p>}
        </button>
        {single && (
          <Button type="button" size="xs" variant={sampleSelected ? "ghost" : "outline"} onClick={() => onAdd({ url: route.url, pattern: null })} disabled={full || sampleSelected}>
            {sampleSelected ? "Added" : <><Plus className="size-3" /> Add</>}
          </Button>
        )}
      </div>
      {open && !single && (
        <div className="space-y-2 bg-orb-black/30 px-3 pb-3 pt-1">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-orb-muted" aria-hidden="true" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search within this route" className="h-8 pl-8 text-xs" aria-label={`Search pages of ${route.pattern}`} />
          </div>
          <ul className="max-h-56 space-y-0.5 overflow-y-auto">
            {loading && !pages && <li className="px-1 py-1 text-xs text-orb-muted">Loading…</li>}
            {pages && !pages.length && <li className="px-1 py-1 text-xs text-orb-muted">No pages match.</li>}
            {pages?.map((page) => {
              const chosen = selectedUrls.has(normalize(page.url));
              return (
                <li key={page.urlHash} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-orb-raised/60">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-orb-white" title={page.title ?? page.url}>{page.title ?? defaultLabel(page.url)}</p>
                    <p className="truncate font-mono text-2xs text-orb-muted" title={page.url}>{new URL(page.url).pathname}</p>
                  </div>
                  <Button type="button" size="xs" variant={chosen ? "ghost" : "outline"} onClick={() => onAdd({ url: page.url, label: page.title ?? undefined, pattern: route.pattern })} disabled={full || chosen}>
                    {chosen ? "Added" : <><Plus className="size-3" /> Add</>}
                  </Button>
                </li>
              );
            })}
            {pages?.length === ROUTE_PAGE_LIMIT && <li className="px-1 py-1 text-2xs text-orb-muted">Showing the first {ROUTE_PAGE_LIMIT}. Search to narrow the list.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The form two URLs are compared in, mirroring the API's own rule. */
function normalize(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) parsed.pathname = parsed.pathname.slice(0, -1);
    return parsed.toString();
  } catch {
    return url;
  }
}

/** A label from the path, when the crawl offered no title. */
function defaultLabel(url) {
  try {
    const path = new URL(url).pathname;
    return path === "/" ? "Home" : decodeURIComponent(path).replace(/\/$/, "");
  } catch {
    return url;
  }
}
