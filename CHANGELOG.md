# Changelog

What changed in each release of Orbik. Releases are tagged `vX.Y.Z`; upgrading is in
[docs/self-hosting/backups-and-upgrades.md](docs/self-hosting/backups-and-upgrades.md#upgrades).

## Unreleased

- **Gemini and Grok, and chat apps first.** Home's **Connect Orbik MCP** opens on **Claude.ai,
  ChatGPT, Gemini, Grok**, ahead of the coding agents, and its second step is a button for each
  app, under the app's own mark, to the settings page where a custom connector is added; Settings →
  Orbik MCP shows the same buttons. Gemini (a custom app) and Grok (a custom connector) sign in to
  Orbik like Claude.ai and ChatGPT. See [Gemini](docs/connect-your-ai/gemini.md) and
  [Grok](docs/connect-your-ai/grok.md).
- **No self-service signup.** Orbik is for a person or an organization running it for its own
  people: accounts come from the setup page, invites, access requests an admin approves, and
  `seed:user`. `ORBIK_SIGNUP` and `ORBIK_SIGNUP_VERIFY_EMAIL` are gone, with the signup form, the
  confirmation link and its page, and Google sign-in making new accounts (it still signs in to
  existing ones). `/signup` is the Request access form. An install still setting
  `ORBIK_SIGNUP=open` or `ORBIK_SIGNUP_VERIFY_EMAIL=true` does not start until the setting is
  removed; `ORBIK_SIGNUP=closed` is accepted and means nothing. The `signup_verifications`
  collection is left to empty itself ([Collections left by earlier releases](docs/self-hosting/backups-and-upgrades.md#collections-left-by-earlier-releases)).
- **Extensions.** `host.checkSignup` and the `signupFields` slot are gone with signup. An
  extension's routes get `http.accounts` (find, create and sign in an account), `http.sendEmail` and
  `http.rateLimit`; `host.checkGoogleSignup` lets Google sign-in make an account for a new address;
  the `signupPage` slot puts a page at `/signup` in place of Request access. See
  [docs/architecture/extensions.md](docs/architecture/extensions.md).
- **An install can have no admin.** `ORBIK_INSTALL_ADMIN=off` is for a deployment administered
  another way: no account is the install's admin (not even the first), there is no Admin page and
  no Request access form, and `/signup` and the sign-in page tell a person to ask for an invite.
  It needs email and refuses `ORBIK_ADMIN_EMAILS` beside it. `GET /v1/edition` says
  `accessRequests`. See [docs/guides/accounts-and-admin.md](docs/guides/accounts-and-admin.md#no-install-admin).
- **Setup can be turned off.** `ORBIK_FIRST_RUN_SETUP=off` is for an install whose first account
  is made another way: the API prints no setup code, `POST /v1/setup` is not served, and the
  sign-in page no longer sends anyone to `/setup` while the install has no account. See [docs/guides/accounts-and-admin.md](docs/guides/accounts-and-admin.md#the-first-account).
- **Sources.** A workspace reads more than its website. **Sources**, in the rail between Brand and
  Agents, lists everything Orbik reads, and **Add a source** takes another site of yours (a
  documentation subdomain, a second domain, the whole of it, one section or a few pages) or pages
  about you elsewhere (a review profile, a directory listing, an article; only the pages listed,
  and their own next pages). Each is read on its own schedule, copied into its own folder under
  `/sources`, and says what it is — documentation, reviews, press — which the knowledge base reads
  it for: a review is quoted as the reviewer's words. A source can be copied only, for search and
  Ask, and never written into the knowledge base. **Found on your website** suggests the profiles
  your site links to. The Crawler leaves Agents: its page is the website's pages under Sources, and
  a running crawl can be stopped. See [docs/guides/sources.md](docs/guides/sources.md).
- **Docs.** `docs/` is the documentation published at <https://orbik.io/docs>: getting started,
  guides, connecting your AI, self-hosting and a generated MCP tool reference, in the order
  `docs/nav.json` gives. The maintainers' design documents moved to `docs/architecture/`, and
  self-hosting is split into pages under `docs/self-hosting/`. `pnpm lint` checks every link.
- **Install with an AI agent.** The self-hosting guide opens with a prompt to give an AI coding
  agent (Claude Code, Codex, Cursor's agent): it checks Docker, chooses free ports, asks for the AI
  keys, starts the install and hands over the setup link, leaving the account to the person.
- **Setup.** The API's first-run banner prints the setup page's address with the code in it,
  `/setup?key=…`; opening it fills the code in and takes it off the address bar. Typing the code
  still works. Once the first account is made, the log says so under the banner, so the link left
  there no longer looks like the next step.
- **Docker install.** `docker compose up` no longer prints `pull access denied … may require
  'docker login'` for Orbik's own images, which it builds rather than pulls. Moving the install to
  another port with `ORBIK_HTTP_PORT` alone now moves its address too (the setup link, invite
  links and sign-in checks named port 8080 until `ORBIK_URL` was set as well). A second install on
  the same machine gets its own containers, images and volumes with `COMPOSE_PROJECT_NAME`; before,
  it took over the first one's. The bundled Qdrant no longer sends its own telemetry, so an
  install sends nothing anywhere unless `ORBIK_TELEMETRY=on`. See
  [docs/self-hosting](docs/self-hosting/README.md#when-port-8080-is-taken).
- **Workspaces and crawling.** A website address typed without `https://` (`example.com`) is taken
  to be HTTPS rather than refused, in the new-workspace form and the crawler's start address and
  sitemaps.
- **Crawling a site typed without (or with) `www.`.** When the start address only redirects to the
  same name with or without `www.`, the crawl moves to the host that answers: pages are found and
  fetched at their real addresses, sitemap entries and absolute links on that host are followed,
  and its robots.txt is the one obeyed. Before, such a site was read through a redirect per page
  and mostly not found. Relative links are now resolved against the address a page was served
  from, or its `<base href>`, rather than the address asked for. A site already crawled under the
  name that redirects is fetched again at its real addresses by its next crawl, which spends crawl
  budget where one is set and changes the pages the knowledge base is chosen from; the old
  addresses stay listed as duplicates. See [docs/guides/crawling.md](docs/guides/crawling.md#when-your-address-redirects-to-www).
- **Agents and Ask.** A model that calls a tool it was not given (`json`, to hand over its answer,
  is the usual one) is told so and goes on to answer, instead of the run failing with
  `INVALID_AGENT_EVENT` after its work was done. Seen with Ask on its first question.
- **AI keys.** The OpenAI key is the required one: the embeddings behind search need it. The
  reasoning calls (the Library's knowledge base, Ask, llms.txt, the brand) run on Anthropic or
  OpenAI, chosen with `ORBIK_AI_PROVIDER`; unset, Anthropic when its key is set and OpenAI
  otherwise, so an install with only the OpenAI key runs everything on it. On OpenAI the brand
  chat can read an uploaded PDF brand guide too.
- **Crawler.** The User-Agent's default contact page is now <https://orbik.io/docs/orbikbot>
  rather than the file on GitHub, which stays where it is for 0.1.0 crawlers.
- **Docker install behind another proxy.** `ORBIK_TRUSTED_PROXIES` in `.env` tells the install's
  proxy to trust the one in front of it (nginx on the same server: `private_ranges`). Without it
  an HTTPS install behind nginx could not keep anyone signed in: every request reached the API as
  plain HTTP, so its `Secure` session cookie was never set. The API now says so in its log
  (`session.request_not_https`), and [docs/self-hosting/https.md](docs/self-hosting/https.md#behind-another-proxy)
  walks through nginx and Certbot. Editing `deploy/Caddyfile` is no longer needed.
- **Library.** While the Knowledge base agent is paused, the structure step says that proposals
  come once it is set to work, rather than showing a spinner that never ended.
- **Light mode.** New colours: cool greys in place of green-tinted ones, and stronger blue, orange
  and red. Main buttons are the brand's bright lime with dark text, as in dark mode, instead of
  olive. The Orbik logo is black, and the workspace's initial sits on a grey tile.
- **Settings → Account and Admin.** Changing your password and the install's Admin page (access
  requests, password reset links) are sections of **Settings**, under **You**, in place of items in
  the account menu. `/account/password` and `/admin`, which the access-request email names, lead
  there; with no workspace yet they are still pages of their own. The account menu's source link
  says **Star us on GitHub** unless `NEXT_PUBLIC_ORBIK_SOURCE_URL` names another source.
- **Library.** The Knowledge base agent is a small icon at the start of the line along the foot of
  the Library, lime while it is set to work, with a dot circling it while it writes; it opens the
  switch, **What changed** and **Source ledger**, which took a strip at the foot of the explorer.
- **Agents.** **Agents → Knowledge base** is the agent's own page rather than a second copy of the
  Library: its switch, what it is waiting on, the folders it writes into, the source ledger, what
  its last run changed and its recent runs, with links into the Library. While any agent is
  working, its row and the rail's **Agents** item are marked as working, whoever started it.
- **Home.** The ask box appears once Ask can answer; before the first crawl has finished, Home no
  longer shows a box saying why it cannot. The workspace's rail is a little narrower.

## 0.1.0 — 2026-11-09

The first public release.

- **Crawler.** Crawls a site from its home page and sitemaps, obeys `robots.txt` (`orbikbot`) and
  the site's pace, and renders every page as Markdown. Its User-Agent names a contact page the
  operator sets with `ORBIK_CRAWLER_CONTACT_URL` ([docs/orbikbot.md](docs/orbikbot.md) by default).
- **Library.** A word-for-word copy of every crawled page under `/sources/website`, and a
  knowledge base above it that a model writes from the pages that matter most, in top-level
  folders the person chooses. People and agents both edit it; what a person writes is kept.
- **Search and Ask.** A retrieval index in Qdrant, and a chat that answers from the Library with
  citations.
- **Brand.** The Design system agent derives a site's colours, type, components and logo by
  rendering its pages; people add their own files and change the brand by talking to it, with
  every change recorded and reversible.
- **llms.txt.** An agent that drafts a site's `llms.txt` for a person to publish.
- **Orbik MCP.** Your own AI (Claude, ChatGPT, Claude Code and others) reads a workspace's
  Library, sources, `llms.txt` and brand over MCP, with a pasted token or by OAuth sign-in; one
  credential can cover several workspaces, and may write to the Library.
- **Workspaces and people.** Owners, admins, members and read-only members, invite links, an
  install Admin page with access requests, and password reset by email or by an admin's link.
- **Self-hosting.** `docker compose up` from a fresh clone: one-time setup code, generated secrets,
  HTTPS through Caddy for a domain, and every limit unlimited. Bring your own Anthropic and OpenAI
  keys; every model call is listed in the AI call log.
- **Extensions.** Plans, pages and hooks are added through the extension seam
  ([docs/architecture/extensions.md](docs/architecture/extensions.md)), never by changing core. Data migrations run at start.
- **Usage statistics** are off by default; `ORBIK_TELEMETRY=on` sends one anonymous ping a day.
