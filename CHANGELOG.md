# Changelog

What changed in each release of Orbik. Releases are tagged `vX.Y.Z`; upgrading is in
[docs/self-hosting/backups-and-upgrades.md](docs/self-hosting/backups-and-upgrades.md#upgrades).

## Unreleased

- **Docs.** `docs/` is the documentation published at <https://orbik.io/docs>: getting started,
  guides, connecting your AI, self-hosting and a generated MCP tool reference, in the order
  `docs/nav.json` gives. The maintainers' design documents moved to `docs/architecture/`, and
  self-hosting is split into pages under `docs/self-hosting/`. `pnpm lint` checks every link.
- **Setup.** The API's first-run banner prints the setup page's address with the code in it,
  `/setup?key=…`; opening it fills the code in and takes it off the address bar. Typing the code
  still works.
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
