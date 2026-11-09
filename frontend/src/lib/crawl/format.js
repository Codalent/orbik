/**
 * How crawl figures and times are worded, in one place.
 *
 * The topbar, the summary and the logs panel all describe the same run, and three copies of
 * "4 minutes ago" would drift into three different vocabularies for one thing. A person reading
 * the topbar and then opening the logs should see the same crawl described the same way.
 */

/** Formats a date the way a sentence would carry it. */
export function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "long" });
}

/** Formats a date and time, for a log where two runs on one day must be told apart. */
export function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/**
 * Says how long ago something happened in the terms a person would use.
 *
 * An exact timestamp is precise and unhelpful: "4 minutes ago" answers "is this current?", which
 * is the only question being asked of it here.
 */
function describeElapsed(value, { started = false } = {}) {
  const elapsedMs = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "";

  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return started ? "started just now" : "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Describes when a run happened, choosing the moment that answers "is this current?". */
export function describeRunTiming(run) {
  return describeElapsed(run.finishedAt ?? run.startedAt, { started: !run.finishedAt });
}

/** Says when the next crawl is due in relative terms, which is what the question is really about. */
export function describeNextCrawl(nextCrawlAt) {
  const ms = new Date(nextCrawlAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "shortly";
  const hours = Math.round(ms / 3_600_000);
  if (hours < 1) return "within the hour";
  if (hours < 48) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  return `in ${Math.round(hours / 24)} days`;
}

/** States how long a run took, rounded to a unit somebody would say out loud. */
export function describeDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "";
  if (durationMs < 1000) return `${durationMs} ms`;
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  return `${Math.round(minutes / 60)}h`;
}

/**
 * Names a crawl frequency the way a person would choose it.
 *
 * Null is "never": a page without a frequency is fetched when it is discovered and then only when
 * somebody asks. An interval that matches none of the offered choices — the AI can pick any
 * number of hours — is spelled out in hours or days rather than rounded to the nearest choice,
 * so what is shown is what the crawler will actually do.
 *
 * @param {number|null|undefined} intervalHours
 * @returns {string}
 */
export function describeFrequency(intervalHours) {
  if (intervalHours === null) return "Manual";
  if (!Number.isFinite(intervalHours)) return "";
  if (intervalHours === 24) return "Daily";
  if (intervalHours === 168) return "Weekly";
  if (intervalHours === 720) return "Monthly";
  if (intervalHours < 48) return `Every ${intervalHours} hours`;
  return `Every ${Math.round(intervalHours / 24)} days`;
}
