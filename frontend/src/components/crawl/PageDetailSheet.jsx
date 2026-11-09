"use client";

import { useState } from "react";
import useSWR from "swr";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { crawlPagePath, getCrawlPageMarkdown, recrawlPages, setCrawlPageSchedule } from "@/lib/api/crawl";
import { describeFrequency } from "@/lib/crawl/format";
import { PATTERN_FREQUENCIES, frequencyToInterval, intervalToFrequency } from "@/lib/validation/crawl";
import { cn } from "@/lib/utils";

/** The frequency picker's item for "no setting of its own, follow the pattern". */
const INHERIT = "inherit";

/** Plain-language readings of the crawler's indexability codes. */
const REASON_LABELS = Object.freeze({
  INDEXABLE: "Indexable",
  STATUS_NOT_FOUND: "Page not found",
  STATUS_SERVER_ERROR: "Server error",
  STATUS_NOT_OK: "Unexpected status",
  REDIRECTED: "Redirects elsewhere",
  TOO_MANY_REDIRECTS: "Redirects in a loop, or too many times",
  ROBOTS_DISALLOWED: "Blocked by robots.txt",
  META_NOINDEX: "noindex in the page",
  HEADER_NOINDEX: "noindex in the response header",
  CANONICAL_TO_OTHER: "Canonical points elsewhere",
  NOT_HTML: "Not an HTML page",
});

/** Why one URL was folded into another, said the way a person would say it. */
const VARIANT_LABELS = Object.freeze({
  REDIRECTS_TO: "redirects here",
  CANONICAL_TO: "declares this its canonical",
  IDENTICAL_TEXT: "serves identical content",
});

/** Where a URL was first learned about. */
const SOURCE_LABELS = Object.freeze({
  seed: "the starting URL",
  sitemap: "the sitemap",
  link: "an internal link",
  robots: "robots.txt",
});

/**
 * Shows everything one crawl recorded about a single page.
 *
 * All of it was already being stored and thrown away by the list projection — the headings, the
 * hreflang set, the structured data types, the images missing alt text, the redirect chain, the
 * response size and timing. The only genuinely new question this asks is which pages link here,
 * which the link graph has been indexed for since it was built and which nothing had ever read.
 *
 * @param {object} props
 * @param {string} props.workspaceId workspace the page belongs to
 * @param {string|null} props.urlHash page to show, or null when the panel is closed
 * @param {() => void} props.onClose closes the panel
 */
export function PageDetailSheet({ workspaceId, urlHash, onClose, canCrawl = true }) {
  // Cached by the page's own path, so the panel for another page never shows this one's record,
  // and reopening a page shows what was last known while it is read again.
  const { data: loaded = null, error, mutate } = useSWR(urlHash ? crawlPagePath(workspaceId, urlHash) : null);
  const failed = Boolean(error) && !loaded;
  const page = loaded?.page ?? null;

  /** Applies a frequency change and shows the answer the server settled on. */
  async function changeSchedule(override) {
    const result = await setCrawlPageSchedule(workspaceId, urlHash, override);
    await mutate((current) => (current ? { ...current, schedule: result.schedule } : current), { revalidate: false });
  }

  /** Asks for this one page to be fetched on the next pass. */
  async function recrawl() {
    await recrawlPages(workspaceId, { urlHash });
    await mutate();
  }

  return (
    <Sheet open={Boolean(urlHash)} onOpenChange={(open) => { if (!open) onClose(); }}>
      {/*
        Full height by default; the width override is what makes this a working panel rather than
        the narrow drawer the base component ships — a page's detail is dense, and reading a URL
        and its inbound anchors in `max-w-sm` means wrapping every line.
      */}
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-y-auto border-orb-line bg-orb-space p-0 sm:w-[40%] sm:min-w-[26rem] data-[side=right]:sm:max-w-[46rem]"
      >
        <SheetHeader className="gap-1 border-b border-orb-line p-5 pr-14">
          <SheetTitle className="font-mono text-sm break-all text-orb-white">
            {page ? displayPath(page.url) : "Page"}
          </SheetTitle>
          <SheetDescription className="text-orb-muted">
            {page?.title ?? (failed ? "This page could not be loaded." : "Loading…")}
          </SheetDescription>
        </SheetHeader>

        {page && (
          <div className="flex flex-col gap-6 p-5">
            <Verdict page={page} />
            {loaded.schedule && page.eligible && (
              <Schedule page={page} schedule={loaded.schedule} onChange={changeSchedule} onRecrawl={recrawl} editable={canCrawl} />
            )}
            <Variants variants={loaded.variants} />
            <Content page={page} />
            <Technical page={page} />
            <Markdown key={page.urlHash} workspaceId={workspaceId} urlHash={page.urlHash} summary={loaded.markdown ?? null} />
            <Links inbound={loaded.inbound} outbound={loaded.outbound} page={page} />
            <History history={loaded.history} />
            <Discovery page={page} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** The two facts somebody opens this panel to check first. */
function Verdict({ page }) {
  const broken = typeof page.status === "number" && page.status >= 400;
  return (
    <div className="flex flex-wrap gap-1.5">
      {page.status === null
        ? <Badge tone="muted">Not crawled yet</Badge>
        : <Badge tone={broken ? "bad" : "good"}>{page.status}</Badge>}
      {page.status !== null && (
        <Badge tone={page.indexable ? "good" : "warn"}>
          {page.indexable
            ? "Indexable"
            : (page.indexabilityReasons.map((reason) => REASON_LABELS[reason] ?? reason).join(", ") || "Not indexable")}
        </Badge>
      )}
      {page.depth !== null && <Badge tone="muted">{page.depth} {page.depth === 1 ? "click" : "clicks"} from home</Badge>}
      {page.orphan && <Badge tone="warn">Nothing links here</Badge>}
      {page.isVariant && <Badge tone="muted">Duplicate of another URL</Badge>}
    </div>
  );
}

/**
 * How often this page is recrawled, and the two ways to change that.
 *
 * The frequency is a choice with a default, and the default is named — "same as /blog/[slug]" —
 * so following the pattern is something a person can pick rather than the absence of a pick.
 * "Crawl now" sits beside it because it is the other half of "never": a page left off the timer
 * still needs a way to be fetched, and this is it.
 */
function Schedule({ page, schedule, onChange, onRecrawl, editable = true }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const value = schedule.override ? intervalToFrequency(schedule.override.intervalHours) : "";
  const inherited = page.routePattern
    ? `Same as ${page.routePattern} (${describeFrequency(schedule.patternIntervalHours)})`
    : "Manual trigger";
  const pending = schedule.recrawlRequestedAt
    && (!page.lastCrawledAt || new Date(schedule.recrawlRequestedAt) > new Date(page.lastCrawledAt));

  /** Runs one change, reporting a failure in place rather than losing it. */
  async function attempt(action, failure) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch {
      setNotice(failure);
    } finally {
      setBusy(false);
    }
  }

  const described = schedule.intervalHours === null
    ? "Not recrawled on a timer. Use Crawl now when it changes."
    : `Recrawled ${describeFrequency(schedule.intervalHours).toLowerCase()}.`;

  // Somebody whose role may not crawl is told how often the page is fetched, and offered neither
  // way to change it.
  if (!editable) {
    return (
      <Section title="Crawl frequency">
        <p className="text-xs text-orb-muted">
          {schedule.intervalHours === null ? "Not recrawled on a timer." : described}
        </p>
      </Section>
    );
  }

  return (
    <Section title="Crawl frequency">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="page-frequency" className="sr-only">Crawl frequency</label>
        {/* The page's own setting, or none — following its pattern. "None" is a named item rather
            than an empty value, which the Select would read as nothing chosen. */}
        <Select
          items={[{ value: INHERIT, label: inherited }, ...PATTERN_FREQUENCIES]}
          value={value === "" ? INHERIT : value}
          disabled={busy}
          onValueChange={(next) => {
            if (!next) return;
            attempt(
              () => onChange(next === INHERIT ? null : { intervalHours: frequencyToInterval(next) }),
              "The frequency could not be changed. Try again.",
            );
          }}
        >
          <SelectTrigger id="page-frequency" size="sm" className={cn("min-w-0 flex-1 text-xs", schedule.intervalHours === null && "text-orb-orange")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>{inherited}</SelectItem>
            {PATTERN_FREQUENCIES.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy || Boolean(pending)}
          onClick={() => attempt(onRecrawl, "The crawl could not be requested. Try again.")}
        >
          {pending ? "Crawl queued" : "Crawl now"}
        </Button>
      </div>
      <p className="mt-2 text-xs text-orb-muted">{described}</p>
      {notice && <p role="alert" className="mt-1 text-xs text-orb-coral">{notice}</p>}
    </Section>
  );
}

/** The other URLs that are really this page. */
function Variants({ variants }) {
  if (!variants.length) return null;
  return (
    <Section title={`${variants.length} other ${variants.length === 1 ? "URL is" : "URLs are"} this same page`}>
      <ul className="flex flex-col gap-1.5">
        {variants.map((variant) => (
          <li key={variant.urlHash} className="flex flex-wrap items-baseline gap-x-2 text-xs">
            <span className="font-mono break-all text-orb-gray">{displayPath(variant.url)}</span>
            <span className="text-orb-muted">{VARIANT_LABELS[variant.reason] ?? "is a duplicate"}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** What the page says, and how much of it there is. */
function Content({ page }) {
  return (
    <Section title="Content">
      <Rows
        rows={[
          ["Title", page.title ? `${page.title} · ${page.titleLength} chars` : "Missing", !page.title],
          [
            "Description",
            page.metaDescription ? `${page.metaDescriptionLength} chars` : "Missing",
            !page.metaDescription,
          ],
          ["H1", page.headings.h1.length ? page.headings.h1.join(" · ") : "Missing", !page.headings.h1.length],
          ["Words", page.wordCount.toLocaleString(), false],
          [
            "Images",
            page.images ? `${page.images.total} · ${page.images.missingAlt} missing alt` : "—",
            Boolean(page.images?.missingAlt),
          ],
        ]}
      />
      {page.headings.h2.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-orb-cyan">Heading outline</summary>
          <ul className="mt-2 flex flex-col gap-1 text-xs text-orb-gray">
            {page.headings.h2.map((heading, index) => (
              <li key={`h2-${index}`} className="truncate">H2 · {heading}</li>
            ))}
          </ul>
        </details>
      )}
    </Section>
  );
}

/** What a search engine would make of the page's markup and headers. */
function Technical({ page }) {
  return (
    <Section title="Technical">
      <Rows
        rows={[
          ["Canonical", page.selfCanonical === true ? "Self" : page.canonicalUrl ? displayPath(page.canonicalUrl) : "None", page.selfCanonical === false],
          ["Meta robots", page.metaRobots.length ? page.metaRobots.join(", ") : "—", false],
          ["Language", page.lang ?? "—", false],
          ["Hreflang", page.hreflang.length ? `${page.hreflang.length} alternates` : "—", false],
          ["Schema", page.structuredDataTypes.length ? page.structuredDataTypes.join(", ") : "None", false],
          ["Redirects", page.redirects.length ? `${page.redirects.length} hops to ${displayPath(page.finalUrl)}` : "None", page.redirects.length > 2],
          [
            "Response",
            page.bytes !== null ? `${formatBytes(page.bytes)} · ${page.elapsedMs} ms` : "—",
            false,
          ],
        ]}
      />
    </Section>
  );
}

/** Who links here, and where this page points.  */
function Links({ inbound, outbound, page }) {
  const internalOut = outbound.filter((link) => link.internal);
  return (
    <Section title={`Linked from ${page.inboundCount.toLocaleString()} ${page.inboundCount === 1 ? "page" : "pages"}`}>
      {inbound.length === 0 ? (
        <p className="text-xs text-orb-muted">
          {/* An orphan page is the finding here, so it is stated rather than left as an empty list. */}
          No page on this site links here.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {inbound.map((link) => (
            // The anchor follows the path rather than being pushed to the far edge: the words
            // somebody used to link here only mean anything read against the page they are on.
            <li key={link.urlHash} className="flex flex-wrap items-baseline gap-x-3 border-b border-orb-line/60 py-1 text-xs last:border-0">
              <span className="max-w-full truncate font-mono text-orb-gray">{displayPath(link.url)}</span>
              {link.anchor && <span className="italic text-orb-muted">“{link.anchor}”</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-orb-muted">
        Links out: {internalOut.length} internal, {outbound.length - internalOut.length} external.
      </p>
    </Section>
  );
}

/** The page across crawls, so "is this new" is answerable. */
function History({ history }) {
  if (history.length < 2) return null;
  const peak = Math.max(...history.map((entry) => entry.wordCount), 1);

  return (
    <Section title={`Last ${history.length} crawls`}>
      <div className="flex items-end gap-1" role="img" aria-label={`Word count across the last ${history.length} crawls`}>
        {history.map((entry, index) => {
          const changed = index > 0 && entry.textHash !== history[index - 1].textHash;
          return (
            <span
              key={entry.fetchedAt}
              title={`${new Date(entry.fetchedAt).toLocaleDateString()} · ${entry.status} · ${entry.wordCount} words`}
              style={{ height: `${Math.max(8, (entry.wordCount / peak) * 32)}px` }}
              className={cn(
                "w-2.5 shrink-0 rounded-t",
                entry.status >= 400 ? "bg-orb-coral" : changed ? "bg-orb-cyan" : "bg-orb-line",
              )}
            />
          );
        })}
      </div>
      <p className="mt-2 text-xs text-orb-muted">
        Cyan marks a crawl where the page&apos;s text changed.
      </p>
    </Section>
  );
}

/** How Orbik came to know about this page at all. */
function Discovery({ page }) {
  const sources = page.discoveredBy.map((source) => SOURCE_LABELS[source] ?? source);
  return (
    <Section title="Discovery">
      <Rows
        rows={[
          ["Found via", sources.length ? sources.join(", ") : "—", false],
          ["First seen", page.firstSeenAt ? new Date(page.firstSeenAt).toLocaleDateString() : "—", false],
          ["Last crawled", page.lastCrawledAt ? new Date(page.lastCrawledAt).toLocaleString() : "Never", !page.lastCrawledAt],
          ["Route", page.routePattern ?? "—", false],
          ...(page.sitemap?.lastmod ? [["Sitemap says", `changed ${page.sitemap.lastmod}`, false]] : []),
          ...(page.eligible ? [] : [["Not crawled because", page.scopeReason ?? "it is out of scope", true]]),
        ]}
      />
    </Section>
  );
}

/**
 * The page's content as Markdown: how much there is, and the text on request.
 *
 * The text is fetched when asked for rather than with the panel, because it is the largest thing
 * a page has and most visits to the panel are about status, links, or frequency. Once loaded it
 * stays, so hiding and showing costs nothing. Copy and download are the two things people do
 * with it — paste into a model, or keep the file.
 */
function Markdown({ workspaceId, urlHash, summary }) {
  const [text, setText] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  if (!summary) {
    return (
      <Section title="Markdown">
        <p className="text-xs text-orb-muted">Not rendered yet. It is written the next time this page is crawled.</p>
      </Section>
    );
  }

  /** Shows the text, fetching it the first time. */
  async function reveal() {
    if (text !== null) { setOpen((value) => !value); return; }
    setBusy(true);
    setNotice(null);
    try {
      setText(await getCrawlPageMarkdown(workspaceId, urlHash));
      setOpen(true);
    } catch {
      setNotice("The Markdown could not be loaded. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      const value = text ?? (await getCrawlPageMarkdown(workspaceId, urlHash));
      if (text === null) setText(value);
      await navigator.clipboard.writeText(value);
      setNotice("Copied.");
    } catch {
      setNotice("Copying is not available here. Show the text and copy it by hand.");
    }
  }

  /** Hands the browser a file. The link is built from the text already in memory. */
  async function download() {
    try {
      const value = text ?? (await getCrawlPageMarkdown(workspaceId, urlHash));
      if (text === null) setText(value);
      const blob = new Blob([value], { type: "text/markdown;charset=utf-8" });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `${(urlHash ?? "page").slice(0, 12)}.md`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch {
      setNotice("The Markdown could not be loaded. Try again.");
    }
  }

  return (
    <Section title="Markdown">
      <Rows
        rows={[
          ["Size", `${(summary.bytes / 1024).toFixed(1)} KB${summary.words ? ` · ${summary.words.toLocaleString()} words` : ""}${summary.truncated ? " · truncated" : ""}`, summary.truncated],
          ["Content changed", summary.updatedAt ? new Date(summary.updatedAt).toLocaleString() : "—", false],
        ]}
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={reveal} disabled={busy}>
          {busy ? "Loading…" : open ? "Hide text" : "Show text"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={copy}>Copy</Button>
        <Button type="button" variant="ghost" size="sm" onClick={download}>Download .md</Button>
        {notice && <span role="status" className="text-xs text-orb-muted">{notice}</span>}
      </div>
      {open && text !== null && (
        <pre className="mt-3 max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-orb-line bg-orb-black/40 p-3 font-mono text-[0.7rem] leading-relaxed text-orb-gray">{text}</pre>
      )}
    </Section>
  );
}

/** A titled block, so the panel reads as sections rather than one long list. */
function Section({ title, children }) {
  return (
    <section>
      <h3 className="border-b border-orb-line pb-1.5 font-mono text-[0.65rem] font-medium uppercase tracking-[0.14em] text-orb-muted">
        {title}
      </h3>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

/** Label and value pairs on a shared grid, so values line up down the panel. */
function Rows({ rows }) {
  return (
    <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
      {rows.map(([label, value, warn]) => (
        <div key={label} className="contents">
          <dt className="text-orb-muted">{label}</dt>
          <dd className={cn("m-0 font-mono break-words", warn ? "text-orb-orange" : "text-orb-white")}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A verdict badge. */
function Badge({ tone, children }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 font-mono text-[0.68rem]",
        tone === "good" && "bg-orb-lime/12 text-orb-lime",
        tone === "bad" && "bg-orb-coral/12 text-orb-coral",
        tone === "warn" && "bg-orb-orange/12 text-orb-orange",
        tone === "muted" && "bg-orb-raised text-orb-gray",
      )}
    >
      {children}
    </span>
  );
}

/**
 * Shows the part of a URL that distinguishes one page from another.
 *
 * Every URL in this panel shares one origin, so repeating it pushes the path — the only part that
 * differs — out of view.
 */
function displayPath(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url ?? "—";
  }
}

/** Formats a response size at the precision a person would quote it. */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
