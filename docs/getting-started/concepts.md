# Concepts

The words the rest of these docs use: what an install, a workspace, the Library, an agent and
Orbik MCP are, and how they fit together.

## Install

One running copy of Orbik, with its own accounts and data. The first account claims it with the
one-time setup code the API prints to its log. After that, people join by an invite link, or sign
themselves up if the install's signup is open. The install's admins — the addresses in
`ORBIK_ADMIN_EMAILS`, or else its first account — have an **Admin** page in the account menu for
access requests and password resets. See [Accounts and admin](../guides/accounts-and-admin.md).

A self-hosted install has no limits: no page allowance, no seat count, every agent.

## Workspace

One website and everything Orbik knows about it: its crawl, its Library, its brand and its
llms.txt. A workspace has a name and a website address. An account can own several workspaces and
be a member of others, and the workspace switcher moves between them.

## Roles

A workspace has one **owner**, and other people join it as **admin**, **member** or
**read-only**:

| Role | Can |
|---|---|
| Read-only | Read the Library, the brand, llms.txt and Ask. |
| Member | Also edit the Library, crawl and run agents. |
| Admin | Also invite people, change roles, remove people, change the website and clear crawled data. |
| Owner | Also delete the workspace. Nobody can change or remove the owner. |

See [Workspaces and members](../guides/workspaces-and-members.md).

## Crawl and OrbikBot

The crawler reads your site page by page, starting from its home page and sitemaps, and renders
each page as Markdown. It identifies itself as [OrbikBot](../orbikbot.md), obeys `robots.txt` and
paces its requests to your server. A page is fetched once when it is found; how often each page is
fetched again is yours to choose on the **Crawler** page. See
[Crawling your site](../guides/crawling.md).

## The Library

A tree of Markdown files, in two layers:

- **The source layer**, under `/sources/website`: a word-for-word copy of every crawled page,
  written by code when a crawl finishes. No model reads a page to store it, and nothing else may
  write there.
- **The knowledge base** above it: files a model writes about your company, from the pages code
  chose for it — the ones your site links to most, up to 80. It is rewritten when one of those
  pages changes.

The top level is a few folders you choose, such as `00 Start Here` and `01 Company`. The agent
files into them and never adds, renames or removes one. The first folder holds the **overview**,
the Library's front page, and the **index**, a map of what to read for which job.

People edit the Library too. A paragraph a person writes or changes is theirs: agents must keep it,
and the tools refuse a write that drops it. Every file in the knowledge base keeps its last
twenty versions. See
[The Library](../guides/library.md).

## Search and Ask

The **retrieval index** holds the Library cut into passages and embedded, so it can be searched by
meaning. It needs `ORBIK_OPENAI_API_KEY`. **Ask** is a chat that opens in a panel beside the page
you are on, answers from the index and cites what it read. See [Ask](../guides/ask.md).

## Brand

The design system Orbik derives from your site: colours, type, spacing, components, logo and
images. The **Design system** agent renders up to eight of your pages in Chrome to find them. You
correct it on the **Brand** page by pinning values, uploading your own files or asking for a
change, and every change can be undone. Your AI reads it to make things that look like you. See
[Brand](../guides/brand.md).

## llms.txt

A short Markdown file a site publishes at `/llms.txt` so that a language model can find out what
the site is and which pages are worth reading. Orbik's llms.txt agent writes and maintains one for
your site; every link in it is a page the crawler fetched. You copy it to your site's root. See
[llms.txt](../guides/llms-txt.md).

## Agents and runs

An **agent** is one job Orbik does for a workspace. Those listed under **Agents** are the
**Crawler**, **llms.txt** and **Design system**; the Library agent works from the **Library**
page. A **run** is one time an agent works. Some agents run on a schedule once you set them
to work, and the Library agent runs when the pages it reads change. Agent definitions are part of
Orbik's code.

## Activity and the AI call log

What a person starts — a crawl, a run, an Ask question — records who started it. **Home** lists
recent crawls and runs and who started them, and the window at the foot of the sidebar shows what
is running now.

Every call Orbik makes to a model provider, embeddings included, is in the AI call log under
**Settings → AI calls**: what was sent, to which model, what came back and what it cost.

## Orbik MCP

The endpoint your own AI reads from, at `<your Orbik address>/mcp`. It serves the Library, a
search over it, your llms.txt and your brand as tools. No model on Orbik's side reasons about what
your AI asks: the reasoning is your AI's. There are two kinds of credential:

- **A token** you create under **Settings → Orbik MCP** and paste into Claude Code, Cursor or
  another client that takes one.
- **Sign-in (OAuth)**, which Claude.ai, Claude Desktop and ChatGPT use: you add the address as a
  custom connector, sign in to Orbik and approve.

Either can cover one workspace, several or all of the ones you can read. A credential reads by
default; one you allow to write can add and change files and folders in the Library, recorded as
yours, if you are a member or above of every workspace it covers. Removing a person from a
workspace stops their credentials reading it at once. See
[Connect your AI](../connect-your-ai/README.md).
