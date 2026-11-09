import ExtensionPageView from "./view";

/**
 * Every address under a workspace that no page of the app has: an extension's page when the
 * installed `@orbik/web-extensions` provides one at that path, and the not-found page otherwise.
 * In this repository it provides none, so this is the not-found page it always was.
 */
export default function ExtensionPage() {
  return <ExtensionPageView />;
}
