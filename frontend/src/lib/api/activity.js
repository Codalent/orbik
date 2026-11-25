"use client";

import useSWR from "swr";

/**
 * Where live activity is read from — everything running on the account's behalf right now:
 * crawls, agent runs, model calls — and also its cache key.
 *
 * One request across every workspace, because the activity monitor that shows it sits in the
 * sidebar and is visible from every workspace.
 */
export const LIVE_ACTIVITY_PATH = "/v1/activity";

/** How often it is read while something is running, and while nothing is. */
const POLL_MS = Object.freeze({ active: 3000, idle: 15000 });

/**
 * What is running now, kept current by whatever on screen reads it.
 *
 * The shell's rail reads it on every page, for the dots on Library, Sources and Agents, and the
 * activity monitor reads it in the sidebars that have one. Each of them polls, so the read stays
 * current whichever is on screen: the rail once read it without polling, counting on the monitor
 * to, and on a page with no sidebar — the Library, Home — an agent that started there never got
 * its dot. Mounted together they share one cache entry, and each poll waits out the deduping
 * window, as long as the faster poll, so two timers never ask more than once every three seconds
 * between them. A read asked for at once (`mutate`) is not held back by it.
 *
 * The cadence is chosen from the latest answer, so the faster one starts on the read after
 * something goes live rather than after one idle-length wait. Polling slows when nothing is live,
 * so an idle page costs a request every fifteen seconds; a crawl being asked for, starting or
 * ending has it read at once (`useCrawlOverview`), so a short crawl is not missed between two slow
 * polls.
 *
 * @returns {{activity: object|null, failed: boolean}} the latest answer, null until one arrives;
 *   and whether the last read failed
 */
export function useLiveActivity() {
  const { data, error } = useSWR(LIVE_ACTIVITY_PATH, {
    refreshInterval: (latest) => (latest?.active ? POLL_MS.active : POLL_MS.idle),
    dedupingInterval: POLL_MS.active,
  });
  return { activity: data ?? null, failed: Boolean(error) };
}
