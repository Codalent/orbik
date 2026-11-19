# Quickstart

From nothing to your own AI answering from your website: install Orbik with Docker, crawl your
site, choose how its Library is organised and connect an AI client.

## 1. Install

You need Docker with Compose and about 2 GB of free memory while the images build.

The easiest way is to let an AI coding agent do it: give
[the install prompt](../self-hosting/README.md#with-an-ai-coding-agent) to Claude Code, Codex or
Cursor's agent, and it installs Orbik, asks for your keys (step 2) and hands you the setup link
(step 3). To do it by hand:

```sh
git clone https://github.com/Codalent/orbik.git
cd orbik
docker compose up -d
docker compose logs api        # shows the setup link
```

The first start builds three images, which takes several minutes. Everything runs on this machine
at <http://localhost:8080>. [Self-hosting](../self-hosting/README.md) covers memory, a domain with
HTTPS, email and upgrades.

## 2. Add your AI keys

Orbik calls models with your own keys, and you pay your provider directly. Copy `.env.example` to
`.env` beside `compose.yaml`, set the keys, and run `docker compose up -d` again:

```sh
ORBIK_OPENAI_API_KEY=sk-proj-...      # required
ORBIK_ANTHROPIC_API_KEY=sk-ant-...    # optional
```

> [!IMPORTANT]
> The OpenAI key is required. It makes the embeddings behind search, and Anthropic has no
> embeddings, so there is no other way to get them.

| Key | Required | What needs it |
|---|---|---|
| `ORBIK_OPENAI_API_KEY` | **Yes** | Embeddings: the search index behind Ask and your AI's `content_search`. With only this key set, it also does all the writing: the Library's knowledge base, changing its folders when asked, Ask, the llms.txt agent and the brand proposal. |
| `ORBIK_ANTHROPIC_API_KEY` | No | With it set, Claude does the writing instead of OpenAI. |
| `ORBIK_AI_PROVIDER` | No | With both keys set, which one does the writing: `anthropic` (the default) or `openai`. |

Search uses the OpenAI key either way. Without any key, Orbik still crawls your site, copies every
page word for word into the Library and serves it to your AI. Every call made with a key is listed under
**Settings → AI calls**.

## 3. Claim the install

Open the link the API printed to its log, `http://localhost:8080/setup?key=…`. The **Set up Orbik**
page opens with the **Setup code** filled in; add your email and a password, and it creates the
first account. (Opening <http://localhost:8080> instead asks you to type the code, which the log
also prints on its own.) The code works once. After that,
people join by invite.

## 4. Create a workspace

A workspace is one website and everything Orbik knows about it. Give it a **Workspace name**,
press **Continue**, enter the **Website URL** (`example.com` is enough: `https://` is assumed) and
press **Create workspace**. You land on **Home**, whose setup checklist walks through the rest of
this page.

## 5. Crawl your site

On **Home**, **Connect your website** has **Start first crawl**: it starts the crawl from the
workspace's website and opens its crawl under **Sources**, where you can watch it. The crawl
starts within a minute. To begin somewhere else on the site, or to list sitemaps first, press
**Choose the start address or add sitemaps first** instead: the crawl's set-up has **Start crawling
from** and **Start crawling this site**.

The crawler identifies itself as [OrbikBot](../orbikbot.md), obeys your `robots.txt` and paces its
requests. When the crawl finishes, every page is copied word for word into the Library under
`/sources/website`; no model is involved. See [Crawling your site](../guides/crawling.md) for
recrawling and frequencies. A documentation subdomain, a review profile or another site of yours
can be added beside it under [Sources](../guides/sources.md).

## 6. Choose how the Library is organised

Open **Library**. Before Orbik writes anything above the copied pages, you choose its top-level
folders.

1. The Library opens on **Choose how your Library is organised**, with Orbik's standard folders:
   `00 Start Here`, `01 Company`, `02 Offer`, ….
2. Rename, add, remove or drag folders into another order if you like. With your keys set,
   **Suggest changes** lets you ask for a change in your own words ("merge Proof into Offer"),
   which Orbik makes to the list in a few seconds.
3. Press **Use this structure and start writing**. That also sets the **Knowledge base agent** to
   work (**Set to work** in its menu, from its icon at the bottom left of the Library): it rewrites
   the Library whenever a crawl finds a change.

The Library opens on the overview, which says what the agent is doing: its first run starts within
a minute, and the overview follows it as it writes. You can rename any folder later, and every
link follows it.

## 7. Read the Library

The agent writes the overview first, in your first folder beside an index of what to read for
which job, then the folders around it. It writes from the pages your site links to most, not
from every page, and rewrites them when those pages change.

Edit any file. A paragraph you write or change is yours, and the agent keeps it on every later
run. See [The Library](../guides/library.md).

## 8. Connect your AI

On **Home**, **Connect Orbik MCP** asks where you use AI:

- **Claude Code, Cursor, Codex**: press **Copy prompt** and paste it into your agent. It adds the
  Orbik MCP server itself, then you sign in to Orbik in your browser and choose what it may read; no
  token is needed. **Set it up by hand instead** shows the Claude Code command, the URL for other
  clients, and a token for a server or CI where nobody can sign in. With a token, for Claude Code:

  ```sh
  claude mcp add --transport http orbik http://localhost:8080/mcp \
    --header "Authorization: Bearer orbm_…"
  ```

- **Claude.ai, ChatGPT**: copy the **connector URL** (`http://localhost:8080/mcp` here), open the
  app's connector settings from the step, add it as a custom connector, then sign in to Orbik and
  approve. These services reach your install from the internet, so they need it on an HTTPS
  address; see [A domain with HTTPS](../self-hosting/https.md).

The step ticks itself off once your AI first calls Orbik.

Your AI can now read the Library, search it, and read your brand and llms.txt.
[Connect your AI](../connect-your-ai/README.md) covers each client, reading several workspaces and
letting your AI write to the Library.

## Next

- [Concepts](concepts.md) — what a workspace, the Library and an agent are.
- [Brand](../guides/brand.md) — review the colours, type and logo Orbik derived.
- [Workspaces and members](../guides/workspaces-and-members.md) — invite your team.
