# Architecture

How Orbik works inside, written for the people who change it: the design of each part, the
decisions behind it, and what is not finished.

These pages assume you have the repository open. They name files, collections and environment
variables, and they are what a contributor — or a coding agent — reads before changing that part.
To use or run Orbik, start with the [introduction](../README.md) instead.

- [The Library](library.md) — the source layer, the knowledge base, the retrieval index, Ask, the
  Library and llms.txt agents, the Library API and the MCP endpoint.
- [Website crawling](crawler.md) — the crawl queue, the first run, pace, configuration and sites
  that refuse the crawler.
- [How Orbik runs agents](ai-execution.md) — runs, the model router, the two provider keys,
  embeddings and the AI call log.
- [The design system](design-system.md) — the Design system agent, pins, uploads and the brand
  chat, the Brand page and the brand over MCP.
- [Extensions](extensions.md) — the seam a deployment adds plans, events, routes and web pages
  through, without changing core.

[UI building blocks](ui.md), the web app's colours, type and shared components, is on GitHub only.
For setting up a development checkout, see the [README](../../README.md); for how changes are
checked and merged, [CONTRIBUTING.md](../../CONTRIBUTING.md).
