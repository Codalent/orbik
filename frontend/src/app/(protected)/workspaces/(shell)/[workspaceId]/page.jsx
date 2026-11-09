import WorkspaceRootView from "./view";

export const metadata = { title: "Home" };

/**
 * The workspace's bare address opens Home (the owner's decision, 2026-10-29). The Crawler's page
 * that used to be here is at `/workspaces/:id/agents/crawler`. Static; the view reads the
 * workspace from the route and moves on.
 */
export default function WorkspaceRootPage() {
  return <WorkspaceRootView />;
}
