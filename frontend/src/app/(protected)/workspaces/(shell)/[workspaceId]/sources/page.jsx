import SourcesView from "./view";

export const metadata = { title: "Sources" };

/** Everything the workspace reads, where the rail's Sources item leads. The view reads the workspace from the route. */
export default function SourcesPage() {
  return <SourcesView />;
}
