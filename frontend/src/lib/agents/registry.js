import { BookOpenText, Bot, FileCode2, Palette, Waypoints } from "lucide-react";

import { DESIGN_SYSTEM_AGENT_SLUG } from "@/lib/brand/brand";
import { LLMS_TXT_AGENT_SLUG } from "@/lib/knowledge/knowledge";
import { LIBRARY_AGENT_SLUG } from "@/lib/library/library";

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
 * The Business Knowledge Base is here as an agent — whether it is set to work, whether its last
 * write failed — and under Knowledge as the Library (`@/lib/library/registry`), the place people
 * read and edit. The agent's row leads to its own page, with its switch and settings; the Library
 * row leads to the Library. llms.txt is only here,
 * because nobody edits it — it is read-only output on a schedule, and the question worth
 * answering at a glance is whether it has been rebuilt since the site changed.
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
    id: LIBRARY_AGENT_SLUG,
    name: "Knowledge base",
    // An open book with text: what this one writes is the Library's knowledge base.
    icon: BookOpenText,
    // The agent's own page: its switch, its folders, its source ledger and its runs. What it
    // writes is the Library, listed under Knowledge.
    href: (workspaceId) => `/workspaces/${workspaceId}/agents/${LIBRARY_AGENT_SLUG}`,
    // It writes from the pages the crawler copied into Sources, so before a crawl it is not set up.
    describe: describeCrawlReader,
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
    describe: describeCrawlReader,
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
    describe: describeCrawlReader,
  },
]);

/**
 * Builds the sidebar's agent rows for one workspace.
 *
 * After core's agents come the ones a deployment's extension gives a place here (`agentPages` in
 * `@orbik/web-extensions`), each linking to `/workspaces/:id/agents/<slug>`. Like the agents
 * that read the crawl, one is "not set up" until the site has been crawled once. An entry with a
 * core agent's slug is left out: core's row stays.
 *
 * @param {string} workspaceId workspace the rows link into
 * @param {object|null} crawl crawl overview, or null when it could not be read
 * A row is drawn as working whenever the live activity read (`GET /v1/activity`, the one the
 * activity monitor at the sidebar's foot polls) has a run of that agent in this workspace, whatever
 * its own state says: an agent started by the crawl or the scheduler is working as much as one a
 * person started, and a still row beside a run in the activity monitor reads as two accounts of
 * one thing. The Knowledge base agent also counts its first stage, the copy into Sources.
 *
 * @param {Array<[string, {name?: string, icon?: Function}]>} [extensionAgents] `[slug, entry]`
 *   pairs from `useExtensionSlots().agentPages`
 * @param {object|null} [activity] what is running now, from `GET /v1/activity`; null when unread
 */
export function buildAgentRows(workspaceId, crawl, extensionAgents = [], activity = null) {
  const core = AGENTS.map((agent) => ({
    id: agent.id,
    name: agent.name,
    icon: agent.icon,
    href: agent.href(workspaceId),
    ...agent.describe(crawl),
  }));
  const taken = new Set(core.map((row) => row.id));
  const added = extensionAgents
    .filter(([slug]) => !taken.has(slug))
    .map(([slug, entry]) => ({
      id: slug,
      name: entry.name ?? slug,
      icon: entry.icon ?? Bot,
      href: `/workspaces/${workspaceId}/agents/${encodeURIComponent(slug)}`,
      ...describeCrawlReader(crawl),
    }));
  return [...core, ...added].map((row) => (
    row.status !== AGENT_STATUS.working && isRunning(row.id, workspaceId, activity)
      ? { ...row, status: AGENT_STATUS.working, label: undefined }
      : row
  ));
}

/** Whether the activity read has this agent at work in this workspace. */
function isRunning(agentSlug, workspaceId, activity) {
  if (!activity || !workspaceId) return false;
  if ((activity.agents ?? []).some((run) => run.workspaceId === workspaceId && run.agentSlug === agentSlug)) return true;
  // Copying the crawled pages into Sources is the Knowledge base agent's first stage, a queue job
  // rather than a run, which the activity read reports under `library`.
  return agentSlug === LIBRARY_AGENT_SLUG && (activity.library ?? []).some((entry) => entry.workspaceId === workspaceId);
}

/** The status of an agent that reads the crawl: unknown, not set up until a first crawl, or idle. */
function describeCrawlReader(crawl) {
  if (!crawl) return { status: AGENT_STATUS.unknown };
  if (!crawl.site || !crawl.latestRun) return { status: AGENT_STATUS.unconfigured };
  return { status: AGENT_STATUS.idle };
}
