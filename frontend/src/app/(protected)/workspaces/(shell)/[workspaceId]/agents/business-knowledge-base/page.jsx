import LibraryView from "../../library/view";

export const metadata = { title: "Library" };

/**
 * The Business Knowledge Base agent, whose page is the Library it writes.
 *
 * The folder is named for the agent's slug (`LIBRARY_AGENT_SLUG` in `src/lib/library/library.js`).
 * The Library also has its own route, and this renders the same view so a link from the agent list
 * lands in one place.
 */
export default function KnowledgeAgentPage() {
  return <LibraryView />;
}
