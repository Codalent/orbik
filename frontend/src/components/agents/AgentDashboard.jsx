"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NeutralLoading } from "@/components/NeutralLoading";
import { RunProgress } from "./RunProgress";
import * as runsApi from "@/lib/api/runs";
import { TERMINAL_RUN_STATUSES } from "@/lib/agents/runEvents";
import { useRunEvents } from "@/lib/agents/useRunEvents";
import { useCan } from "@/lib/workspaces/roles";

/**
 * Runs one agent for one workspace, and shows what happens.
 *
 * @param {object} props
 * @param {string} props.workspaceId workspace the run belongs to
 * @param {string} props.agentSlug agent to run
 */
export function AgentDashboard({ workspaceId, agentSlug }) {
  const [run, setRun] = useState(null);
  const [events, setEvents] = useState([]);
  const [complete, setComplete] = useState(false);
  const [starting, setStarting] = useState(false);
  const [actionError, setError] = useState(null);
  const canRun = useCan("member", workspaceId);

  // The catalog and the most recent run are cached reads: the catalog is shared with anything
  // else that lists agents, and the run is re-read when the tab is looked at again, which is how
  // a run started elsewhere shows up here.
  const catalogRead = useSWR(runsApi.AGENTS_PATH);
  const historyRead = useSWR(runsApi.runsPath(workspaceId, { agent: agentSlug, limit: 1 }));
  const agent = catalogRead.data?.items.find((entry) => entry.slug === agentSlug) ?? null;
  const latest = historyRead.data?.items[0] ?? null;
  const mutateHistory = historyRead.mutate;
  const readFailure = (!catalogRead.data && catalogRead.error) || (!historyRead.data && historyRead.error) || null;
  const loading = !(catalogRead.data || catalogRead.error) || !(historyRead.data || historyRead.error);
  const error = actionError ?? readFailure?.message ?? null;

  // The most recent run is adopted when it is first seen, so refreshing the page during a
  // five-minute audit shows the audit rather than an empty form suggesting nothing is happening.
  // Adjusted during render rather than in an effect, which is React's own answer to state that
  // follows something read: an effect would paint the empty form first and then replace it.
  const [adopted, setAdopted] = useState(null);
  if (latest && latest.id !== adopted) {
    setAdopted(latest.id);
    if (latest.id !== run?.id) {
      setRun(latest);
      setEvents([]);
      setComplete(TERMINAL_RUN_STATUSES.includes(latest.status));
    }
  }

  /** Reports a failure in the words a person can act on. */
  const report = useCallback(
    (failure) => {
      setError(failure?.message ?? "Something went wrong. Try again.");
    },
    [],
  );

  // Polls only while a run is in flight. A finished run's events never change, so continuing to
  // ask would be pure load on the API for a screen that cannot update. A run adopted from the
  // list, rather than started here, begins at its first event.
  useRunEvents({
    workspaceId,
    runId: run?.id ?? null,
    active: !complete,
    after: events.at(-1)?.seq ?? 0,
    onEvents: (items) => setEvents((current) => [...current, ...items]),
    onComplete: async (runId, isCurrent) => {
      setComplete(true);
      // Re-read the run itself for the outcome: the event log says what happened, the run
      // says what it cost and how it ended.
      const history = await mutateHistory();
      if (isCurrent() && history?.items[0]?.id === runId) setRun(history.items[0]);
    },
    onError: report,
  });

  /** Starts a run. */
  async function start() {
    setStarting(true);
    setError(null);
    try {
      // A fresh key per attempt: a retry of a request that may have succeeded reuses this key and
      // returns the original run rather than starting — and paying for — a second one.
      const idempotencyKey = crypto.randomUUID();
      const response = await runsApi.createRun(workspaceId, { agentSlug }, idempotencyKey);
      setEvents([]);
      setComplete(false);
      setRun(response.run);
    } catch (failure) {
      report(failure);
    } finally {
      setStarting(false);
    }
  }

  /** Asks the run to stop. */
  async function stop() {
    try {
      const response = await runsApi.cancelRun(workspaceId, run.id);
      setRun(response.run);
      if (response.stopped) setComplete(true);
    } catch (failure) {
      report(failure);
    }
  }

  if (loading) return <NeutralLoading label="Loading agent" />;
  if (!agent) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>This agent is not available.</AlertDescription>
      </Alert>
    );
  }

  const inFlight = run && !complete;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="font-display text-2xl font-bold tracking-[-0.02em] text-orb-white">{agent.name}</h1>
        <p className="max-w-2xl text-sm text-orb-gray">{agent.summary}</p>
      </header>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Run this agent</CardTitle>
        </CardHeader>
        <CardContent>
          {canRun ? (
            <Button type="button" onClick={start} disabled={starting || Boolean(inFlight)}>
              {starting ? "Starting…" : "Run agent"}
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">A member of this workspace runs this agent. Your role here is read-only.</p>
          )}
        </CardContent>
      </Card>

      {run && (
        <Card>
          <CardContent className="pt-6">
            <RunProgress run={run} events={events} complete={complete} onCancel={canRun ? stop : undefined} />
          </CardContent>
        </Card>
      )}

      {complete && run?.result && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Findings</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs">
              {JSON.stringify(run.result, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
