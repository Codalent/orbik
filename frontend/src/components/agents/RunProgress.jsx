"use client";

import { AlertCircle, Check, CircleDashed, Loader2 } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RUN_STATUS_LABELS, describeRunEvent } from "@/lib/agents/runEvents";
import { cn } from "@/lib/utils";

/**
 * Shows what a run is doing, as it does it.
 *
 * A five-minute audit shown as a spinner tells a person nothing about whether it is progressing,
 * stuck, or about to fail. The event log is the whole reason the runtimes emit structured progress
 * instead of only a final result, and this is where that pays off.
 *
 * @param {object} props
 * @param {object|null} props.run the run, or null before one has been started
 * @param {Array<object>} props.events progress events, oldest first
 * @param {boolean} props.complete whether the run has finished
 * @param {() => void} [props.onCancel] asks the run to stop
 */
export function RunProgress({ run, events, complete, onCancel }) {
  if (!run) return null;

  const failure = run.status === "failed" ? run.error : null;

  return (
    <section aria-label="Run progress" className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <RunStatus run={run} />
        {!complete && onCancel && (
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={run.cancelRequested}>
            {run.cancelRequested ? "Stopping…" : "Cancel"}
          </Button>
        )}
      </header>

      <ol className="space-y-1.5" aria-label="Progress">
        {events.map((event) => (
          <li key={event.seq} className="flex items-start gap-2 text-sm">
            <EventIcon event={event} isLast={event === events.at(-1)} complete={complete} />
            <span className={cn(event.type === "failed" && "text-destructive")}>{describeRunEvent(event)}</span>
          </li>
        ))}
      </ol>

      {failure && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}

/** The run's current state, in the words a person would use. */
function RunStatus({ run }) {
  return (
    <p className="flex items-center gap-2 text-sm font-medium" role="status">
      {run.status === "running" && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
      {RUN_STATUS_LABELS[run.status] ?? run.status}
    </p>
  );
}

/** The mark beside one event: done, in progress, or failed. */
function EventIcon({ event, isLast, complete }) {
  if (event.type === "failed") {
    return <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />;
  }
  // The last event of a run still going is the thing happening *now*, not a completed step.
  if (isLast && !complete) {
    return <Loader2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />;
  }
  if (event.type === "truncated") {
    return <CircleDashed aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />;
  }
  return <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />;
}
