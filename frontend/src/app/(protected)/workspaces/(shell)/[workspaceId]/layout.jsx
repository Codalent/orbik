import { WorkspaceGate } from "@/components/workspaces/WorkspaceGate";

/** Renders a workspace's pages only for a workspace the signed-in account actually has. */
export default function WorkspaceLayout({ children }) {
  return <WorkspaceGate>{children}</WorkspaceGate>;
}
