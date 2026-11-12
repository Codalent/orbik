# Repository agent instructions

## Optional: devbar

The API and the web app can carry [devbar](https://github.com/Codalent/devbar), a small widget for
logging tasks, bugs and ideas from the running app into Markdown files under `.devbar/` (one file
per item, a folder per status). It is a developer aid, off unless `ORBIK_DEVBAR=true` and
`ORBIK_DEVBAR_KEY` (24+ letters, digits, `-`, `_`) are set in `backend/.env`; `.devbar/` is
git-ignored, so nothing it writes is committed. With it on, the API mounts devbar at `/v1/devbar`,
and every request must carry the key as an `X-Devbar-Key` header or a `key` query parameter (a
request without it gets the API's 404, as if devbar were off). A browser gets the key by opening any
page of the web app once with `?devbar=<key>` (`?devbar=off` forgets it); without a key the web app
asks nothing. Changing the switch or the key needs an API restart. Screenshots make items a few MB,
so a proxy in front of the API must allow that body size on `/v1/devbar/`.

## Documentation

`docs/` is the documentation, and the marketing site (Codalent/orbik-marketing) publishes it at
`https://orbik.io/docs`: it fetches this folder from GitHub when it builds and renders each page in
`docs/nav.json`. A page's address is its path (`docs/self-hosting/https.md` →
`/docs/self-hosting/https`, a folder's `README.md` → the folder's address); its title is its one
`# H1` and its description the paragraph after it. Write plain GitHub Markdown that reads well on
GitHub too: relative `.md` links (the site rewrites them, and sends links to code to GitHub), GitHub
alerts (`> [!NOTE]`), no raw HTML and no front matter. A file not in `nav.json` stays on GitHub
only; a renamed page gets its old path in `redirects`. `pnpm lint:docs` (part of `pnpm lint`)
checks nav.json and every link and anchor.

- The user pages (`getting-started/`, `guides/`, `connect-your-ai/`, `self-hosting/`) are for
  people who run or use an install. When a change alters what they describe — a setting, a label
  on a page, a role, a tool — change the page in the same pull request.
- `docs/architecture/` holds the design documents maintainers read before changing a part; the
  paragraphs below name the one to read for each.
- `docs/connect-your-ai/tools.md` is generated from the MCP tool surface: run `pnpm docs:tools`
  after changing a tool's description or schema. The lint fails while it is stale.
- `docs/orbikbot.md` must not move: release 0.1.0's crawler names its GitHub address in every
  User-Agent. Later releases name `https://orbik.io/docs/orbikbot`.

## Web app UI

Read [docs/architecture/ui.md](docs/architecture/ui.md) before building or restyling a page in `frontend/`: the colour
meanings, the type scale and the shared pieces in `frontend/src/components/ui/` (`PageHeader`,
`Panel`, `RowList`, `StatTile`, `Pill`, `Dialog`, `Select`, `Skeleton`). New pages use them rather
than drawing their own boxes, badges or confirm prompts.

## Verification policy

There are no automated tests in this repository, by the maintainers' decision. Do not
write, run, or ask for unit, contract, integration, or browser tests.

Every change is verified against the development processes that are already running:

| Process | Where | How it reloads |
|---|---|---|
| API | `127.0.0.1:4100` | `node --watch`: a saved file restarts it |
| MCP endpoint | `POST 127.0.0.1:4100/mcp` | part of the API; no process of its own |
| Web app | `127.0.0.1:3100` | Next dev server: hot reload |
| Agents worker and scheduler | background | `node --watch` |
| MongoDB | `127.0.0.1:27017`, database `orbik` | always on |
| Qdrant | `127.0.0.1:6333` (REST), `6334` (gRPC) | always on; not managed by the repo |
| Google Chrome | installed on the worker's machine | started and stopped by each Design system agent run |

- Exercise the change where it lives: `curl` the API or Qdrant, query MongoDB with `mongosh`, open
  the page in the browser, or run a throwaway script from the workspace directory against the live
  database. Report what you observed, not what a test would have checked.

- Do not stop, start, or restart the development processes unless one is genuinely stuck, and say
  so when you do. The watchers pick up saved files on their own.
- Never run a production build (`next build`, `pnpm build`, or similar) unless the user asks.
- Linting the touched files with `eslint` is fine; it is fast and touches no process.

The MCP endpoint is how a person's own AI reads a workspace's knowledge base. It is a router on the
API and the one route that authenticates with a bearer token rather than a session. Two credentials
reach it: a token minted under **Orbik MCP** on the workspace settings page, which is what an
editor pastes, and an OAuth access token, which is what Claude.ai and ChatGPT get after somebody
approves them — Orbik is also the authorization server for the second, under `/oauth/*` and
`/.well-known/*`, with the consent screen at `/oauth/consent` in the web app. Either credential may
cover several of the workspaces its holder can read (all of them, or a selection); its tools then take a
`workspace` argument and it gets `workspace_list`, while one covering a single workspace sees the
same surface as before (docs/architecture/library.md § "One credential, a set of workspaces").

The endpoint also serves a workspace's design system: `brand_get`, `brand_tokens`, `brand_render`,
`brand_assets` and `brand_asset`, with images as signed links that need no credential and expire in
an hour. Those links are made with `ORBIK_ASSET_URL_SECRET` in `backend/.env`; without it every
other tool still answers and the brand tools say `ASSET_LINKS_NOT_CONFIGURED` where a link would
be. Read docs/architecture/design-system.md before changing those tools, the asset routes or the signing.

Verify the endpoint with `curl` against `127.0.0.1:4100/mcp`, or by pointing a real client at it:
`claude mcp add --transport http orbik http://127.0.0.1:4100/mcp --header "Authorization: Bearer
orbm_…"` for the pasted path. Read docs/architecture/library.md § "Outside agents" before changing the
endpoint, the tool surface, the token routes or anything under `/oauth`.

An install reached over HTTPS needs two settings in `backend/.env` to agree with the addresses
people and AI clients use. The first entry of `FRONTEND_ORIGINS` is the web app's own address:
invite links, the OAuth consent screen and the Library links MCP results carry are built from it.
`PUBLIC_API_URL` is the API's public address: it is the `issuer` and the `resource` the OAuth
discovery documents advertise, and a client compares them character for character, so with it
unset they name `http://127.0.0.1:4100` and Claude refuses the server. Both are read once at
startup. To check what clients are told, `curl <api>/.well-known/oauth-authorization-server` and
`<api>/.well-known/oauth-protected-resource/mcp`: every address in both must start with
`PUBLIC_API_URL`. The sign-in path is verified against that public address: `claude mcp add
--transport http orbik <api>/mcp` with no header makes Claude Code discover the authorization
server and sign in.

Qdrant holds the retrieval index (`orbik_chunks`) that `content.search` and the chat read. It is a
separate binary rather than something this repository starts, and its data directory sits outside
the repository; the README's Qdrant section installs it and runs it as a service. Docker installs
get it from `compose.yaml`.

Qdrant reads no `.env` of its own. `QDRANT_URL` and `QDRANT_COLLECTION` stay commented out in
`backend/.env` and `agents/.env` because the defaults in `packages/retrieval/src/environment.js`
are already `http://127.0.0.1:6333` and `orbik_chunks` for both processes; set them in both or
neither.

With Qdrant down, indexing and search report `INDEX_UNAVAILABLE` and record the reason on the
`index_state` rows they could not finish; nothing crashes, and the next scheduler tick retries.
`ORBIK_OPENAI_API_KEY` in `agents/.env` is the key the embeddings are made with, and the one key
the docs call required. Every reasoning call — agent runs, the Library chat and the short texts
and structured answers plain-code agents ask for — goes to one provider, `ORBIK_AI_PROVIDER`
(`anthropic` or `openai`; unset, Anthropic when `ORBIK_ANTHROPIC_API_KEY` is set and OpenAI
otherwise), through that provider's table in `agents/src/ai/model/modelRouter.js`
(`ANTHROPIC_ROUTES`, `OPENAI_ROUTES`; docs/architecture/ai-execution.md). The worker logs the choice
at start (`ai.provider`). Without the chosen provider's key, model runs fail saying no AI provider
is configured and the Library's write run is not started; without the OpenAI key, indexing is
skipped with a recorded reason and the Library and ask pages say the index is not configured.
Every page is still copied into the Library's source layer: that step calls no model. The API
reads `ORBIK_OPENAI_API_KEY` from `backend/.env` — it searches the index for MCP clients, and without the key `content_search`
refuses with the reason while every other MCP tool still answers. The two must agree on
`QDRANT_URL`, `QDRANT_COLLECTION` and `ORBIK_EMBEDDING_MODEL` or the API would search an index
nothing wrote.

## Workspace members

A workspace has one **owner**, its `ownerId`, and other people join it as **admin**, **member** or
**read-only**. The roles are ordered read-only < member < admin < owner, and every workspace route
checks a minimum through `requireWorkspaceAccess` (`backend/src/services/workspaceAccess.js`): a
workspace the caller has no access to answers **404**, exactly as a missing one does, and a role
too low for the action answers **403** `ROLE_INSUFFICIENT`. Reading is read-only and up; editing
the Library, crawling and agents need member; inviting, changing roles and removing people and
clearing crawled data need admin; nobody can change or remove the owner.
Membership is `workspace_members` (one row per person other than the owner, with `role` and
`invitedBy`), invites are `workspace_invites` (the token stored only as a hash, seven days, one
use). How many members a workspace may have is the owner's plan's `maxMembersPerWorkspace`, which
only an extension sets (below); core has no limit.

- `GET /v1/workspaces/:id/members` — the owner and every member, with role and email.
- `POST|GET /v1/workspaces/:id/members/invites`, `DELETE …/invites/:inviteId` — make (the link is
  returned once), list and revoke invites; admin and up.
- `PATCH|DELETE /v1/workspaces/:id/members/:userId` — change a role or remove; admin and up.
- `DELETE /v1/workspaces/:id/members/me` — leave; anyone but the owner.
- `GET /v1/invites/:token`, `POST /v1/invites/:token/accept` — public: describe and accept; an
  address with no account sets a password and the account is created.
- `PATCH /v1/workspaces/:id` — `name` and/or `websiteUrl`; admin and up. A website on the same
  hostname moves the crawl's start address (unless one was chosen on the Crawl page) and keeps
  everything; another hostname is another site: refused with `409 SITE_CHANGE_UNCONFIRMED` until
  sent with `confirmSiteChange: true`, refused while a crawl runs, and then clears the crawled pages
  as Clear crawled data does, drops the old host's sitemaps and requests a crawl of the new site.
  The Library and the brand are left as they are.
- `DELETE /v1/workspaces/:id` — the owner only, with `{"confirmName": "<the exact name>"}`
  (`400 CONFIRMATION_MISMATCH` otherwise); `409 WORKSPACE_BUSY` while a run or claimed job is
  executing for it. Removes every per-workspace record (`workspaceErasureRepository.js` lists the
  collections and what is deliberately kept: the owner's `crawl_budget_periods`), its Qdrant points,
  its GridFS brand files, deletes tokens and grants that read only it and narrows the rest, clears
  users' `selectedWorkspaceId`, then the `workspaces` row last, so a failure half way is finished
  by retrying. With Qdrant down the
  deletion completes and records the leftover on its `workspace_deletions` row (remove the points
  by hand with a Qdrant delete filtered on `workspaceId`); extensions are told `workspace.deleted`.

An invite link from the settings page is the way to add a person. The first account of an install
is made on the setup page (`/setup`), with the one-time code the API prints to its log while no
account exists, or by `seed:user`; `ORBIK_SIGNUP=open` in `backend/.env` lets anyone sign up
(`/signup`). With `ORBIK_SIGNUP_VERIFY_EMAIL=true` too, signup makes no account: it keeps the
address and the password's hash in `signup_verifications` (one row per address, a day) and emails a
`/verify-email/<token>` link; confirming it (`POST /v1/auth/signup-verifications/:token/confirm`)
makes the account, signs the browser in and only then tells extensions `account.created`. It needs
email (SMTP or an extension's sender), or the API refuses to start.

While signup is closed, `/signup` is a **Request access** form: the address goes to
`access_requests` (one row per address; `POST /v1/access-requests`, the same 202 whoever asks) and
shows on the install's **Admin** page (`/admin`, in the account menu), where an admin approves it —
a one-time `/join/<token>` link, seven days, emailed when SMTP is set and shown to the admin either
way — or dismisses it. The install's admins are the addresses in `ORBIK_ADMIN_EMAILS`, or with it
unset its first account; everyone else gets 404 from `/v1/admin/*`. **Forgot password** on the
sign-in page emails a one-time `/reset-password/<token>` link (an hour, `password_resets`, only the
hash stored); using it sets the password, deletes every other session of the account and signs
this browser in. An install without email cannot send one, so the page says to ask the admin, who
makes the link on the Admin page or with `pnpm --dir backend run reset:password -- --email …`.
`GET /v1/edition` says which (`passwordReset`: `email` or `admin`), and the session's
`user.isAdmin` whether to show the Admin page. The logo on every signed-out page links to
`https://orbik.io` (`NEXT_PUBLIC_ORBIK_HOME_URL` overrides it).

Everything a member does is **paid by the owner**: the crawl budget and the AI
call log resolve the workspace's owner (`crawlBudget.ownerFor`, `agents/src/ai/executeRun.js`),
and no budget row is ever made for a member. What a person starts — a crawl, a run, an Ask
question — records `startedBy`, and Activity names them. An MCP token or OAuth grant covers the
workspaces its holder can read; the write scope needs member or above on every workspace it
covers, and a removed person's credentials stop reading that workspace at once.

To verify a change here, use a scratch copy of the database and a second account: make it a member
with an invite (or a `workspace_members` row), and sign requests in as either person by inserting a
`sessions` row and sending the cookie `seo_session_<env>=s:<sid>.<base64 HMAC-SHA256(sid,
SESSION_SECRET) without '='>`, URL-encoded; writes also need the CSRF token from `GET
/v1/auth/session` and an `Origin` in `FRONTEND_ORIGINS`. `seed:user` reads the password from a
terminal; from a script, wrap it: `script -qec "pnpm --dir backend run seed:user -- --email …"
/dev/null`.

## Operational commands

```sh
# Make an account from a terminal (the setup page does the same for an install's first one;
# everyone else joins by invite link, or signs up when ORBIK_SIGNUP=open)
pnpm --dir backend run seed:user -- --email user@example.com

# Print a one-time password reset link for an account (an hour), for an install that sends no
# email; the Admin page makes the same link
pnpm --dir backend run reset:password -- --email user@example.com

# Top up an account's crawl budget, which pays for page fetches. Only meaningful when an extension's
# plan limits set a monthly allowance; without one every month is unlimited and this adds nothing.
# It adds to the CURRENT month only, and next month starts from the plan's allowance again.
pnpm --dir backend run grant:crawl-budget -- --email user@example.com --pages 50000
```

## Open source, extensions and the Docker install

This repository is the open-source, self-hostable Orbik, complete on its own: with no extension
loaded every plan limit is unlimited, every agent runs, and `GET /v1/edition` says `community`. A
deployment — Orbik's own cloud among them — adds plans, billing and pages only through the
extension seam (docs/architecture/extensions.md): server extensions named by `ORBIK_EXTENSIONS`
(`@orbik/extensions`, loaded by the API, the worker, the scheduler and `grant:crawl-budget`) and the
web app's slot package `@orbik/web-extensions`, empty here. Plan limits are read through the
loaded host (`limitsFor`, or `activeExtensions()` deep in the worker), never from a stored row.
Never import anything from outside this repository: `eslint.boundary.mjs` fails the lint on it, and
core must start and serve every page with no extension loaded. To check a change to the seam,
write a throwaway extension outside the repository and name it by absolute path for a scratch API,
worker and scheduler; for the web slots, point `frontend/node_modules/@orbik/web-extensions` at a
throwaway package for a dev server and put the link back.

Data that must change shape for new code to read it changes through a migration in
`packages/migrations/src/migrations.js`, which the API, the worker and the scheduler run at start
under a lock (`system_state`, `_id: "migrations"`), each recorded in `migrations`. The first,
`2026-11-09-retire-seo-agents`, removed the schedules, setups and queued runs of the SEO agents,
which now live outside this repository; their collections are left in place (docs/self-hosting/backups-and-upgrades.md
§ "Collections left by earlier releases"). `system_state` also holds the setup code (`setup`,
only while there is no account), the install's anonymous id for the usage ping (`install`) and
generated secrets (`secrets`).

The scheduler sends an anonymous usage ping once a day (`agents/src/telemetry.js`) only when
`ORBIK_TELEMETRY=on` (off by default); docs/self-hosting/usage-statistics.md lists exactly what it carries. It must never carry
content, an address, a name, an email or a key.

`compose.yaml` and `deploy/` are the Docker install (docs/self-hosting/): three images built
from `deploy/Dockerfile` (`web`, `api`, `agents` with Chromium), MongoDB, Qdrant and Caddy, at
one address — the web app calls the API on its own origin when `NEXT_PUBLIC_API_BASE_URL` is
unset. Building the images is a production build: do it only when asked, and run the stack on
loopback ports with its own volumes, never against your development database or Qdrant.

Agent definitions are code and nothing else: `packages/agent-definitions/src/` is the only copy,
read by the API for its catalog and by the worker to execute a run. There is nothing to publish
and no `agent_definitions` collection; saving a definition restarts the processes that import it,
and the next run follows it. A definition's `version` is a label recorded on runs and AI calls,
not something that selects what runs.

The Design system agent runs in the agents worker and needs Google Chrome installed on that
machine: it launches Chrome with `chrome-launcher` and drives it with `puppeteer-core` to render
up to eight of a workspace's pages. Without Chrome a run fails with `CHROME_UNAVAILABLE`; without
`ORBIK_ANTHROPIC_API_KEY` it still renders and stores what it observed, and records that the proposal
was skipped. A run that finds the site's styling unchanged ends in a couple of seconds as
`STYLE_UNCHANGED`: to verify a change to the agent, start it from **Re-derive** on the Brand page
(`/workspaces/:id/brand`), which sends `{"force": true}`. A person can also drop their own files on the
Brand page — logos, a PDF brand guide, fonts, token files — and talk to the Ask panel docked beside
it, which answers there with the `brand-chat` agent and changes the brand as them; every change is
in `brand_changes` with what it replaced, and can be undone. Uploads are the one session route with
a raw body (20 MB), so nginx's `client_max_body_size` must allow it on `/v1/workspaces/*/brand/uploads`.
An uploaded font is never served over MCP. It stores images in MongoDB GridFS
(`brand_assets_files`), so inspect `brand_assets` for what a run kept. On a hosted Linux worker it
also needs fallback fonts installed. Read docs/architecture/design-system.md before changing the agent, the
`brand.*` tools or the Brand API.

The Business Knowledge Base and llms.txt agents read the Markdown the crawler renders and write
documents that outlive each run — the **Library**, a tree of folders and files that agents *and
people* both edit, and the llms.txt file a person publishes. Both track what they have already
accounted for by content hash, so a second run only reads what changed. An agent writing in the
Library must keep every block a person wrote; the tools enforce it.

The Library has two layers. Under `/sources/website` is a copy of every crawled page, word for
word, written by code when a crawl finishes (`sources.mirror`): no model reads a page in order to
store it, and nothing but that job may write there. The knowledge base above it is written by a
model from the pages *code* chose for it — by how many pages link to each, up to 80 — so what a
site costs follows the size of its knowledge base and not its page count. To verify a change
there, inspect `source_note_state` for what the mirror did with each page (`mirroredAt`, `chosen`
and `chosenReason`, `skipped`), `knowledge_sources` under the slug `business-knowledge-base` for
the reason a person is shown, and `ai_calls` to confirm the mirror made none. A write run is
started by the scheduler, never by hand, when a chosen page moved; it costs about half a dollar on
the development site, so change a chosen page or use **Include** in the source ledger rather than
looping one. The Library's top level is folders the *person* chose (`00 Start Here`, `01 Company`,
… by default) from two or three a model proposed (`structure.suggest`, about ten cents); the first
write run, and a rebuild's, waits for that choice (`STRUCTURE_NOT_CHOSEN` from the scheduler), and
agents may write nothing at the top level. The choice and the proposals are `structure` on the
knowledge agent's `agent_setups` row; the overview and the index are found by `role` on their node,
not at fixed paths, and a rename rewrites every link to what moved. `library_structures` held the
sections the top level used to be shown under and is no longer read. Read docs/architecture/library.md before
changing either agent, the mirror, the selection, the `library.*`/`content.*` tools, or the
Library API.
