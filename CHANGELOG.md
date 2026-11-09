# Changelog

What changed in each release of Orbik. Releases are tagged `vX.Y.Z`; upgrading is in
[docs/self-hosting.md](docs/self-hosting.md#upgrades).

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
  ([docs/extensions.md](docs/extensions.md)), never by changing core. Data migrations run at start.
- **Usage statistics** are off by default; `ORBIK_TELEMETRY=on` sends one anonymous ping a day.
