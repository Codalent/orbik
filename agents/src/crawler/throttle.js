import { AgentError } from "../runtime/errors.js";

/**
 * Statuses by which a server says "not now" rather than "not found" or "broken".
 *
 * 429 is the rate-limit status by definition. 503 is included because that is what most
 * overloaded servers — and several bot-protection products — answer with, and because a server
 * that is struggling deserves the same pause as one that is refusing.
 */
export const THROTTLE_STATUSES = Object.freeze(new Set([429, 503]));

/**
 * How many throttled responses in a row a run tolerates before it stops crawling the site.
 *
 * A hold stops every request to the host once it begins, so a refusal is followed by another
 * only after the hold has expired — or by the few requests that were already on their way when
 * it began, which with several pages in flight can be as many as the worker runs at once. Ten in
 * a row therefore means the site has been refusing through several holds, minutes at the default,
 * and is not about to stop. Carrying on past that point would spend the month's crawl budget on
 * refusals and teach the site's rate limiter that this address does not take a hint, which is
 * how a soft limit becomes a hard block on every workspace that shares the address.
 */
const THROTTLE_ABORT_AFTER = 10;

/**
 * Reports whether a run has been stopped because the site is rate limiting the crawler.
 *
 * Jobs check this before touching the network so that once a run is stopped, the thousands of
 * fetch jobs still queued for it drain as no-ops rather than each earning their own refusal.
 *
 * @param {import("mongodb").Collection} runs the `agent_runs` collection
 * @param {import("mongodb").ObjectId|null|undefined} runId run the job belongs to
 * @returns {Promise<boolean>} true when the run has been stopped for rate limiting
 */
export async function isRunRateLimited(runs, runId) {
  if (!runId) return false;
  const run = await runs.findOne({ _id: runId }, { projection: { "throttle.abortedAt": 1 } });
  return Boolean(run?.throttle?.abortedAt);
}

/**
 * Records one throttled response against its run and decides whether the run should stop.
 *
 * The count is kept on the run document with `$inc` because many workers report on the same run
 * at once, and it is reset by {@link recordServed} the moment any page is served normally: the
 * signal being watched is an unbroken streak of refusals, not a total.
 *
 * @param {object} input what happened
 * @param {import("mongodb").Collection} input.runs the `agent_runs` collection
 * @param {import("mongodb").ObjectId|null|undefined} input.runId run the job belongs to
 * @param {number} input.status the 429 or 503 received
 * @param {string} input.url page that was refused
 * @param {number|null} input.retryAfterMs how long the host is now being left alone
 * @returns {Promise<{consecutive: number, aborted: boolean}>} the streak, and whether this
 *   response was the one that stopped the run
 */
export async function recordThrottled({ runs, runId, status, url, retryAfterMs }) {
  if (!runId) return { consecutive: 0, aborted: false };
  const now = new Date();
  const run = await runs.findOneAndUpdate(
    { _id: runId },
    {
      $inc: { "throttle.consecutive": 1, "counters.pagesThrottled": 1 },
      $set: {
        "throttle.lastStatus": status,
        "throttle.lastUrl": url,
        "throttle.lastRetryAfterMs": retryAfterMs ?? null,
        "throttle.lastAt": now,
        updatedAt: now,
      },
    },
    { returnDocument: "after", projection: { throttle: 1 } },
  );
  const consecutive = run?.throttle?.consecutive ?? 0;
  if (consecutive < THROTTLE_ABORT_AFTER || run?.throttle?.abortedAt) return { consecutive, aborted: false };

  // The filter repeats the condition so two workers crossing the threshold together produce one
  // abort, not two, and so the recorded time is when the decision was actually made.
  const result = await runs.updateOne(
    { _id: runId, "throttle.abortedAt": { $exists: false } },
    { $set: { "throttle.abortedAt": now, "throttle.host": new URL(url).host, updatedAt: now } },
  );
  return { consecutive, aborted: result.modifiedCount === 1 };
}

/**
 * Notes that a page was served normally, ending any streak of refusals.
 *
 * The filter keeps this free for the common case: a run that has never been throttled has no
 * positive count to reset, so the write matches nothing and touches nothing.
 *
 * @param {import("mongodb").Collection} runs the `agent_runs` collection
 * @param {import("mongodb").ObjectId|null|undefined} runId run the job belongs to
 */
export async function recordServed(runs, runId) {
  if (!runId) return;
  await runs.updateOne(
    { _id: runId, "throttle.consecutive": { $gt: 0 } },
    { $set: { "throttle.consecutive": 0 } },
  );
}

/**
 * Whether a job may still be retried, read from the attempt counters the queue stamps on it.
 *
 * A job that arrives without them — a test, or a handler invoked by hand — is treated as
 * retryable, because the alternative is recording a refusal as if it were the page.
 *
 * @param {object} job the queue job being executed
 */
export function canRetry(job) {
  if (!Number.isInteger(job?.attempts) || !Number.isInteger(job?.maxAttempts)) return true;
  return job.attempts < job.maxAttempts;
}

/**
 * The failure that puts a throttled job back in the queue for exactly as long as the host asked.
 *
 * Two cases share it. With a `status`, this job's own request was refused, and that is one of its
 * attempts: the count is what lets a page that never stops refusing be recorded with the status it
 * gave. Without one, the host was already inside a hold and this job asked it for nothing, so it
 * waits out the hold with its attempts untouched. A hold stops every queued page of the site at
 * once, and each of them comes through here; if waiting cost an attempt, five holds anywhere in a
 * long crawl would dead-letter every page still queued behind them.
 *
 * @param {{status?: number, url: string, retryAfterMs: number}} input what was refused and for how long
 */
export function rateLimitedError({ status, url, retryAfterMs }) {
  const host = new URL(url).host;
  const seconds = Math.ceil(retryAfterMs / 1000);
  return new AgentError({
    code: "RATE_LIMITED",
    message: status
      ? `${host} answered ${status}; leaving it alone for ${seconds}s before retrying.`
      : `${host} asked the crawler to wait; retrying in ${seconds}s.`,
    retryable: true,
    retryAfterMs,
    consumesAttempt: Boolean(status),
  });
}

/**
 * The error a run is closed with when its site would not stop refusing requests.
 *
 * @param {object} throttle the run's `throttle` record
 * @param {number} unfetched pages the run left unfetched because it stopped
 */
export function rateLimitedRunError(throttle, unfetched) {
  const host = throttle?.host ?? "The site";
  const status = throttle?.lastStatus ?? 429;
  const left = unfetched > 0 ? ` ${unfetched.toLocaleString("en-US")} page(s) were left unfetched and will be tried again by the next crawl.` : "";
  return {
    code: "RATE_LIMITED",
    message: `${host} is rate limiting the crawler: ${THROTTLE_ABORT_AFTER} requests in a row were refused with HTTP ${status}, so the crawl was stopped.${left}`,
  };
}
