import { FileCode2, Palette, Waypoints } from "lucide-react";

import { DESIGN_SYSTEM_AGENT_SLUG } from "@/lib/brand/brand";
import { LLMS_TXT_AGENT_SLUG } from "@/lib/knowledge/knowledge";

/**
 * What an agent is doing, from the point of view of someone glancing at the sidebar.
 *
 * `unknown` is deliberately distinct from `idle`: a failed status request means we do not know
 * what the agent is doing, and showing that as "idle" would be a guess presented as a fact.
 */
export const AGENT_STATUS = Object.freeze({
  working: "working",
  idle: "idle",
  failed: "failed",
  unconfigured: "unconfigured",
  unknown: "unknown",
});

/**
 * Every agent whose *status* is worth watching, in the order they appear in the sidebar.
 *
 * One entry per agent that actually exists. An agent joins this list when it ships, so the sidebar
 * never points at something that is not there — a navigation item is a promise that pressing it
 * takes you somewhere.
 *
 * Not every agent belongs here. The Business Knowledge Base is listed under Knowledge instead
 * (`@/lib/library/registry`), as the Library: people write in it too, so what somebody wants from
 * it is a place to read and edit rather than a job to watch. llms.txt is here, because nobody
 * edits it — it is read-only output on a schedule, and the question worth answering at a glance is
 * whether it has been rebuilt since the site changed.
 *
 * `describe` turns whatever the API reports into the one thing a sidebar row shows beside the
 * agent's name: how the agent is doing. It is given the crawl, which is what every row's state
 * follows from. A row may also return a `label`, the words read out for its state when the shared
 * ones would misdescribe it.
 */
const AGENTS = Object.freeze([
  {
    id: "crawler",
    name: "Crawler",
    // Nodes joined by a path: the link graph the crawler walks outward from its seed.
    icon: Waypoints,
    href: (workspaceId) => `/workspaces/${workspaceId}/agents/crawler`,
    describe(crawl) {
      if (!crawl) return { status: AGENT_STATUS.unknown };
      if (!crawl.site) return { status: AGENT_STATUS.unconfigured };
      if (crawl.activeRun || crawl.queued) return { status: AGENT_STATUS.working };
      if (crawl.latestRun?.status === "failed") return { status: AGENT_STATUS.failed };
      return { status: AGENT_STATUS.idle };
    },
  },
  {
    id: LLMS_TXT_AGENT_SLUG,
    name: "llms.txt",
    // A file with code in it: what this one produces is a file you put on your site.
    icon: FileCode2,
    href: (workspaceId) => `/workspaces/${workspaceId}/agents/${LLMS_TXT_AGENT_SLUG}`,
    /**
     * This agent's sidebar state depends on the crawl beneath it, not only on its own runs.
     *
     * Every link the agent writes is checked against a page the crawler actually fetched, so
     * before there is a crawl there is nothing it could publish, and the row is drawn as not
     * set up.
     */
    describe(crawl) {
      if (!crawl) return { status: AGENT_STATUS.unknown };
      if (!crawl.site || !crawl.latestRun) return { status: AGENT_STATUS.unconfigured };
      return { status: AGENT_STATUS.idle };
    },
  },
  {
    id: DESIGN_SYSTEM_AGENT_SLUG,
    name: "Design system",
    // A palette: what this one derives is the colours, type and imagery of the site.
    icon: Palette,
    // The agent's own page: its setup, schedule and runs. What it derives is the Brand page,
    // listed under Knowledge.
    href: (workspaceId) => `/workspaces/${workspaceId}/agents/${DESIGN_SYSTEM_AGENT_SLUG}`,
    /**
     * Its state follows the crawl beneath it, like the rows above.
     *
     * The pages it renders are chosen from the crawl, and every page it cites is one the crawler
     * fetched, so before there is a crawl the row is drawn as not set up.
     */
    describe(crawl) {
      if (!crawl) return { status: AGENT_STATUS.unknown };
      if (!crawl.site || !crawl.latestRun) return { status: AGENT_STATUS.unconfigured };
      return { status: AGENT_STATUS.idle };
    },
  },
]);

/**
 * Builds the sidebar's agent rows for one workspace.
 *
 * @param {string} workspaceId workspace the rows link into
 * @param {object|null} crawl crawl overview, or null when it could not be read
 */
export function buildAgentRows(workspaceId, crawl) {
  return AGENTS.map((agent) => ({
    id: agent.id,
    name: agent.name,
    icon: agent.icon,
    href: agent.href(workspaceId),
    ...agent.describe(crawl),
  }));
}
