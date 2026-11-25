import SourceSettingsView from "./view";

export const metadata = { title: "Settings" };

/** Everything that can be set about one source: where it starts, how much, how often, its crawl data. */
export default function SourceSettingsRoute() {
  return <SourceSettingsView />;
}
