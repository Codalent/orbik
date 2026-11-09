import ExtensionSettingsView from "./view";

export const metadata = { title: "Settings" };

/**
 * A Settings section an installed extension adds, at `/settings/extensions/<id>`. In this
 * repository there are none, so every address here is the not-found page.
 */
export default function ExtensionSettingsPage() {
  return <ExtensionSettingsView />;
}
