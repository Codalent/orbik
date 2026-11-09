/**
 * The web app's extension slots. In this repository every slot is empty, and the web app renders
 * exactly as it would without them.
 *
 * A deployment that adds to the web app — billing pages, an upgrade prompt — publishes a package
 * under this same name with the same four exports, and points the web app's dependency at it (in
 * a pnpm workspace that includes this repository, by leaving this package out of the workspace and
 * putting its own in). Next bundles whichever package the name resolves to, so no file of the web
 * app changes.
 *
 * Every entry may name a `feature`. It is shown only when the API's `GET /v1/edition` lists that
 * feature, which an API extension turns on with `host.addFeatures`; an entry naming none is always
 * shown. That keeps one build of the web app correct for every edition.
 *
 * Components are client components: they are rendered inside the app's client shell, and may use
 * hooks and the app's own `fetch` through `props.api` (see each slot below).
 */

/**
 * Items added to the workspace rail, after the agents and before Settings.
 *
 * @type {Array<{id: string, name: string, icon: import("react").ComponentType<{className?: string}>,
 *   path: string, feature?: string}>}
 *   `path` is under the workspace: `"billing"` links to `/workspaces/:id/billing`, which is served by
 *   the page of the same path in {@link pages}
 */
export const railItems = [];

/**
 * Pages served under a workspace, at `/workspaces/:id/<path>`, by the one catch-all route the web
 * app keeps for them. A core page at the same address always wins.
 *
 * @type {Record<string, {title: string, feature?: string,
 *   Component: import("react").ComponentType<{workspaceId: string, path: string[], api: object}>}>}
 */
export const pages = {};

/**
 * Sections added to the end of a workspace's Settings, each a page of its own at
 * `/workspaces/:id/settings/extensions/<id>`, linked from the Settings navigation.
 *
 * @type {Array<{id: string, title: string, description?: string, feature?: string,
 *   Component: import("react").ComponentType<{workspaceId: string, api: object}>}>}
 */
export const settingsSections = [];

/**
 * Banners shown above every page of a workspace — a trial ending, a limit reached. A banner that
 * has nothing to say renders nothing.
 *
 * @type {Array<{id: string, feature?: string,
 *   Component: import("react").ComponentType<{workspaceId: string, api: object}>}>}
 */
export const banners = [];
