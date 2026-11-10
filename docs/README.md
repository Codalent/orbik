# Orbik documentation

Orbik is open-source software you run yourself. It crawls your website into a Library your team
and your own AI both read from, and keeps it current.

The **Library** is a tree of Markdown files: a word-for-word copy of every page of your site, and
a knowledge base above it that a model writes from the pages that matter most. People and agents
edit it together, and what a person writes is kept. Orbik also derives your site's **brand** —
colours, type, logo — drafts an **llms.txt** for you to publish, and serves all of it to Claude,
ChatGPT, Cursor and other AI clients over **MCP**.

## Where to start

- [Quickstart](getting-started/quickstart.md) — install Orbik, crawl your site and connect an AI.
- [Concepts](getting-started/concepts.md) — the words the rest of these docs use.

## Using Orbik

- [Crawling your site](guides/crawling.md) — what the crawler reads, how often, and its manners.
- [The Library](guides/library.md) — the source copy, the knowledge base and editing it.
- [Ask](guides/ask.md) — a chat that answers from the Library, with citations.
- [Brand](guides/brand.md) — the design system Orbik derives, and correcting it.
- [llms.txt](guides/llms-txt.md) — the file a site publishes for language models.
- [Workspaces and members](guides/workspaces-and-members.md) — roles, invites and the website.
- [Accounts and admin](guides/accounts-and-admin.md) — signing in, access requests and resets.

## Connect your AI

- [Overview](connect-your-ai/README.md) — tokens, sign-in, workspaces and writing.
- [Claude.ai and Claude Desktop](connect-your-ai/claude.md),
  [ChatGPT](connect-your-ai/chatgpt.md), [Claude Code](connect-your-ai/claude-code.md),
  [Cursor and others](connect-your-ai/cursor-and-others.md).
- [Tool reference](connect-your-ai/tools.md) — every tool your AI can call.

## Run it yourself

- [Self-hosting](self-hosting/README.md) — install with Docker.
- [Configuration](self-hosting/configuration.md), [A domain with HTTPS](self-hosting/https.md),
  [Backups and upgrades](self-hosting/backups-and-upgrades.md),
  [Usage statistics](self-hosting/usage-statistics.md).

## Reference

- [OrbikBot](orbikbot.md) — the crawler, for site owners who found it in their logs.
- [Architecture](architecture/README.md) — how Orbik works inside, for contributors.

These pages live in the [`docs/` folder](https://github.com/Codalent/orbik/tree/main/docs) of
Orbik's repository. A correction is a pull request away.
