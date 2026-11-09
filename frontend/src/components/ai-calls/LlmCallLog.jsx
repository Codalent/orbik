"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { AlertCircle, ArrowLeft, Coins, Download, Hash, RefreshCw, ScrollText, Search, SlidersHorizontal, TextCursorInput, TextQuote } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { EmptyState, Panel, PanelTitle } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { StatTile } from "@/components/ui/stat-tile";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { NeutralLoading } from "@/components/NeutralLoading";
import {
  MISSING,
  PERIODS,
  SOURCES,
  STATUSES,
  describeCache,
  describeBackend,
  describeDuration,
  describePurpose,
  describeSource,
  describeTokens,
  formatClock,
  formatCompact,
  formatCost,
  formatCount,
  modelOf,
} from "@/lib/aiCalls/describe";
import { getAiCall, listAiCalls, summarizeAiCalls } from "@/lib/api/aiCalls";
import { listWorkspaces } from "@/lib/api/workspaces";
import { cn } from "@/lib/utils";
import { LlmCallDetail } from "./LlmCallDetail";

const PAGE_SIZE = 50;
const ALL = "all";

/**
 * Keeps the head's title from being squeezed by its buttons on a phone: the title column gets a
 * minimum width, so the buttons wrap under it instead (as `HEAD_WRAP` does on an agent's page).
 */
const HEAD_WRAP = "[&>div:first-of-type]:min-w-[min(calc(100%_-_3.75rem),22rem)] [&>div:last-child]:min-w-0 [&>div:last-child]:shrink";

/** Where the list and the open call sit side by side; below it the call opens in a sheet. */
const WIDE = "(min-width: 1280px)";

/**
 * Every request Orbik sends to a model, across the account's workspaces.
 *
 * It answers "what did we send, to which model, what came back, and what did it cost" for one call
 * or for a period. Two pages show it: the LLM calls developer page, reached from the app footer and
 * standing on its own, and the AI calls section of a workspace's Settings, which embeds it in the
 * workspace shell. Both show the whole account's log, with the same filters and totals.
 *
 * Rows are summaries; the words of a call — prompt, system prompt, reply — are fetched only when
 * it is opened, because a page of fifty would otherwise carry fifty system prompts nobody asked to
 * read. The totals come from the server for the same filters, so they count every matching call
 * rather than the page that happens to be loaded.
 *
 * @param {object} props
 * @param {boolean} [props.embedded] be a section of Settings, whose frame already supplies the
 *   page's `main` landmark, its h1 and its gutters, rather than being the whole page
 */
export function LlmCallLog({ embedded = false }) {
  const [period, setPeriod] = useState("24h");
  const [source, setSource] = useState(ALL);
  const [model, setModel] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [workspaceId, setWorkspaceId] = useState(ALL);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [refreshes, setRefreshes] = useState(0);

  const [result, setResult] = useState({ key: null, items: [], nextBefore: null, summary: null, error: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [workspaces, setWorkspaces] = useState([]);
  const [seenModels, setSeenModels] = useState([]);

  const [selectedId, setSelectedId] = useState(null);
  const [tab, setTab] = useState("prompt");
  const [details, setDetails] = useState({});
  // In Settings the log shares the width with the Settings navigation, which never leaves room for
  // the call beside the list, so there it always opens in a sheet.
  const wide = useMediaQuery(WIDE) && !embedded;

  // Typing is debounced so a search is one request per pause, not one per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const filters = useMemo(() => ({
    period,
    source: source === ALL ? null : source,
    model: model === ALL ? null : model,
    status: status === ALL ? null : status,
    workspaceId: workspaceId === ALL ? null : workspaceId,
    q: query || null,
  }), [period, source, model, status, workspaceId, query]);
  const requestKey = `${JSON.stringify(filters)}#${refreshes}`;

  useEffect(() => {
    let cancelled = false;
    listWorkspaces()
      .then((response) => { if (!cancelled) setWorkspaces(response.items ?? []); })
      // Names are a nicety: a row without one still says which workspace by its identifier.
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listAiCalls({ limit: PAGE_SIZE, ...filters }), summarizeAiCalls(filters)])
      .then(([page, summary]) => {
        if (cancelled) return;
        setResult({ key: requestKey, items: page.items, nextBefore: page.nextBefore, summary, error: null });
        // The model filter offers every model seen so far, so narrowing to one model does not
        // remove the others from the list it was chosen from.
        setSeenModels((known) => {
          const next = new Set(known);
          for (const row of summary.byModel) if (row.model) next.add(row.model);
          return next.size === known.length ? known : [...next].sort();
        });
      })
      .catch((failure) => {
        if (!cancelled) setResult((current) => ({ ...current, key: requestKey, error: failure?.message ?? "The calls could not be loaded. Try again." }));
      });
    return () => { cancelled = true; };
  }, [filters, requestKey]);

  const { items, summary } = result;
  const loading = result.key !== requestKey;
  const selected = items.find((call) => call.id === selectedId) ?? (wide ? items[0] ?? null : null);
  const selectedDetail = selected ? details[selected.id] ?? null : null;

  useEffect(() => {
    if (!selected || details[selected.id]) return undefined;
    let cancelled = false;
    const id = selected.id;
    getAiCall(id)
      .then((detail) => { if (!cancelled) setDetails((current) => ({ ...current, [id]: detail })); })
      .catch((failure) => {
        if (!cancelled) setDetails((current) => ({ ...current, [id]: { failed: failure?.message ?? "This call could not be loaded." } }));
      });
    return () => { cancelled = true; };
  }, [selected, details]);

  const workspaceNames = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])), [workspaces]);
  const workspaceOf = (call) => (call.workspaceId ? workspaceNames.get(call.workspaceId) ?? `Workspace ${call.workspaceId.slice(-6)}` : MISSING);

  function refresh() {
    setActionError(null);
    setDetails({});
    setRefreshes((count) => count + 1);
  }

  function open(call) {
    setSelectedId(call.id);
    setTab("prompt");
  }

  async function loadOlder() {
    setLoadingMore(true);
    setActionError(null);
    try {
      const page = await listAiCalls({ limit: PAGE_SIZE, before: result.nextBefore, ...filters });
      setResult((current) => ({ ...current, items: [...current.items, ...page.items], nextBefore: page.nextBefore }));
    } catch (failure) {
      setActionError(failure?.message ?? "Older calls could not be loaded. Try again.");
    } finally {
      setLoadingMore(false);
    }
  }

  /** Saves the rows on screen, with the filters and totals that produced them. */
  function exportPage() {
    const payload = { exportedAt: new Date().toISOString(), filters, summary, calls: items };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `llm-calls-${new Date().toISOString().slice(0, 16).replace(":", "-")}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  const title = embedded ? "AI calls" : "LLM calls";
  if (result.key === null && !result.error) return <NeutralLoading inline={embedded} label={`Loading ${title}`} />;

  const running = summary?.running ?? 0;
  const periodLabel = PERIODS.find((entry) => entry.value === period)?.label.toLowerCase() ?? "";
  const modelOptions = [...new Set([...seenModels, ...(model === ALL ? [] : [model])])].map((value) => ({ value, label: value }));
  const workspaceOptions = workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }));
  const filtered = source !== ALL || model !== ALL || status !== ALL || workspaceId !== ALL || Boolean(query);

  const detail = selected ? (
    <LlmCallDetail
      call={selected}
      detail={selectedDetail}
      workspace={workspaceOf(selected)}
      tab={tab}
      onTab={setTab}
    />
  ) : null;

  const periodPhrase = periodLabel === "last hour" ? "last hour" : `last ${periodLabel}`;
  const description = "Every request Orbik sends to a model, across all workspaces: what was sent, which model answered, what came back and what it cost.";
  const workingNow = running > 0 && (
    <Pill tone="lime" dot pulse>
      {running === 1 ? "1 call working now" : `${formatCount(running)} calls working now`}
    </Pill>
  );
  const actions = (
    <>
      <Button type="button" variant="outline" size="sm" onClick={exportPage} disabled={!items.length}>
        <Download aria-hidden="true" className="size-3.5" />
        Export JSON
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={loading}>
        <RefreshCw aria-hidden="true" className={cn("size-3.5", loading && "motion-safe:animate-spin")} />
        Refresh
      </Button>
    </>
  );

  const body = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Period" className="flex gap-0.5 rounded-full border border-orb-line bg-orb-space/70 p-[3px]">
          {PERIODS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              aria-pressed={entry.value === period}
              onClick={() => setPeriod(entry.value)}
              className={cn(
                "h-7 rounded-full px-3 text-compact font-medium whitespace-nowrap transition-colors",
                entry.value === period ? "bg-orb-raised text-orb-white shadow-sm" : "text-orb-gray hover:text-orb-white",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-expanded={filtersOpen}
          aria-controls="llm-call-filters"
          onClick={() => setFiltersOpen((value) => !value)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-full border border-orb-line bg-orb-space/70 px-3 text-compact text-orb-white lg:hidden",
            filtered && "border-orb-muted",
          )}
        >
          <SlidersHorizontal aria-hidden="true" className="size-3.5 text-orb-muted" />
          Filters
          {filtered && <span aria-hidden="true" className="size-1.5 rounded-full bg-orb-cyan" />}
        </button>
        <div aria-hidden="true" className="mx-1 hidden h-5 w-px bg-orb-line lg:block" />
        <div id="llm-call-filters" className={cn("w-full grid-cols-2 gap-2 lg:contents", filtersOpen ? "grid" : "hidden")}>
          <FilterSelect label="Source" value={source} onChange={setSource} options={SOURCES} />
          <FilterSelect label="Model" value={model} onChange={setModel} options={modelOptions} />
          <FilterSelect label="Status" value={status} onChange={setStatus} options={STATUSES} />
          <FilterSelect label="Workspace" value={workspaceId} onChange={setWorkspaceId} options={workspaceOptions} />
          <label className="col-span-2 flex h-[34px] items-center gap-2 rounded-3xl border border-orb-line bg-orb-space/70 px-3 text-orb-muted focus-within:ring-2 focus-within:ring-ring/70 lg:ml-auto lg:w-80">
            <Search aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="sr-only">Search prompts and responses</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search prompts, responses, run id…"
              maxLength={200}
              className="min-w-0 flex-1 bg-transparent text-compact text-orb-white outline-none placeholder:text-orb-muted"
            />
          </label>
        </div>
      </div>

      {(result.error || actionError) && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{result.error ?? actionError}</AlertDescription>
        </Alert>
      )}

      <section
        aria-label={`Totals for the ${periodPhrase}`}
        aria-busy={loading}
        className={cn("grid gap-3 transition-opacity", !embedded && "xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]", loading && "opacity-60")}
      >
        <div className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            icon={Hash}
            label="Calls"
            value={formatCount(summary?.calls)}
            detail={summary ? `${formatCount(summary.failed)} failed · ${formatCount(summary.running)} working now` : MISSING}
            live={running > 0}
            tone={summary?.failed ? "failed" : null}
          />
          <StatTile icon={Coins} label="Spend" value={formatCost(summary?.costUsd)} detail="list price, all providers" />
          <StatTile
            icon={TextCursorInput}
            label="Input tokens"
            value={formatCompact(summary ? summary.inputTokens + summary.cacheWriteTokens + summary.cacheReadTokens : null)}
            detail={summary ? `${formatCompact(summary.cacheReadTokens)} served from cache` : MISSING}
          />
          <StatTile
            icon={TextQuote}
            label="Output tokens"
            value={formatCompact(summary?.outputTokens)}
            detail={summary?.medianOutputTokens ? `median call ${formatCount(summary.medianOutputTokens)}` : "no output yet"}
          />
        </div>
        <SpendByModel rows={summary?.byModel ?? []} />
      </section>

      <div className={cn("grid items-start gap-6", wide && "xl:grid-cols-[minmax(0,1.8fr)_minmax(0,1fr)]")}>
        <section aria-label="Calls" aria-busy={loading} className={cn("min-w-0 transition-opacity", loading && "opacity-60")}>
          <Panel className="overflow-hidden p-0 sm:p-0">
            <div
              className={cn(
                "hidden grid-cols-[96px_minmax(0,1fr)_150px_112px_72px_112px] gap-3 border-b border-orb-line px-4 py-2.5 text-2xs font-medium tracking-[0.12em] text-orb-muted uppercase",
                embedded ? "xl:grid" : "lg:grid",
              )}
            >
              <span>Started</span>
              <span>Call</span>
              <span>Model</span>
              <span className="text-right">Tokens</span>
              <span className="text-right">Cost</span>
              <span>Status</span>
            </div>

            {items.length === 0 ? (
              <EmptyState icon={ScrollText} className="m-4 py-10">
                {filtered
                  ? "No calls match these filters."
                  : `No model calls in the ${periodPhrase}. Run an agent, ask the Library, or let the index catch up, and they will appear here.`}
              </EmptyState>
            ) : (
              <ul className="divide-y divide-orb-line/70">
                {items.map((call) => (
                  <li key={call.id}>
                    <CallRow call={call} workspace={workspaceOf(call)} selected={selected?.id === call.id} onOpen={() => open(call)} narrow={embedded} />
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-orb-line px-4 py-3">
              <span className="text-xs text-orb-muted tabular-nums">
                {summary ? `Showing ${formatCount(items.length)} of ${formatCount(summary.calls)} calls · newest first` : `${formatCount(items.length)} calls · newest first`}
              </span>
              {result.nextBefore && (
                <Button type="button" variant="outline" size="sm" onClick={loadOlder} disabled={loadingMore}>
                  {loadingMore ? "Loading…" : "Load older calls"}
                </Button>
              )}
            </div>
          </Panel>
        </section>

        {wide && detail && (
          <aside aria-label="Call details" className="min-w-0 xl:sticky xl:top-6">
            <Panel className="sm:p-6 xl:max-h-[calc(100vh-3rem)] xl:overflow-y-auto">{detail}</Panel>
          </aside>
        )}
      </div>

      {!wide && (
        <Sheet open={Boolean(selected)} onOpenChange={(value) => { if (!value) setSelectedId(null); }}>
          <SheetContent className="overflow-y-auto bg-orb-space px-4 pt-14 pb-8 data-[side=right]:w-full data-[side=right]:sm:max-w-xl sm:px-6">
            {selected && (
              <LlmCallDetail
                call={selected}
                detail={selectedDetail}
                workspace={workspaceOf(selected)}
                tab={tab}
                onTab={setTab}
                Title={SheetTitle}
              />
            )}
          </SheetContent>
        </Sheet>
      )}
    </>
  );

  // In Settings the log is a section under the Settings head, so it has a section's heading, not
  // a page's, and its buttons sit on that heading's right.
  if (embedded) {
    return (
      <SettingsSection
        id="ai-calls"
        icon={ScrollText}
        title={title}
        description={description}
        aside={<div className="flex flex-wrap items-center gap-2">{workingNow}{actions}</div>}
      >
        <div className="flex flex-col gap-6">{body}</div>
      </SettingsSection>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1600px] flex-col gap-6 px-4 py-5 sm:px-10 sm:pt-7 sm:pb-10">
      <Link href="/" className="-mb-2 inline-flex min-h-6 items-center gap-1.5 self-start text-xs text-orb-muted hover:text-orb-white">
        <ArrowLeft aria-hidden="true" className="size-3.5" />
        Orbik
      </Link>

      <PageHeader
        className={HEAD_WRAP}
        icon={ScrollText}
        title={title}
        description={description}
        status={<><Pill tone="muted">Developer tools</Pill>{workingNow}</>}
        actions={actions}
      />

      {body}
    </main>
  );
}

/**
 * One call as a row: a grid of columns from `lg` up, three stacked lines below it.
 *
 * Both layouts are in the button and one is hidden, rather than one layout squeezed into both
 * widths, because the columns need about 620 pixels before the call's name gets any. `narrow`
 * (the log in Settings, beside its navigation) waits for `xl` before showing the columns.
 */
function CallRow({ call, workspace, selected, onOpen, narrow = false }) {
  const title = describePurpose(call);
  const cost = formatCost(call.costUsd);
  const model = modelOf(call);
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onOpen}
      className={cn(
        "block w-full px-4 py-3 text-left text-orb-white transition-colors hover:bg-orb-raised/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        selected && "bg-orb-raised/80 shadow-[inset_2px_0_0_var(--color-orb-white)]",
      )}
    >
      <span className={cn("hidden grid-cols-[96px_minmax(0,1fr)_150px_112px_72px_112px] items-start gap-3", narrow ? "xl:grid" : "lg:grid")}>
        <span className="flex flex-col gap-0.5 tabular-nums">
          <time dateTime={call.startedAt ?? undefined} className="text-compact leading-5">{formatClock(call.startedAt)}</time>
          <span className="text-xs leading-4 text-orb-muted">{describeDuration(call)}</span>
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm leading-5 font-medium">{title}</span>
          <span className="truncate text-xs leading-4 text-orb-muted">{workspace} · {describeSource(call)}</span>
        </span>
        <span className="flex min-w-0 flex-col items-start gap-1">
          <ModelPill model={model} />
          <span className="max-w-full truncate text-xs leading-4 text-orb-muted">{describeBackend(call.backend)}</span>
        </span>
        <span className="flex flex-col gap-0.5 text-right tabular-nums">
          <span className="text-compact leading-5">{describeTokens(call)}</span>
          <span className="truncate text-xs leading-4 text-orb-muted">{describeCache(call)}</span>
        </span>
        <span className={cn("text-right text-compact leading-5 tabular-nums", cost === MISSING && "text-orb-muted")}>{cost}</span>
        <StatusCell call={call} />
      </span>

      <span className={cn("flex flex-col gap-1.5", narrow ? "xl:hidden" : "lg:hidden")}>
        <span className="flex justify-between gap-3">
          <span className="min-w-0 truncate text-sm font-medium">{title}</span>
          <span className={cn("shrink-0 text-compact tabular-nums", cost === MISSING && "text-orb-muted")}>{cost}</span>
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <ModelPill model={model} />
          {call.status !== "succeeded" && <StatusPill status={call.status} />}
        </span>
        <span className="text-xs text-orb-muted tabular-nums">{formatClock(call.startedAt)} · {describeTokens(call)}</span>
      </span>
    </button>
  );
}

/** The model a call went to, as a pill in the monospace it is written in. */
function ModelPill({ model }) {
  return (
    <Pill className="max-w-full font-mono" title={model ?? undefined}>
      <span className="min-w-0 truncate">{model ?? MISSING}</span>
    </Pill>
  );
}

/** How a call stands, as a pill: quiet when it succeeded, lime and pulsing while working, coral when it failed. */
function StatusPill({ status }) {
  if (status === "running") return <Pill tone="lime" dot pulse>working now</Pill>;
  if (status === "failed") return <Pill tone="coral" dot>failed</Pill>;
  return <Pill tone="muted">succeeded</Pill>;
}

/** The status column: the pill, and under a failure the code it failed with. */
function StatusCell({ call }) {
  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      <StatusPill status={call.status} />
      {call.status === "failed" && (
        <span className="inline-flex max-w-full items-center gap-1 font-mono text-2xs leading-4 text-orb-muted" title={call.error?.message ?? undefined}>
          <AlertCircle aria-hidden="true" className="size-3 shrink-0 text-orb-coral" />
          <span className="truncate">{call.error?.code ?? MISSING}</span>
        </span>
      )}
    </span>
  );
}

/** Spend per model as bars against the largest, so the expensive model is obvious at a glance. */
function SpendByModel({ rows }) {
  const largest = Math.max(0, ...rows.map((row) => row.costUsd));
  return (
    <Panel className="hidden px-4 py-3 sm:block sm:px-4 sm:py-3">
      <PanelTitle as="p">Spend by model</PanelTitle>
      {rows.length === 0 ? (
        <p className="text-xs text-orb-muted">No calls in this period.</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {rows.map((row) => (
            <li key={row.model ?? "unknown"} className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_4.5rem] items-center gap-2.5">
              <span className="truncate font-mono text-xs text-orb-gray" title={row.model ?? undefined}>{row.model ?? MISSING}</span>
              <span aria-hidden="true" className="block h-1.5 rounded-full bg-orb-line/60">
                <span
                  className="block h-1.5 rounded-full bg-orb-cyan/70"
                  style={{ width: `${largest > 0 ? Math.max(2, Math.round((row.costUsd / largest) * 100)) : 0}%` }}
                />
              </span>
              <span className="text-right text-xs text-orb-white tabular-nums">{formatCost(row.costUsd)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * A filter as a pill: its name, then what it is set to.
 *
 * "All" is a real option rather than an empty selection, so the pill always says what it is doing
 * and choosing it again is how a filter is cleared.
 */
function FilterSelect({ label, value, onChange, options }) {
  const items = [{ value: ALL, label: "All" }, ...options];
  return (
    <Select items={items} value={value} onValueChange={(next) => onChange(next ?? ALL)}>
      <SelectTrigger className="h-[34px] w-full justify-start rounded-3xl border-orb-line bg-orb-space/70 pr-2.5 pl-3.5 text-compact text-orb-white hover:bg-orb-raised lg:w-fit [&>svg]:ml-auto [&>svg]:text-orb-muted">
        <span className="text-orb-muted">{label}</span>
        <SelectValue className="min-w-0 truncate" />
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false} className="min-w-44">
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}


/** Whether a media query matches, kept current as the window is resized. */
function useMediaQuery(query) {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
