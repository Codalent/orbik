"use client";

import { cn } from "@/lib/utils";

/**
 * How a run's status is presented, including the colour that carries the meaning.
 *
 * The logs panel's words and colours for each run, so every run in it is described one way.
 */
export const RUN_PRESENTATION = Object.freeze({
  running: { label: "Crawl in progress", tone: "text-orb-cyan", dot: "bg-orb-cyan" },
  succeeded: { label: "Completed", tone: "text-orb-lime", dot: "bg-orb-lime" },
  failed: { label: "Finished with errors", tone: "text-orb-coral", dot: "bg-orb-coral" },
  cancelled: { label: "Stopped", tone: "text-orb-gray", dot: "bg-orb-gray" },
});

/**
 * The light that says a crawl is running.
 *
 * It breathes rather than blinks. A crawl takes minutes and this sits in the log for all of
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
