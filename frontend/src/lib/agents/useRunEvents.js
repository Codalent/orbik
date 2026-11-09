"use client";

import { useEffect, useEffectEvent, useRef } from "react";

import { listRunEvents } from "@/lib/api/runs";
import { TERMINAL_RUN_STATUSES } from "./runEvents";

/** How often a run in flight is polled for events, unless the caller says otherwise. */
const POLL_INTERVAL_MS = 2000;

/**
 * Follows one run's event log while the run is going: the cursor, the interval, and noticing that
 * it has ended.
 *
 * Every view that watches a run reads its events this way, so this is the one loop that does it.
 * The events themselves stay with the caller, because each holds them differently — the agent
 * pages keep a run's whole log and open past runs with what they already have, while the ask page
 * keeps only the steps of the question in flight — and a run's events are a stream read by cursor
 * and appended to rather than a resource with a current value, so they are not a cached read.
 *
 * The end of a run is handled with care. A caller that records it — sets `complete`, clears the
 * question in flight — changes what it passes here, which ends this effect; if that ended the
 * handling too, the read that follows the end (the run's outcome, the answer) would be thrown away
 * the moment it arrived and the screen would never catch up. So the interval is stopped by hand
 * and `onComplete` runs to the end, asking `isCurrent()` before touching the screen: it is false
 * once another run is being watched or the view has gone, and is not affected by `active`.
 *
 * @param {object} options
 * @param {string} options.workspaceId
 * @param {string|null} options.runId the run to watch, or null for none
 * @param {boolean} [options.active] whether the run is still going; a finished run is not polled
 * @param {number} [options.after] the last event already in hand, read when watching begins
 * @param {number} [options.intervalMs] how often to ask
 * @param {(items: object[]) => void} [options.onEvents] receives new events, oldest first
 * @param {(runId: string, isCurrent: () => boolean) => (void|Promise<void>)} [options.onComplete]
 *   called once when the run has ended, after its last events
 * @param {(failure: Error) => void} [options.onError] a read, or `onComplete`, failed; polling
 *   carries on unless the caller stops watching
 */
export function useRunEvents({
  workspaceId,
  runId,
  active = true,
  after = 0,
  intervalMs = POLL_INTERVAL_MS,
  onEvents,
  onComplete,
  onError,
}) {
  // The run being watched as of the last render that reached the screen, so a slow completion can
  // tell whether what it read still belongs there.
  const watched = useRef(null);
  useEffect(() => {
    watched.current = runId;
    return () => { watched.current = null; };
  }, [runId]);

  const startingCursor = useEffectEvent(() => after);
  const deliver = useEffectEvent((items) => onEvents?.(items));
  const finish = useEffectEvent((id, isCurrent) => onComplete?.(id, isCurrent));
  const fail = useEffectEvent((failure) => onError?.(failure));

  useEffect(() => {
    if (!runId || !active) return undefined;
    const isCurrent = () => watched.current === runId;
    // Kept here rather than in state: it changes on every poll, and nothing displays it.
    let cursor = startingCursor();
    let stopped = false;
    const timer = setInterval(async () => {
      let page;
      try {
        page = await listRunEvents(workspaceId, runId, { after: cursor });
      } catch (failure) {
        if (!stopped) fail(failure);
        return;
      }
      if (stopped) return;
      if (page.items.length) {
        cursor = page.items.at(-1).seq;
        deliver(page.items);
      }
      if (!page.complete && !TERMINAL_RUN_STATUSES.includes(page.status)) return;
      clearInterval(timer);
      try {
        await finish(runId, isCurrent);
      } catch (failure) {
        if (isCurrent()) fail(failure);
      }
    }, intervalMs);
    return () => { stopped = true; clearInterval(timer); };
  }, [workspaceId, runId, active, intervalMs]);
}
