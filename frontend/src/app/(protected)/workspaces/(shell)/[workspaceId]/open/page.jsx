import OpenWorkspaceView from "./view";

export const metadata = { title: "Opening workspace" };

/**
 * Where arriving in a workspace lands (`workspaceHomePath`): it asks where this person should be
 * and moves there. Static; the view reads the workspace from the route.
 */
export default function OpenWorkspacePage() {
  return <OpenWorkspaceView />;
}
