import KnowledgeBaseAgentView from "./view";

export const metadata = { title: "Knowledge base" };

/**
 * The Business Knowledge Base agent's page: its switch, the folders and pages it writes from, and
 * its runs. What it writes is the Library, at its own route.
 *
 * The folder is named for the agent's slug (`LIBRARY_AGENT_SLUG` in `src/lib/library/library.js`).
 * The page itself is static; the view reads the workspace from the route.
 */
export default function KnowledgeAgentPage() {
  return <KnowledgeBaseAgentView />;
}
