# Extensions

Orbik is open source and complete on its own: with no extension loaded every limit is unlimited,
every agent runs, and the edition is `community`. An **extension** is how a deployment adds to it
without changing it — plans and their limits, billing, an admin back office, metering, more pages
in the web app. Orbik's own cloud is built this way, from a separate private repository that
includes this one; nothing of it is in this repository.

There are two halves, one for the server processes and one for the web app:

| | Where | What it can do |
|---|---|---|
| Server extensions | `ORBIK_EXTENSIONS`, loaded by the API, the worker, the scheduler and `grant:crawl-budget` | plan limits, events, the edition and its features, API routes, scheduler loops, worker agents, agents in the catalog with their tools and runtimes, the email sender, signup checks |
| Web extensions | the `@orbik/web-extensions` package the web app imports | rail items, pages, settings sections, banners, agents' pages, account pages, account menu items |

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
  account, or, with `ORBIK_SIGNUP_VERIFY_EMAIL=true`, before the confirmation link is sent. `check`
  gets `{ email, fields, request }`: `fields` is what the extension's `signupFields` collected on the
  signup page (below), by field id, such as a captcha's token or a consent; `{}` when there are none.
  Throw an error with a 4xx `status` and a `code` to refuse it with that answer, which the signup
  page shows. With confirmation on, `account.created` is told when the link is confirmed, not when
  the form is sent.
- `host.setEmailSender(send)` — one extension per deployment; replaces SMTP. `send({ to, subject,
  text, html? })`.

### Scheduler and worker

- `host.addLoop({ start, stop })` — started and stopped with the scheduler's own loops.
- `host.addAgent({ name, version, handlers })` — validated as a core agent is; its job types are
  queued and claimed like any other. A name already taken is refused. This is a queue agent, a set
  of job handlers; an agent a person sees in the catalog, runs and schedules is the next section's.

### Agents

An extension can add agents to the catalog: listed by `GET /v1/agents`, started from the API,
put to work on a schedule, executed by the worker, refused outside a plan's `agents` exactly as a
core agent is, and recorded in `agent_runs`, `agent_run_events` and `ai_calls` like one.

- `host.addAgentDefinitions(...definitions)` — every process. A definition has the shape
  `parseAgentDefinition` in `@orbik/protocol` accepts, the shape of core's own in
  `packages/agent-definitions/src/`.
- `host.addTools(...tools)` — every process (definitions are checked against them wherever the
  catalog is read; only the worker calls them). A tool is `{ name, description, inputSchema,
  parseInput(input, errors), handler(input, context) }`: `name` is namespaced (`acme.listIssues`),
  `parseInput` pushes a message onto `errors` for anything it refuses and returns the parsed input,
  and `handler` gets `{ database, retrieval, scope, signal, readingBudget }`, where `scope` is the
  run's own (`workspaceId`, `siteId`, `agentSlug`, `runId`) and never something the model wrote.
  Throw `ToolError` from `@orbik/tools` to refuse with a code. An extension's tools are given only
  to the definitions that name them, and are not served over MCP.
- `host.addRuntime(requirement, build)` — worker only. A **plain-code runtime**: code that
  executes a definition itself, chosen for any definition whose `runtimeRequirements` names
  `requirement`; a definition that names no plain-code runtime is executed by the model, with its
  tools. `build(collaborators)` is called once when the worker starts, with what core's own
  plain-code runtimes get: `config`, `database`, `logger`, `retrieval` (the index, or null with
  `retrievalReason` saying why), `writeText` and `writeStructured` (a short text, or one object of
  a fixed shape, from the model; recorded in `ai_calls` with the run they belong to, and never
  throwing: they answer `{ skipped, reason }` or `{ failed, reason }` instead) and `AgentError`.
  It returns `{ run(request) }`.

`run({ definition, input, tools, signal, isCancelled, trace })` is an async generator. It yields
the run's events (`AGENT_EVENT_TYPES` in `@orbik/protocol`: `started`, `progress` with a `message`,
`tool-started` and `tool-completed` with a `tool`, `completed` with the `result`) and returns
`{ result, usage }`. `tools` is the run's registry (`tools.invoke(name, input, signal)`), holding
the tools the definition names. Pass `trace`, with `agentSlug` and `agentVersion` added, to
`writeText` and `writeStructured`, so the call log names the run. To fail the run with a code and a
message a person can act on, throw `new AgentError({ code, message, retryable: false })`; anything
else is recorded as `UNEXPECTED_ERROR`.

The API, the worker and the scheduler add these to their catalog right after loading extensions
(`extendAgentCatalog` in `@orbik/agent-definitions`), each definition checked as a core one is. A
malformed definition, a slug or tool name core already has, a tool no one provides, or a runtime
requirement core already runs stops the process, as a failed extension does. In the web app such
an agent has the generic agent page at `/workspaces/:id/agents/<slug>` (its summary, a Run button
and its runs). An `agentPages` entry in the web extension lists it in the Agents overview and may
give it a page of its own ([Web extensions](#web-extensions)). Remove an agent a schedule names
and the scheduler disables that schedule (`AGENT_NOT_AVAILABLE`) rather than fail it every week.

```js
host.addAgentDefinitions({
  slug: "acme-page-count", version: 1, name: "Page count", summary: "Counts the crawled pages.",
  instructions: "Plain code.", tools: ["acme.pageCount"], capability: "fast",
  inputSchema: { type: "object" }, outputSchema: { type: "object" },
  runtimeRequirements: ["acme-page-count", "crawl-dataset"],
});
host.addTools(pageCountTool);
if (host.process === "worker") {
  host.addRuntime("acme-page-count", ({ writeText, AgentError }) => ({
    async *run({ definition, tools, signal, trace }) {
      yield { type: "started" };
      const { pages } = await tools.invoke("acme.pageCount", {}, signal);
      if (!pages) throw new AgentError({ code: "NOT_CRAWLED", message: "Crawl the site first.", retryable: false });
      const summary = await writeText({ system: "…", prompt: `Pages: ${pages}`, signal,
        trace: { ...trace, agentSlug: definition.slug, agentVersion: definition.version } });
      const result = { pages, summary: summary.text ?? null };
      yield { type: "completed", result };
      return { result, usage: null };
    },
  }));
}
```

## Web extensions

The web app imports `@orbik/web-extensions` and renders its exports. In this repository the package
(`packages/web-extensions`) exports them all empty, and the app renders exactly as it would without
them. A deployment's package may leave any of them out.

| Export | Rendered |
|---|---|
| `railItems: [{ id, name, icon, path, feature? }]` | in the workspace rail, after the agents and before Settings, linking to `/workspaces/:id/<path>` |
| `pages: { [path]: { title, Component, feature? } }` | at `/workspaces/:id/<path>` by the app's one catch-all route; a core page at the same address always wins |
| `settingsSections: [{ id, title, description?, Component, feature? }]` | at the end of a workspace's Settings navigation, each its own page at `/workspaces/:id/settings/extensions/<id>` |
| `banners: [{ id, Component, feature? }]` | above every page of a workspace |
| `agentPages: { [slug]: { name, icon?, Component?, feature? } }` | an agent a server extension added to the catalog ([Agents](#agents)), in the Agents overview and the workspace's agent lists, linking to `/workspaces/:id/agents/<slug>`; with a `Component` that page is the extension's (it gets `agentSlug` too), without one the generic agent page. A slug core has a page for keeps core's |
| `accountPages: { [path]: { Component, feature? } }` | at `/account/<path>`, about the signed-in account rather than a workspace, for anyone signed in (a person with no workspace yet included), in the Admin page's frame; the component draws the page, heading included, and gets `path` and `api` |
| `signupFields: [{ id, Component, feature? }]` | in the signup form, above its button. The component gets `onChange(value)`, to set the field's text (or `null` to drop it), and `attempt`, which counts the times the form was sent, so a one-use token such as a captcha's can be renewed after a refusal. The values travel with the signup as `extensions` and reach the API's `checkSignup` as `fields` (`id`: lowercase letters, digits and dashes; at most 10 fields of 4096 characters) |
| `userMenuItems: [{ id, label, href, icon?, feature? }]` | in the account menu, after Admin and before Source code; `href` is a path in the app (`/account/billing`) or an `https://` address, opened in a new tab |

Components are client components and receive `workspaceId` (on a workspace's pages) and `api` — the app's own client
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

In such a workspace the dependencies are installed at its root, above this repository, so set
`NEXT_WORKSPACE_ROOT` to that root (an absolute path, or one relative to `frontend/`) for every
`next` command the web app runs there. It becomes the app's `outputFileTracingRoot`, which is the
root Turbopack resolves modules from and the most it compiles: left at this repository, `next dev`
cannot find `next` itself, nor a deployment's package beside `orbik/`. Unset, it is this
repository, as before.

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
throwaway package for a dev server, and put the link back afterwards. Keep the package inside this
repository, in a git-ignored place such as `frontend/node_modules/.throwaway/`: the dev server
compiles nothing outside it, and from there `react` and `lucide-react` resolve as the app's do. Both were done for idea 030
(`.devbar/open/030-open-source-core-and-cloud-layer.md`).
