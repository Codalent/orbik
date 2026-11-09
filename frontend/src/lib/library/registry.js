import { BookMarked, MessagesSquare, Palette } from "lucide-react";

import { LIBRARY_AGENT_SLUG } from "./library";

/**
 * What this workspace knows, as things to open.
 *
 * The distinction from the agent list above it is the whole reason this section exists. An agent
 * row answers "is anything happening right now"; a row here answers "what does this workspace
 * know". The Library outlives the runs that wrote it — listing it beside the crawler, with a
 * last-run count, would invite somebody to read it as a job rather than as a place that is simply
 * there.
 *
 * The one thing a row here does say about work is that it is being written right now. The Library
 * row is drawn as working while its agent is copying pages into Sources or rewriting the subject
 * tree: files are appearing in it at that moment, and a still row beside a Library that is filling
 * up reads as something having gone wrong. At rest it says nothing — there is no idle, failed or
 * not-set-up here, which are statements about a job.
 *
 * The Library is no longer only an agent's output: people write in it too, which is why it has its
 * own route rather than living under the agent that maintains it. Its run and schedule controls
 * are still on the page.
 *
 * llms.txt used to sit here and is now an agent row (`@/lib/agents/registry`). It is read-only
 * output on a schedule, and nobody edits it — so the question worth answering about it is whether
 * it has been rebuilt since the site changed, which is what an agent row says.
 *
 * Brand is here for the reason the Library is: it is read and corrected, not watched. The design
 * system outlives the run that derived it, a person pins the values they know better than the
 * site shows, and what somebody opens the page for is the system rather than the job. The agent
 * that derives it has a row among the agents too, for the one thing that row says — whether it
 * could run at all — and both rows lead to the same page.
 *
 * Ordered by how often they are opened rather than by when they were built: the Library is what
 * somebody comes back to, Brand is the same thing for how the company looks, and Ask is how a
 * question gets answered without reading either.
 *
 * Each is an item of its own in the rail at the left edge (`SectionRail`), not a row in a sidebar.
 * The site's pages as Markdown used to be a fourth; that page is still at `/markdown`, with no
 * link here, by the owner's decision.
 */
const KNOWLEDGE = Object.freeze([
  {
    id: "library",
    name: "Library",
    // A bookmarked book: the thing that is read, edited, and returned to.
    icon: BookMarked,
    href: (workspaceId) => `/workspaces/${workspaceId}/library`,
    /**
     * Whether the Library agent is writing in this workspace's Library now.
     *
     * Either of its writing stages counts: the copy into Sources, which is a queue job the
     * activity read reports under `library`, and the rewrite of the subject tree, which is a run
     * among `agents`.
     */
    working(workspaceId, activity) {
      if (!activity) return false;
      return (activity.library ?? []).some((entry) => entry.workspaceId === workspaceId)
        || (activity.agents ?? []).some((run) => run.workspaceId === workspaceId && run.agentSlug === LIBRARY_AGENT_SLUG);
    },
  },
  {
    id: "brand",
    name: "Brand",
    // A palette: the colours, type and imagery the company is recognised by.
    icon: Palette,
    href: (workspaceId) => `/workspaces/${workspaceId}/brand`,
  },
  {
    id: "ask",
    name: "Ask",
    // Two speech bubbles: a conversation, not a document — the one row here that answers back.
    // It opens the Ask panel beside the page rather than going to one (`WorkspaceShell`); the
    // address below is kept for links, and opens the panel too.
    icon: MessagesSquare,
    href: (workspaceId) => `/workspaces/${workspaceId}/ask`,
  },
]);

/**
 * Builds the rail's knowledge items for one workspace.
 *
 * @param {string} workspaceId workspace the rows link into
 * @param {object|null} [activity] what is running now, from `GET /v1/activity`; null when unread
 */
export function buildKnowledgeRows(workspaceId, activity = null) {
  return KNOWLEDGE.map((item) => ({
    id: item.id,
    name: item.name,
    icon: item.icon,
    href: item.href(workspaceId),
    working: Boolean(item.working?.(workspaceId, activity)),
  }));
}
