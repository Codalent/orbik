import SourceView from "./view";

export const metadata = { title: "Source" };

/** One source's Overview tab: the website (`website`) or another source the workspace reads. */
export default function SourcePageRoute() {
  return <SourceView />;
}
