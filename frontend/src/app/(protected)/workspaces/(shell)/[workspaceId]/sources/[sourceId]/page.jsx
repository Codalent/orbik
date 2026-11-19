import SourceView from "./view";

export const metadata = { title: "Source" };

/** One source: the website (`website`) or another the workspace reads. */
export default function SourcePageRoute() {
  return <SourceView />;
}
