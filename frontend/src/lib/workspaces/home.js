/**
 * Where a workspace opens.
 *
 * Arriving in a workspace — signing in, switching to it, creating it, accepting an invite — goes
 * through one address, `/workspaces/:id/open`, which asks the API where this person should land
 * and moves there: the Home page while any essential setup step *they* can do is unfinished, and
 * the Library once none is. The decision is the server's (`landing` on `GET …/home`), because it
 * depends on things only the server knows — whether this person's own AI has called yet — and a
 * synchronous path here keeps every caller as simple as it was when the answer was always "the
 * Library".
 *
 * `/workspaces/:id` itself opens Home, by the owner's decision (2026-10-29): it is the address a
 * person types or bookmarks for "the workspace". The crawl page, which used to be there, is the
 * website's pages under Sources (`workspaceCrawlerPath`).
 *
 * @param {string} workspaceId
 * @returns {string}
 */
export function workspaceHomePath(workspaceId) {
  return `/workspaces/${workspaceId}/open`;
}

/** The Home page itself: the setup checklist and the workspace at a glance. */
export function workspaceHomePagePath(workspaceId) {
  return `/workspaces/${workspaceId}/home`;
}

/** The Library, where a workspace that is set up opens. */
export function workspaceLibraryPath(workspaceId) {
  return `/workspaces/${workspaceId}/library`;
}

/**
 * The website's pages under Sources — the crawl's tree, figures, frequencies and logs — where every
 * link that means "the crawl of your site" goes. It used to be the Crawler's page among the agents.
 */
export function workspaceCrawlerPath(workspaceId) {
  return `/workspaces/${workspaceId}/sources/website/pages`;
}

/** The website's page under Sources: what it is, how it is read, and its settings. */
export function workspaceWebsitePath(workspaceId) {
  return `/workspaces/${workspaceId}/sources/website`;
}
