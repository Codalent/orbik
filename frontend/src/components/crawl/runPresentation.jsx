"use client";

import { cn } from "@/lib/utils";

/**
 * How a run's status is presented, including the colour that carries the meaning.
 *
 * Shared by the topbar and the logs panel so one crawl is never described two ways: a run that the
 * topbar calls "Finished with errors" must not appear in the log as "Failed".
 */
export const RUN_PRESENTATION = Object.freeze({
  running: { label: "Crawl in progress", tone: "text-orb-cyan", dot: "bg-orb-cyan" },
  succeeded: { label: "Completed", tone: "text-orb-lime", dot: "bg-orb-lime" },
  failed: { label: "Finished with errors", tone: "text-orb-coral", dot: "bg-orb-coral" },
  cancelled: { label: "Stopped", tone: "text-orb-gray", dot: "bg-orb-gray" },
});

/**
 * A crawl that finished without fetching everything it found, because the month's crawl pages ran
 * out (`pagesSkippedNoBudget` on its counters). Not "Completed": the pages it left wait for the
 * next crawl, and the run must not read as if it had read the whole site.
 */
export const PARTIAL_PRESENTATION = Object.freeze({ label: "Stopped: out of crawl pages", tone: "text-orb-orange", dot: "bg-orb-orange" });

/** Whether a finished run left pages unfetched for want of crawl pages. */
export function ranOutOfPages(run) {
  return Boolean(run) && run.status === "succeeded" && (run.counters?.pagesSkippedNoBudget ?? 0) > 0;
}

/**
 * A crawl that has been asked for and has not begun: waiting for the scheduler's next pass, or for
 * the sites ahead of it. Its own colour, because "it is coming" is neither running nor finished.
 */
export const QUEUED_PRESENTATION = Object.freeze({ label: "Queued", tone: "text-orb-orange", dot: "bg-orb-orange" });

/**
 * The light that says a crawl is running.
 *
 * It breathes rather than blinks. A crawl takes minutes and this sits in the topbar for all of
 * them, so the motion has to be bearable to work beside — and it stops entirely when the crawl
 * does, which is what makes its presence mean something.
 */
export function RunBeacon({ tone, live }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 rounded-full",
        tone,
        live && "animate-[orbik-beacon_1.8s_ease-in-out_infinite] motion-reduce:animate-none",
      )}
    />
  );
}
