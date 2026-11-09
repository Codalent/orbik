"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";

import * as runsApi from "@/lib/api/runs";
import * as setupApi from "@/lib/api/agentSetup";
import { TERMINAL_RUN_STATUSES } from "./runEvents";
import { useRunEvents } from "./useRunEvents";

/** How often we look for a run the scheduler started, while the agent is set to work. */
const SCHEDULE_REFRESH_MS = 30_000;

/** How many recent runs an agent's head reads. */
const RUNS_LIMIT = 5;

/**
 * Watching one scheduled agent: what it is, whether it is working, and what it is doing now.
 *
 * Lifted out of the old agent work panel when the Library stopped wanting its shape. The Library
 * puts these same four facts in its header and its right rail instead of in a card, and two copies
 * of run polling — one of them subtly behind — is exactly the kind of difference nobody notices
 * until the two disagree on screen. Every agent page draws it in its head (`AgentPage`); this hook
 * is only the machinery underneath.
 *
 * The agent's setup and its recent runs are cached reads, so they are re-read when the tab is
 * looked at again and shared with anything else showing them. A run's events are not: they are a
 * stream read by cursor and appended to, which is a different thing from a resource with a
 * current value, and `useRunEvents` follows them.
 *
 * @param {object} options
 * @param {string} options.workspaceId
 * @param {string} options.agentSlug
 * @param {(agent: object) => void} [options.onAgent] receives the agent definition once it loads
 * @param {() => void} [options.onFinished] called when a run reaches a terminal state
 */
export function useAgentWork({ workspaceId, agentSlug, onAgent, onFinished }) {
  const [run, setRun] = useState(null);
  const [events, setEvents] = useState([]);
  const [complete, setComplete] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  // The run on screen, readable from an effect without making that effect re-run when it changes.
  const shownRunId = useRef(null);

  const report = useCallback((failure) => {
    setActionError(failure?.message ?? "Something went wrong. Try again.");
  }, []);

  const setupRead = useSWR(setupApi.agentSetupPath(workspaceId, agentSlug));
  const agent = setupRead.data?.agent ?? null;
  const setup = setupRead.data?.setup ?? null;
  const readiness = setupRead.data?.readiness ?? null;
  const working = Boolean(setup?.working);
  const inFlight = Boolean(run && !complete);

  // While the agent is set to work and nothing is in flight, look now and then for a run the
  // scheduler started. A run in flight needs no such look: its own events are being polled.
  const runsRead = useSWR(runsApi.runsPath(workspaceId, { agent: agentSlug, limit: RUNS_LIMIT }), {
    refreshInterval: working && !inFlight ? SCHEDULE_REFRESH_MS : 0,
  });
  const history = runsRead.data?.items;
  const runsLoaded = Boolean(history);
  /** The run worth showing: one in flight, or the most recent. */
  const latest = history?.find((entry) => !TERMINAL_RUN_STATUSES.includes(entry.status))
    ?? history?.[0]
    ?? null;
  const latestId = latest?.id ?? null;

  useEffect(() => {
    if (agent) onAgent?.(agent);
  }, [agent, onAgent]);

  /** Shows one run and loads the events it already has. */
  const showRun = useCallback(async (runId) => {
    shownRunId.current = runId;
    const detail = await runsApi.getRun(workspaceId, runId);
    const page = await runsApi.listRunEvents(workspaceId, runId, { after: 0, limit: 500 });
    // Another run was chosen while this one was being read; its reader owns the screen now.
    if (shownRunId.current !== runId) return;
    setRun(detail.run);
    setEvents(page.items);
    setComplete(page.complete);
  }, [workspaceId]);

  // Adopts the latest run to show whenever the list names one that is not already on screen — on
  // first load, and when the scheduler has started one since.
  useEffect(() => {
    if (!runsLoaded) return;
    if (latestId && latestId !== shownRunId.current) showRun(latestId).catch(report);
  }, [runsLoaded, latestId, showRun, report]);

  const mutateSetup = setupRead.mutate;
  const mutateRuns = runsRead.mutate;

  // Polls only while a run is in flight; a finished run's events never change.
  useRunEvents({
    workspaceId,
    runId: run?.id ?? null,
    active: !complete,
    after: events.at(-1)?.seq ?? 0,
    onEvents: (items) => setEvents((current) => [...current, ...items]),
    onComplete: async (runId, isCurrent) => {
      setComplete(true);
      const detail = await runsApi.getRun(workspaceId, runId);
      if (!isCurrent()) return;
      setRun(detail.run);
      // A finished run moved the schedule on and changed how the run list ends.
      await Promise.all([mutateSetup(), mutateRuns()]);
      onFinished?.();
    },
    onError: report,
  });

  /** Wraps an action with the busy flag and error reporting. */
  const act = useCallback(async (action) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (failure) {
      report(failure);
    } finally {
      setBusy(false);
    }
  }, [report]);

  /**
   * Starts a run, optionally with input.
   *
   * Kept apart from `runNow`, which is handed straight to a button and so is called with a click
   * event: an agent that takes input — the Design system agent's `{force: true}` — is started
   * through this, by a caller that says what the input is.
   */
  const runWith = useCallback((input) => act(async () => {
    // A fresh key per attempt: a retry of a request that may have succeeded returns the original
    // run rather than starting — and paying for — a second one.
    const response = await runsApi.createRun(
      workspaceId,
      { agentSlug, input: input && typeof input === "object" ? input : undefined },
      crypto.randomUUID(),
    );
    shownRunId.current = response.run.id;
    setEvents([]);
    setComplete(false);
    setRun(response.run);
  }), [act, agentSlug, workspaceId]);

  /** Starts a run with no input: what a Run now button does. */
  const runNow = useCallback(() => runWith(), [runWith]);

  /** Puts the setup a write returned into the cache, which is the server's own answer. */
  const adoptSetup = useCallback(
    (next) => mutateSetup((current) => (current ? { ...current, setup: next } : current), { revalidate: false }),
    [mutateSetup],
  );

  const toggleWorking = useCallback(() => act(async () => {
    const response = await setupApi.setAgentWorking(workspaceId, agentSlug, !working);
    await adoptSetup(response.setup);
  }), [act, adoptSetup, agentSlug, working, workspaceId]);

  const stop = useCallback(() => act(async () => {
    const response = await runsApi.cancelRun(workspaceId, run.id);
    setRun((current) => ({ ...current, ...response.run }));
    if (response.stopped) setComplete(true);
  }), [act, run, workspaceId]);

  // A failed read is only worth an error while there is nothing to show for it; a failed re-read
  // leaves what was last known on screen and tries again on the next focus or poll.
  const readFailure = (!setupRead.data && setupRead.error) || (!runsRead.data && runsRead.error) || null;
  const loading = (!setupRead.data && !setupRead.error) || (!runsRead.data && !runsRead.error);

  return {
    agent,
    setup,
    readiness,
    runs: history,
    loading,
    run,
    events,
    complete,
    busy,
    error: actionError ?? readFailure?.message ?? null,
    inFlight,
    working,
    runNow,
    runWith,
    toggleWorking,
    stop,
    adoptSetup,
  };
}
