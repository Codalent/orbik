import { WorkspaceShell } from "@/components/workspaces/WorkspaceShell";

/**
 * Applies the persistent private workspace navigation to every page inside a workspace.
 *
 * A route group rather than a layout on `workspaces` that inspects the path: `/workspaces/new` is
 * the one page under that segment with no sidebar, and sitting outside this group is what says so.
 */
export default function WorkspaceShellLayout({ children }) {
  return <WorkspaceShell>{children}</WorkspaceShell>;
}
