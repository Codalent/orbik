/**
 * The web app's extension slots. In this repository every slot is empty, and the web app renders
 * exactly as it would without them.
 *
 * A deployment that adds to the web app — billing pages, an upgrade prompt — publishes a package
 * under this same name with these exports, any of which it may leave out, and points the web app's
 * dependency at it (in
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
 * Where a person goes for more crawl pages — a plan to change, pages to buy — offered on the
 * Crawler page beside "this month's crawl pages are spent" and "this workspace's plan includes no
 * crawl pages". `path` is under the workspace, as a rail item's is (`"billing"` links to
 * `/workspaces/:id/billing`), or an `https://` address, which opens in a new tab. With none, the
 * page says what happened and offers nothing to press.
 *
 * @type {{label: string, path: string, feature?: string} | null}
 */
export const crawlBudgetLink = null;

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

/**
 * Compact controls in the workspace header, after the theme switch and before the account menu,
 * in this order, on every page of a workspace: something small that is always in view, such as
 * what a deployment that meters usage has left, as an icon-sized button that may open a popover.
 * The header keeps its height and must still fit a phone, so an item is no taller than the
 * controls beside it (2rem) and no wider than it needs to be. An item with nothing to say renders
 * nothing.
 *
 * @type {Array<{id: string, feature?: string,
 *   Component: import("react").ComponentType<{workspaceId: string, api: object}>}>}
 */
export const headerItems = [];

/**
 * Notes on the quiet line under each finished answer in the Ask panel, beside Copy, for every
 * agent the panel talks to (the Library chat and the brand chat): what an answer cost, say, for a
 * deployment that meters usage. Not rendered while an answer is still being written, nor under one
 * that failed before it had a run. A note with nothing to say renders nothing.
 *
 * `runId` is the run that produced the answer. `model` is the model that answered, as the AI call
 * log names it: the one that answered the latest of the run's reasoning calls to come back, which
 * is the model the provider fell back to when it did; null when none came back. `costUsd` is what
 * the run's model calls cost at list price in US dollars, the sum of the `costUsd` on its
 * `ai_calls` rows (every turn of its tool loop, and the embeddings of its searches); 0 when none
 * was priced. Both are null for a reader whose role does not read the AI call log.
 *
 * @type {Array<{id: string, feature?: string,
 *   Component: import("react").ComponentType<{workspaceId: string, api: object, runId: string,
 *   model: string|null, costUsd: number|null}>}>}
 */
export const answerNotes = [];

/**
 * Agents a deployment's server extension added (`host.addAgentDefinitions`), given a place in the
 * web app: a row in the Agents overview and the workspace's agent lists, with this name and icon,
 * linking to `/workspaces/:id/agents/<slug>`. With a `Component`, that page is the extension's;
 * without one it is the generic agent page. A slug core already has a page for keeps core's.
 *
 * @type {Record<string, {name: string, icon?: import("react").ComponentType<{className?: string}>,
 *   feature?: string, Component?: import("react").ComponentType<{workspaceId: string,
 *   agentSlug: string, api: object}>}>}
 */
export const agentPages = {};

/**
 * Pages about the signed-in account rather than one workspace — a plan, invoices — at
 * `/account/<path>`, for anyone signed in, including a person with no workspace yet. The component
 * draws the page, heading included, inside the frame the Admin page uses.
 *
 * @type {Record<string, {feature?: string,
 *   Component: import("react").ComponentType<{path: string[], api: object}>}>}
 */
export const accountPages = {};

/**
 * Items added to the account menu (the avatar at the top right), after Admin and Change password
 * and before Documentation and Source code. `href` is a path in the web app (`/account/billing`) or an `https://` address, which opens
 * in a new tab.
 *
 * @type {Array<{id: string, label: string, href: string, feature?: string,
 *   icon?: import("react").ComponentType<{className?: string}>}>}
 */
export const userMenuItems = [];

/**
 * The page at `/signup` in place of the Request access form, for a deployment whose server
 * extension adds a way to make an account (its own routes, with `http.accounts`). Orbik itself has
 * no self-service signup, so this is null here and `/signup` asks the install's admins for access;
 * with it, the sign-in page's "Need an account?" links to this page as "Create one".
 *
 * `api` is the app's client (`api.fetch(path, { signsIn: true })` for a route that signs the browser
 * in, so the app's session follows). `ui` is what the sign-in pages are built from, so the page looks
 * like them: `AuthPanel`, `AuthField`, `AuthError`, `AuthPanelFoot`, `AuthDivider`,
 * `GoogleSignInButton`, `Button`, `Input`, `Link`, the `AUTH_LINK` class, and `googleSignIn`, whether
 * this install offers Continue with Google.
 *
 * @type {{feature?: string,
 *   Component: import("react").ComponentType<{api: object, ui: object}>}|null}
 */
export const signupPage = null;

/**
 * Notices in the create-workspace wizard, above its buttons on both steps — what the new workspace
 * will cost, a limit the account is at — so a deployment can tell the person before a workspace is
 * made. A notice with nothing to say renders nothing.
 *
 * @type {Array<{id: string, feature?: string,
 *   Component: import("react").ComponentType<{api: object}>}>}
 */
export const workspaceCreateNotices = [];
