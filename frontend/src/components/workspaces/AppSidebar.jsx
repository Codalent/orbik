"use client";

import Link from "next/link";
import { LayoutGrid, Plus } from "lucide-react";

import { AgentNav, OrbitGlyph, STATUS_STYLE } from "./AgentNav";
import { LiveActivity } from "./LiveActivity";
import { Pill } from "@/components/ui/pill";
import { AGENT_STATUS } from "@/lib/agents/registry";
import { cn } from "@/lib/utils";

/**
 * The agents working the selected workspace, as the column beside the rail while Agents is open.
 *
 * Only Agents has one. Everything else in the rail is a single page, and a column listing one row
 * would be a column of nothing.
 *
 * @param {Array<object>} [props.agents] agent rows for this workspace; empty until one is loaded
 * @param {string} [props.currentPath] route being viewed, used to mark the current row
 * @param {string} [props.overviewHref] the overview of every agent, listed first
 */
export function AppSidebar({ agents = [], currentPath, overviewHref }) {
  // On a narrow screen the sidebar stacks above the page. On the overview the page *is* the list of
  // agents, so there the sidebar would repeat it before the first card; it is left to wider screens.
  const onOverview = Boolean(overviewHref) && currentPath === overviewHref;
  return (
    // The left half of the shell's one panel: no card of its own, only the line that divides it
    // from the content beside it (below it, on a narrow screen).
    <aside aria-label="Agents sidebar" className={cn("flex w-full shrink-0 flex-col gap-3 border-b border-orb-line p-3 text-sidebar-foreground md:w-60 md:border-b-0 md:border-r", onOverview && "max-md:hidden")}>
      <h2 className="px-3 pt-1 font-display text-base font-bold tracking-[-0.02em] text-orb-white">Agents</h2>
      {/* The list scrolls between the title and the foot. A workspace now has more agents than a
          short window is tall, and a column that only grows pushes the activity monitor out
          through the bottom of the sidebar; with the list as the part that gives, it stays where
          the eye expects it.

          `relative` is for the rows' `sr-only` labels. They are absolutely positioned, and with no
          positioned ancestor they are laid out against the page: the ones on rows scrolled out of
          view here then made the page itself taller than the window, and it scrolled. */}
      <div className="relative flex flex-col gap-3 md:-mr-2 md:min-h-0 md:flex-1 md:overflow-y-auto md:pr-2">
        {overviewHref && <OverviewRow href={overviewHref} current={currentPath === overviewHref} />}
        <AgentNav agents={agents} currentPath={currentPath} />
        <CreateAgentRow />
      </div>
      {/* The activity monitor sits at the foot: the last thing in the column and the first thing
          the eye lands on when something starts moving. */}
      <div className="md:mt-auto">
        <LiveActivity />
      </div>
    </aside>
  );
}

/**
 * The way back to the overview of every agent, above the agents themselves and drawn like one of
 * their rows, with a line under it: it is where the rail's Agents item leads, and the one row that
 * is not an agent.
 */
function OverviewRow({ href, current }) {
  return (
    <div className="border-b border-orb-line/70 px-1 pb-2">
      <Link
        href={href}
        aria-current={current ? "page" : undefined}
        className={cn(
          "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm outline-none transition-colors",
          "focus-visible:ring-2 focus-visible:ring-ring/70",
          current ? "bg-orb-raised text-orb-white" : "text-orb-gray hover:bg-orb-raised/60 hover:text-orb-white",
        )}
      >
        <OrbitGlyph Icon={LayoutGrid} style={STATUS_STYLE[AGENT_STATUS.idle]} working={false} />
        <span className="min-w-0 flex-1 truncate font-medium">All agents</span>
      </Link>
    </div>
  );
}

/**
 * Where making an agent of one's own will start. Not built yet: drawn like an agent row but dimmed,
 * not a link, and marked as coming soon so nobody clicks it expecting a page.
 */
function CreateAgentRow() {
  return (
    <div className="border-t border-orb-line/70 px-1 pt-2">
      <div
        aria-disabled="true"
        title="Coming soon"
        className="flex cursor-default items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-orb-muted"
      >
        <OrbitGlyph Icon={Plus} style={STATUS_STYLE[AGENT_STATUS.unconfigured]} working={false} />
        {/* The column is too narrow for the name and the pill side by side, so the pill sits under it. */}
        <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
          <span className="truncate font-medium">Create your own agent</span>
          <Pill tone="muted">Coming soon</Pill>
        </span>
      </div>
    </div>
  );
}
