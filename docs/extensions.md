# Extensions

Orbik is open source and complete on its own: with no extension loaded every limit is unlimited,
every agent runs, and the edition is `community`. An **extension** is how a deployment adds to it
without changing it — plans and their limits, billing, an admin back office, metering, more pages
in the web app. Orbik's own cloud is built this way, from a separate private repository that
includes this one; nothing of it is in this repository.

There are two halves, one for the server processes and one for the web app:

| | Where | What it can do |
|---|---|---|
| Server extensions | `ORBIK_EXTENSIONS`, loaded by the API, the worker, the scheduler and `grant:crawl-budget` | plan limits, events, the edition and its features, API routes, scheduler loops, worker agents, the email sender, signup checks |
| Web extensions | the `@orbik/web-extensions` package the web app imports | rail items, pages, settings sections, banners |

The rule that keeps the two repositories honest: **core starts and serves every page with no
extension loaded**, and core never imports an extension. ESLint enforces the second
(`eslint.boundary.mjs`): an import from `backend/`, `agents/`, `frontend/` or `packages/` that
resolves outside this repository, names an `@orbik/` package this repository does not define, or
names `orbik-cloud`, fails the lint. The loader imports extensions by a name it reads at run time,
which no rule sees; that is the one door.

## Server extensions

`ORBIK_EXTENSIONS` is a comma-separated list of modules. Each entry is a package name, resolved the
way any import is (so a package the deployment's root depends on is found), or a path, resolved
against the process's working directory. Set the same list for every process. A module that fails
to import or register stops the process: a deployment that enforces plans must not come up
without them and serve everything unlimited.

A module's default export is `{ name, register(host) }`:

```js
export default {
  name: "acme-plans",
  async register(host) {
    // Every process.
    host.setPlanLimits(async ({ ownerId }) => planFor(ownerId));
    host.on("ai.call.finished", ({ call }) => meter(call));

    if (host.process === "api") {
      host.setEdition("cloud");
      host.addFeatures("billing");
      host.addRoutes((http) => billingRouter(http));
      host.checkSignup(async ({ email }) => refuseDisposable(email));
      host.setEmailSender(async ({ to, subject, text }) => sendWithProvider(to, subject, text));
    }
    if (host.process === "scheduler") host.addLoop(createUsageReporter(host.database));
    if (host.process === "worker") host.addAgent({ name: "acme-export", version: 1, handlers: { "acme-export.run": runExport } });
  },
};
```

`host.process` is `api`, `worker`, `scheduler` or `script`. `host.database`, `host.config` (the
process's parsed configuration) and `host.logger` are handed over too. A method that belongs to
another process throws, so an extension checks `host.process` first.

### Plan limits

`host.setPlanLimits(resolve)` — one extension per deployment. `resolve({ ownerId })` returns the
limits of the account that pays for a workspace: its owner, whoever is acting in it. Every field is
a ceiling, and `null` (or leaving it out) means none:

| Field | Enforced by |
|---|---|
| `monthlyCrawlPages` | the crawl budget, in the API and every crawl the worker makes. A month's ceiling is fixed when the month is first touched; with none the month is unlimited and still counts `consumed`. |
| `maxWorkspaces` | creating a workspace: `403 PLAN_LIMIT_REACHED` |
| `maxMembersPerWorkspace` | inviting and accepting: `409 MEMBER_LIMIT_REACHED` |
| `agents` | a list of agent slugs, or `null` for all. Starting a run in the API (`403 PLAN_LIMIT_REACHED`), and any run the worker executes, which fails with `PLAN_LIMIT_REACHED` |
| `aiCalls` | `false` refuses every model and embedding call made for the account's workspaces before anything is sent |

Answers are cached per account for 30 seconds in each process. A malformed answer (a negative
count, a list of numbers) throws rather than being read as unlimited.

### Events

`host.on(event, handler)` — told after the fact; a handler that throws is logged and ignored, so an
extension never fails the action it is told about.

| Event | Where | Payload |
|---|---|---|
| `account.created` | API | `{ user: { id, email }, via: "setup" \| "signup" \| "invite" \| "access-request" }` |
| `access.requested` | API | `{ request: { id, email } }`, the first time an address asks for access on the closed signup page |
| `workspace.created` | API | `{ workspace: { id, name, websiteUrl, ownerId }, userId }` |
| `workspace.deleted` | API | `{ workspace: { id, name, websiteUrl, ownerId }, userId }`, after every record core keeps of it is gone; remove what the extension stored about it |
| `ai.call.finished` | API, worker | `{ call }`: the `ai_calls` row as written — workspace, run, agent, model, usage, `costUsd`, status |

### API

- `host.setEdition(name)` and `host.addFeatures(...names)` — what `GET /v1/edition` reports. The web
  app shows a slot only when the feature it names is listed.
- `host.addRoutes((http) => router)` — mounted after every core route and before the 404 handler,
  so none can shadow a core route. `http` carries `database`, `config`, `logger`, `AppError`,
  `requireAuthentication`, `csrfProtection` and `requireWorkspaceAccess(userId, workspaceId,
  { role })`, the same ones core's routes are built from.
- Routes under `/v1/hooks/` are for other software's servers, such as a payment provider's
  webhook: no CORS check, no JSON requirement and no body parsing, so the route reads the raw body
  itself (`express.raw()`) and authenticates by signature, never by session.
- `host.checkSignup(check)` — runs before a self-service signup (`ORBIK_SIGNUP=open`) creates an
  account. Throw an error with a 4xx `status` and a `code` to refuse it with that answer.
- `host.setEmailSender(send)` — one extension per deployment; replaces SMTP. `send({ to, subject,
  text, html? })`.

### Scheduler and worker

- `host.addLoop({ start, stop })` — started and stopped with the scheduler's own loops.
- `host.addAgent({ name, version, handlers })` — validated as a core agent is; its job types are
  queued and claimed like any other. A name already taken is refused.

## Web extensions

The web app imports `@orbik/web-extensions` and renders four exports from it. In this repository
the package (`packages/web-extensions`) exports four empty lists, and the app renders exactly as it
would without them.

| Export | Rendered |
|---|---|
| `railItems: [{ id, name, icon, path, feature? }]` | in the workspace rail, after the agents and before Settings, linking to `/workspaces/:id/<path>` |
| `pages: { [path]: { title, Component, feature? } }` | at `/workspaces/:id/<path>` by the app's one catch-all route; a core page at the same address always wins |
| `settingsSections: [{ id, title, description?, Component, feature? }]` | at the end of a workspace's Settings navigation, each its own page at `/workspaces/:id/settings/extensions/<id>` |
| `banners: [{ id, Component, feature? }]` | above every page of a workspace |

Components are client components and receive `workspaceId` and `api` — the app's own client
(`api.fetch(path, init)`), so requests carry the session, the CSRF token and the error envelope as
a core page's do. An entry naming a `feature` is shown only when `GET /v1/edition` lists it.

A deployment supplies its own package under the same name, and the web app's dependency resolves to
it. In a pnpm workspace that includes this repository, leave `packages/web-extensions` out of the
workspace and put the deployment's package, named `@orbik/web-extensions`, in it:

```yaml
# pnpm-workspace.yaml of the private repository
packages:
  - orbik/frontend
  - orbik/backend
  - orbik/agents
  - orbik/packages/*
  - "!orbik/packages/web-extensions"
  - cloud/*
```

Next compiles the package with the app (`transpilePackages` names it), so it may be JSX.

## A private repository around this one

The shape Orbik's own cloud uses, and the one this seam was built for:

```
orbik-cloud/
  orbik/          this repository, as a git submodule pinned to a commit
  cloud/api/      a server extension: plans, billing, signup checks, metering
  cloud/web/      @orbik/web-extensions: billing pages, upgrade prompts
  infra/          the deployment's own configuration
```

Its root `package.json` depends on `cloud/api`, so `ORBIK_EXTENSIONS=@acme/cloud-api` resolves from
any process; upgrading core is a submodule bump.

## Checking a change to the seam

There are no automated tests in this repository. To see an extension work, write a throwaway one
outside the repository and name it by its absolute path in `ORBIK_EXTENSIONS` for a scratch API,
worker and scheduler. To see web slots, point `frontend/node_modules/@orbik/web-extensions` at a
throwaway package for a dev server, and put the link back afterwards. Both were done for idea 030
(`.devbar/open/030-open-source-core-and-cloud-layer.md`).
