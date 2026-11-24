import { describeElapsed } from "@/lib/crawl/format";

/**
 * How the Sources pages word what the API says about a source. The API decides every state and
 * count (`state`, `pages`, `progress`); this only puts them into words and tones.
 */

/** How often a source's pages are read, as a person chooses it. `never` is "only when asked". */
export const SOURCE_FREQUENCIES = Object.freeze([
  { value: "24", intervalHours: 24, label: "Every day" },
  { value: "168", intervalHours: 168, label: "Every week" },
  { value: "720", intervalHours: 720, label: "Every month" },
  { value: "never", intervalHours: null, label: "Only when asked" },
]);

/** The select value for an interval. */
export function frequencyValue(intervalHours) {
  return SOURCE_FREQUENCIES.find((option) => option.intervalHours === intervalHours)?.value ?? "168";
}

/** The interval a select value stands for. */
export function frequencyInterval(value) {
  const option = SOURCE_FREQUENCIES.find((entry) => entry.value === value);
  return option ? option.intervalHours : 168;
}

/** Reads a month holds, at each frequency: what a page costs a month. */
const READS_PER_MONTH = Object.freeze({ 24: 30, 168: 4.3, 720: 1 });

/** "About 13 page fetches a month", for a source of `pages` pages read at `intervalHours`. */
export function describeMonthlyCost(pages, intervalHours) {
  if (intervalHours === null) return "Read only when you ask: no page is fetched on a timer.";
  const fetches = Math.max(1, Math.round(pages * (READS_PER_MONTH[intervalHours] ?? 4.3)));
  return `About ${fetches.toLocaleString("en-US")} page fetch${fetches === 1 ? "" : "es"} a month`;
}

/** The frequency in a source's one-line description: "weekly", "daily", "when asked". */
export function frequencyWord(intervalHours, { primary = false } = {}) {
  const word = intervalHours === 24 ? "daily" : intervalHours === 168 ? "weekly" : intervalHours === 720 ? "monthly" : "when asked";
  // The website's pages each keep the frequency chosen for them on its page list.
  return primary ? `${word === "when asked" ? "weekly visits" : word}, or per page` : word;
}

/** States that are something happening, which the page re-reads more often. */
export const LIVE_STATES = Object.freeze(["queued", "reading", "first-read"]);

/** Whether a source is being read, or about to be. */
export function isLive(source) {
  return LIVE_STATES.includes(source?.state);
}

/** States that want a person's attention. */
export const ATTENTION_STATES = Object.freeze(["refused", "rate-limited", "failed"]);

/**
 * A source's state as a short line and a tone: lime for read and moving, orange for a choice or a
 * pause waiting, coral for a refusal or a failure, muted for nothing yet.
 *
 * @returns {{label: string, tone: "lime"|"orange"|"coral"|"muted", pulse: boolean}}
 */
export function describeState(source) {
  const when = source.lastReadAt ? describeElapsed(source.lastReadAt) : "";
  // A first read finds every page new; "changed" is said only of a read that found some pages as
  // they were.
  const counters = source.latestRun?.counters ?? {};
  const read = (counters.pagesFetched ?? 0) + (counters.pagesNotModified ?? 0);
  const changed = (counters.pagesChanged ?? 0) < read ? (counters.pagesChanged ?? 0) : 0;
  switch (source.state) {
    case "first-read":
      return { label: "First crawl · copying pages", tone: "lime", pulse: true };
    case "reading": {
      const total = (source.progress?.fetched ?? 0) + (source.progress?.outstanding ?? 0);
      return { label: total ? `Reading · ${source.progress.fetched.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}` : "Reading", tone: "lime", pulse: true };
    }
    case "queued":
      return { label: "Queued · starts within a minute", tone: "orange", pulse: true };
    case "refused":
      return { label: `Refused · the site answered ${source.latestRun?.block?.status ?? 403}`, tone: "coral", pulse: false };
    case "rate-limited":
      return { label: "Stopped · the site asked for fewer requests", tone: "coral", pulse: false };
    case "failed":
      return { label: "The last read failed", tone: "coral", pulse: false };
    case "stopped":
      return { label: `Stopped${when ? ` · ${when}` : ""}`, tone: "muted", pulse: false };
    case "out-of-budget":
      return { label: "Stopped: out of crawl pages", tone: "orange", pulse: false };
    case "never-read":
      return { label: "Not read yet", tone: "muted", pulse: false };
    default:
      if (!source.primary && changed > 0 && source.pages?.copied) {
        return { label: `${changed.toLocaleString("en-US")} page${changed === 1 ? "" : "s"} changed${when ? ` · ${when}` : ""}`, tone: "lime", pulse: false };
      }
      return { label: `Up to date${when ? ` · read ${when}` : ""}`, tone: "lime", pulse: false };
  }
}

/** The short pill beside a source's name that says what it is to the workspace. */
export function describeRelation(source, websiteHost) {
  if (source.primary) return "Main website";
  if (source.relation === "elsewhere") return "About you elsewhere";
  const domain = String(websiteHost ?? "").replace(/^www\./, "");
  return domain && source.host?.endsWith(`.${domain}`) ? "Subdomain" : "A site of yours";
}

/** What a source reads, as a phrase: "whole site", "/guides/ only", "3 pages". */
export function describeScope(source) {
  if (source.mode === "pages") {
    const pages = source.pageUrls?.length ?? 0;
    const listed = pages === 1 ? "1 page" : `${pages} pages`;
    return source.followPagination ? `${listed} and their next pages` : listed;
  }
  const left = source.excludePatterns?.length ?? 0;
  const out = left ? `, ${left} path${left === 1 ? "" : "s"} left out` : "";
  return source.mode === "section" ? `${source.section} only${out}` : `whole site${out}`;
}

/** A source's one line under its name: where, how much, what kind, how often. */
export function describeSourceLine(source) {
  const where = source.mode === "pages" ? shortUrl(source.pageUrls?.[0] ?? source.seedUrl) : source.host;
  return [where, describeScope(source), source.purposeLabel?.toLowerCase(), frequencyWord(source.pageIntervalHours, { primary: source.primary })]
    .filter(Boolean)
    .join(" · ");
}

/** An address without its scheme or trailing slash: `clutch.co/profile/acme`. */
export function shortUrl(url) {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`.replace(/\/$/, "");
    return `${parsed.host.replace(/^www\./, "")}${path}`;
  } catch {
    return url ?? "";
  }
}

/** The pages column of a source's row: "412 pages", or "64 of 186" while it is read. */
export function describePages(source) {
  if (source.progress && (source.progress.fetched || source.progress.outstanding)) {
    const total = source.progress.fetched + source.progress.outstanding;
    return { value: source.progress.fetched, of: total };
  }
  return { value: source.pages?.copied ?? 0, of: null };
}

/** A Library path as the Library page's address. */
export function libraryHref(workspaceId, path) {
  return `/workspaces/${workspaceId}/library?path=${encodeURIComponent(path)}`;
}

/** The address of one source's page; the website's is `website`. */
export function sourceHref(workspaceId, source) {
  return `/workspaces/${workspaceId}/sources/${source.primary ? "website" : source.id}`;
}
