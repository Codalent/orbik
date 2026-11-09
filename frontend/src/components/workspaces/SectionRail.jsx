"use client";

import { Bot } from "lucide-react";
import Link from "next/link";

import { AGENT_STATUS } from "@/lib/agents/registry";
import { cn } from "@/lib/utils";

/**
 * The top level of the workspace's navigation, as the rail lists it: Home, then each thing the
 * workspace knows as a destination of its own, then Agents, then after a gap the pages that stand
 * outside both (an extension's), and at the far end, on its own, Settings.
 *
 * Home leads because it is where somebody new to a workspace is sent and where its setup is
 * finished; once it is, the workspace opens on the Library instead, and Home stays here, one click
 * away, as the workspace at a glance.
 *
 * The knowledge rows come first for the reason they used to sit above the agents: they are what
 * somebody comes back to. Agents is one item for all of them because they are a list to scan, and
 * that list is the sidebar that opens beside the rail while Agents is where the person is.
 *
 * A route listed by a knowledge row belongs to that row even when an agent row lists it too. That
 * decides Brand: it is opened to read and correct the design system, so it is marked as Brand and
 * not as the agent that derives it.
 *
 * @param {object} input
 * @param {Array<object>} [input.leading] destinations before the knowledge rows (Home):
 *   `{ id, name, icon, href }`
 * @param {Array<object>} input.knowledge rows from `buildKnowledgeRows`
 * @param {Array<object>} input.agents rows from `buildAgentRows`
 * @param {Array<object>} [input.links] pages outside both: `{ id, name, icon, href }`
 * @param {Array<object>} [input.footer] pages pinned to the rail's far end (Settings), same shape
 * @param {string} [input.agentsHref] the Agents overview, where the Agents item leads
 * @param {string} [input.path] route being viewed
 * @returns {{ items: Array<object>, agentsOpen: boolean }} the rail's items, and whether the
 *   route is the overview or one of the agents' pages
 */
export function buildRail({ leading = [], knowledge, agents, links = [], footer = [], agentsHref, path }) {
  const onKnowledge = knowledge.some((row) => row.href === path);
  const agentsOpen = !onKnowledge && ((agentsHref && path === agentsHref) || agents.some((row) => row.href === path));

  const items = knowledge.map((row) => ({ ...row, active: row.href === path }));
  if (items.length) items.unshift(...leading.map((link) => ({ ...link, active: link.href === path })));
  if (agents.length) {
    items.push({
      id: "agents",
      name: "Agents",
      icon: Bot,
      // Agents opens on the overview of every agent, with the sidebar beside it; without one it
      // opens on its first row, so the rail always goes somewhere.
      href: agentsHref ?? agents[0].href,
      working: agents.some((row) => row.status === AGENT_STATUS.working),
      active: agentsOpen,
    });
  }
  if (items.length) {
    links.forEach((link, index) => items.push({ ...link, active: link.href === path, first: index === 0 }));
    // Settings is one item for all of its sections, each a route under it.
    footer.forEach((link, index) => items.push({ ...link, active: link.href === path || Boolean(path?.startsWith(`${link.href}/`)), last: index === 0 }));
  }
  return { items, agentsOpen };
}

/**
 * The rail at the left edge: one icon over one word for each destination.
 *
 * From `md` up the column is a fixed 44px, a little wider than an icon, so it takes no more room
 * than it needs; a name wider than that wraps (an extension's, say), and that is accepted as the
 * price of a narrow rail. Below `md` the rail is a row across
 * the top, where each item is as wide as its name and the row fits a 390px screen with room to
 * spare.
 *
 * @param {object} props
 * @param {Array<object>} props.items items from `buildRail`
 */
export function SectionRail({ items }) {
  if (!items.length) return null;

  return (
    <nav aria-label="Workspace" className="flex shrink-0 gap-1 md:flex-col md:pt-1">
      {items.map((item) => {
        const Icon = item.icon;
        // An item with `onSelect` opens something rather than going somewhere — Ask, whose panel
        // opens beside the page — so it is a button that says whether it is pressed, not a link.
        const Item = item.onSelect ? "button" : Link;
        const role = item.onSelect
          ? { type: "button", onClick: item.onSelect, "aria-pressed": Boolean(item.active) }
          // "true" and not "page": Agents is current on every agent's page, not only the one it
          // links to.
          : { href: item.href, "aria-current": item.active ? "true" : undefined };
        return (
          <Item
            key={item.id}
            {...role}
            className={cn(
              "group flex min-w-10 max-w-20 flex-col items-center gap-0.5 rounded-xl px-1 py-1.5 text-[0.625rem] font-medium outline-none transition-colors md:w-11 md:min-w-0 md:max-w-none md:px-0.5",
              "focus-visible:ring-2 focus-visible:ring-ring/70",
              item.active ? "text-orb-white" : "text-orb-muted hover:text-orb-white",
              item.first && "ml-3 md:ml-0 md:mt-3",
              // The far end: the bottom of the column, the right of the row on a phone.
              item.last && "ml-auto md:ml-0 md:mt-auto",
            )}
          >
            <span
              className={cn(
                "relative grid size-7 place-items-center rounded-md border transition-colors",
                item.active ? "border-orb-line bg-orb-raised" : "border-transparent group-hover:bg-orb-raised/60",
              )}
            >
              <Icon aria-hidden="true" className="size-4" />
              {/* An item's rows are not on screen unless it is the open one, so they cannot say
                  that something in it is running. This dot is that statement, in the one colour
                  that means it. */}
              {item.working && <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 size-2 rounded-full border-2 border-orb-black bg-orb-lime" />}
            </span>
            {/* A name wider than the item wraps between its words where it has several (an
                extension's, say); `break-word` splits a single word only when it cannot fit on a
                line of its own in the 44px column. */}
            <span className="w-full text-center leading-tight [overflow-wrap:break-word]">{item.name}</span>
            {item.working && <span className="sr-only">, working now</span>}
          </Item>
        );
      })}
    </nav>
  );
}
