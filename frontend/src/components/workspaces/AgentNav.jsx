"use client";

import Link from "next/link";

import { AGENT_STATUS } from "@/lib/agents/registry";
import { cn } from "@/lib/utils";

/**
 * How each state is drawn. Colour carries the meaning: the glyph is the only thing a row shows
 * about its agent's state.
 *
 * Only `working` is lime. Reserving the brand's one bright colour for "something is happening
 * right now" is what lets a glance at the sidebar answer that question without reading anything.
 */
export const STATUS_STYLE = Object.freeze({
  [AGENT_STATUS.working]: { ring: "border-orb-lime/50", icon: "text-orb-lime" },
  [AGENT_STATUS.idle]: { ring: "border-orb-line", icon: "text-orb-gray" },
  [AGENT_STATUS.failed]: { ring: "border-orb-coral/50", icon: "text-orb-coral" },
  [AGENT_STATUS.unconfigured]: { ring: "border-dashed border-orb-line", icon: "text-orb-muted" },
  [AGENT_STATUS.unknown]: { ring: "border-dashed border-orb-line", icon: "text-orb-muted" },
});

/** What each state means, read out for people who are not looking at the colour. */
const STATUS_LABEL = Object.freeze({
  [AGENT_STATUS.working]: "working now",
  [AGENT_STATUS.idle]: "idle",
  [AGENT_STATUS.failed]: "last run failed",
  [AGENT_STATUS.unconfigured]: "not set up",
  [AGENT_STATUS.unknown]: "status unavailable",
});

/**
 * The agents working this workspace, as a navigable list.
 *
 * The section is both navigation and a status board: an operator glancing here wants to know
 * whether anything is running, without opening a page to ask.
 *
 * @param {object} props
 * @param {Array<object>} props.agents rows from `buildAgentRows`
 * @param {string} [props.currentPath] the route being viewed, used to mark the current agent
 */
export function AgentNav({ agents, currentPath }) {
  if (!agents.length) return null;

  return (
    <nav aria-label="Agents" className="px-1">
      <ul className="space-y-0.5">
        {agents.map((agent) => (
          <li key={agent.id}>
            <AgentRow agent={agent} current={currentPath === agent.href} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** One agent: its glyph and its name. What the agent last found belongs on its own page. */
function AgentRow({ agent, current }) {
  const style = STATUS_STYLE[agent.status] ?? STATUS_STYLE[AGENT_STATUS.unknown];
  const Icon = agent.icon;

  return (
    <Link
      href={agent.href}
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring/70",
        current ? "bg-orb-raised text-orb-white" : "text-orb-gray hover:bg-orb-raised/60 hover:text-orb-white",
      )}
    >
      <OrbitGlyph Icon={Icon} style={style} working={agent.status === AGENT_STATUS.working} />
      <span className="min-w-0 flex-1 truncate font-medium">{agent.name}</span>
      {/* A row may word its own state, when the shared words would say something untrue of it. */}
      <span className="sr-only">, {agent.label ?? STATUS_LABEL[agent.status] ?? STATUS_LABEL[AGENT_STATUS.unknown]}</span>
    </Link>
  );
}

/**
 * The agent's icon held inside a ring, with a dot travelling that ring while the agent works.
 *
 * Taken from the ringed planet in the Orbik mark: one object that says both which agent this is
 * and whether it is doing anything, rather than an icon with a status dot bolted beside it.
 *
 * The dot exists only while an agent is working. At rest it would be a speck that means nothing,
 * and a still sidebar with no dot anywhere is what makes the moving one worth noticing.
 * Reduced-motion parks it without removing it: its position is not the signal, its presence is.
 */
export function OrbitGlyph({ Icon, style, working }) {
  return (
    <span
      aria-hidden="true"
      className={cn("relative grid size-7 shrink-0 place-items-center rounded-full border", style.ring)}
    >
      <Icon className={cn("size-3.5", style.icon)} />
      {working && (
        <span className="absolute inset-0 animate-[orbik-orbit_6s_linear_infinite] motion-reduce:animate-none">
          <span className="absolute left-1/2 top-0 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-orb-lime" />
        </span>
      )}
    </span>
  );
}
