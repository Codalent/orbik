"use client";

import { useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import useSWR from "swr";

import { agentSourcesPath, includeAgentSource } from "@/lib/api/knowledge";
import { pathOf } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useCan } from "@/lib/workspaces/roles";

/**
 * Which pages an agent's output is written from, and which it is not.
 *
 * This is the answer to the only question people reliably ask about an agent whose inputs are
 * chosen for it: why is my best blog post not in here? The reason is recorded per page at the
 * moment it was decided — so the honest answer is a list, not an explanation somebody writes
 * afterwards.
 *
 * Folded shut by default. It is reassurance rather than content: the point of the page above it is
 * the knowledge base, and a hundred URLs between a reader and the writing would bury it.
 *
 * The half that lists what was left out can be argued with. Every reason here is a rule the
 * system applied, and a rule is wrong sometimes — a post only three pages link to that is still
 * the best explanation of how the company works. "Include" records that the output should be
 * written from this page; for the Library that happens on the agent's next run, which the request
 * itself starts. It is offered only on the left-out half, because there is nothing to ask for on
 * the other one.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 * @param {string} props.agentSlug which agent's verdicts to show
 * @param {{used: number, excluded: number}} props.counts what the index already reported
 * @param {() => void} [props.onIncluded] told when a page has been asked for, so the page above
 *   can re-read its counts
 */
export function SourceLedger({
  workspaceId,
  agentSlug,
  counts,
  onIncluded,
}) {
  const [open, setOpen] = useState(false);
  const [half, setHalf] = useState(false);
  // Keyed by source, so a row that has been asked for keeps saying so while its neighbours stay
  // clickable — and so a second click on the same row cannot queue it twice.
  const [asked, setAsked] = useState({});
  // Asking for a page to be included is a member's.
  const canInclude = useCan("member", workspaceId);

  // Read only while unfolded. Each half is cached under its own path, so switching between them
  // shows "loading" the first time and the half already read every time after.
  const { data, error } = useSWR(
    open ? agentSourcesPath(workspaceId, agentSlug, { relevant: half, limit: 500 }) : null,
  );
  const sources = data?.items ?? null;
  const failure = !data && error ? error.message ?? "That could not be loaded." : null;

  /** Asks for one page, and leaves the row saying what happened either way. */
  async function include(source) {
    if (!source.key || asked[source.key]) return;
    setAsked((current) => ({ ...current, [source.key]: "asking" }));
    try {
      await includeAgentSource(workspaceId, agentSlug, source.key);
      setAsked((current) => ({ ...current, [source.key]: "queued" }));
      // The counts in the header belong to the page above, which re-reads them. The row is not
      // removed from this list: it is still what the ledger said when the list was fetched, and
      // making it vanish would suggest the note already exists.
      onIncluded?.();
    } catch (error) {
      setAsked((current) => ({ ...current, [source.key]: error?.message ?? "That could not be sent." }));
    }
  }

  const total = counts.used + counts.excluded;
  if (!total) return null;

  return (
    <section className="rounded-2xl border border-orb-line/70 bg-orb-space/40">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-2xl px-4 py-3 text-left text-sm text-orb-gray hover:text-orb-white"
      >
        <ChevronDown aria-hidden="true" className={cn("size-4 shrink-0 text-orb-muted transition-transform", !open && "-rotate-90")} />
        <span className="flex-1">
          Written from {counts.used.toLocaleString()} of your {total.toLocaleString()} pages
          {counts.excluded > 0 && <>, {counts.excluded.toLocaleString()} left out</>}
        </span>
      </button>

      {open && (
        <div className="border-t border-orb-line/70 px-4 py-3">
          <div className="mb-3 flex gap-1" role="group" aria-label="Which pages to show">
            {[
              { value: true, label: `Written from (${counts.used.toLocaleString()})` },
              { value: false, label: `Left out (${counts.excluded.toLocaleString()})` },
            ].map((choice) => (
              <button
                key={String(choice.value)}
                type="button"
                onClick={() => setHalf(choice.value)}
                aria-pressed={half === choice.value}
                className={cn(
                  "rounded-full px-3 py-1 text-xs transition-colors",
                  half === choice.value ? "bg-orb-raised text-orb-white" : "text-orb-muted hover:text-orb-gray",
                )}
              >
                {choice.label}
              </button>
            ))}
          </div>

          {failure && <p className="text-xs text-orb-coral">{failure}</p>}
          {!failure && !sources && <p className="text-xs text-orb-muted">Loading…</p>}
          {sources?.length === 0 && <p className="text-xs text-orb-muted">Nothing here yet.</p>}

          {sources?.length > 0 && (
            <ul className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
              {sources.map((source) => (
                <li key={source.key ?? source.url} className="flex items-baseline gap-2 text-xs">
                  <span className="min-w-0 flex-1">
                    <a href={source.url} target="_blank" rel="noreferrer" className="font-mono text-orb-gray hover:text-orb-cyan hover:underline">
                      {pathOf(source.url)}
                    </a>
                    {source.reason && <span className="ml-2 text-orb-muted">{source.reason}</span>}
                  </span>
                  {canInclude && half === false && source.kind === "page" && source.key && source.includable !== false && (
                    <IncludeAction state={asked[source.key]} onInclude={() => include(source)} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The "Include" control on one left-out page.
 *
 * Three states and no spinner: nothing has happened, it is being sent, or it is queued. The queued
 * state says "queued" rather than "included" on purpose — the output is written from the page on
 * the agent's next run, and a label claiming the page is in it before it is would be the one thing
 * this whole ledger exists to prevent.
 */
function IncludeAction({ state, onInclude }) {
  if (state === "queued") {
    return <span className="shrink-0 text-orb-muted">Queued</span>;
  }
  if (state && state !== "asking") {
    return <span className="shrink-0 text-orb-coral">{state}</span>;
  }
  return (
    <button
      type="button"
      onClick={onInclude}
      disabled={state === "asking"}
      className="flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-orb-muted transition-colors hover:bg-orb-raised hover:text-orb-white disabled:opacity-50"
    >
      <Plus aria-hidden="true" className="size-3" />
      {state === "asking" ? "Sending…" : "Include"}
    </button>
  );
}
