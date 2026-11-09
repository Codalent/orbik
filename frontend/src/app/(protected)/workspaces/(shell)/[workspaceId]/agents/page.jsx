import AgentsOverviewView from "./view";

export const metadata = { title: "Agents" };

/**
 * Every agent in the workspace on one page, where the rail's Agents item leads. Static; the view
 * reads the workspace from the route. A page of its own here, so `/agents` is this and never the
 * extension catch-all beside it.
 */
export default function AgentsOverviewPage() {
  return <AgentsOverviewView />;
}
