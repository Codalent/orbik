# Quickstart

From nothing to your own AI answering from your website: install Orbik with Docker, crawl your
site, choose how its Library is organised and connect an AI client.

## 1. Install

You need Docker with Compose and about 2 GB of free memory while the images build.

```sh
git clone https://github.com/Codalent/orbik.git
cd orbik
docker compose up -d
docker compose logs api        # shows the setup code
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
| `ORBIK_OPENAI_API_KEY` | **Yes** | Embeddings: the search index behind Ask and your AI's `content_search`. With only this key set, it also does all the writing: the Library's knowledge base, proposing its folders, Ask, the llms.txt agent and the brand proposal. |
| `ORBIK_ANTHROPIC_API_KEY` | No | With it set, Claude does the writing instead of OpenAI. |
| `ORBIK_AI_PROVIDER` | No | With both keys set, which one does the writing: `anthropic` (the default) or `openai`. |

Search uses the OpenAI key either way. Without any key, Orbik still crawls your site, copies every
page word for word into the Library and serves it to your AI. Every call made with a key is listed under
**Settings → AI calls**.

## 3. Claim the install

Open <http://localhost:8080>. The **Set up Orbik** page asks for the **Setup code** from the API's
log, your email and a password, and creates the first account. The code works once. After that,
people join by invite.

## 4. Create a workspace

A workspace is one website and everything Orbik knows about it. Give it a **Workspace name**,
press **Continue**, enter the **Website URL** and press **Create workspace**. You land on **Home**,
whose setup checklist walks through the rest of this page.

## 5. Crawl your site

On **Home**, **Connect your website** has **Start first crawl**, which opens the Crawler. Check the
address under **Start crawling from** and press **Start crawling this site**. The crawl starts
within a minute.

The crawler identifies itself as [OrbikBot](../orbikbot.md), obeys your `robots.txt` and paces its
requests. When the crawl finishes, every page is copied word for word into the Library under
`/sources/website`; no model is involved. See [Crawling your site](../guides/crawling.md) for
recrawling and frequencies.

## 6. Choose how the Library is organised

Open **Library**. Before Orbik writes anything above the copied pages, you choose its top-level
folders.

1. At the foot of the Library's explorer is the Library agent. It starts paused: set it to work
   with its play button. It then rewrites the Library whenever a crawl finds a change.
2. With the agent at work and your keys set, Orbik reads your site and, within a few
   minutes, proposes two or three structures, each with a sentence on why it fits. Orbik's
   default — `00 Start Here`, `01 Company`, `02 Offer`, … — is always offered too.
3. Pick one, rename, add, remove or reorder folders if you like, and press
   **Use this structure**.

The agent starts writing within a few minutes. You can rename any folder later, and every link
follows it.

## 7. Read the Library

The agent writes the overview first, in your first folder beside an index of what to read for
which job, then the folders around it. It writes from the pages your site links to most, not
from every page, and rewrites them when those pages change.

Edit any file. A paragraph you write or change is yours, and the agent keeps it on every later
run. See [The Library](../guides/library.md).

## 8. Connect your AI

On **Home**, **Connect Orbik MCP** shows the two ways in:

- **Claude.ai / ChatGPT**: add the **Connector URL** (`http://localhost:8080/mcp` here) as a
  custom connector, then sign in to Orbik and approve. These services reach your install from the
  internet, so they need it on an HTTPS address; see [A domain with HTTPS](../self-hosting/https.md).
- **Claude Code / Cursor**: name the connection, press **Create token**, and paste the token into
  your client. For Claude Code:

  ```sh
  claude mcp add --transport http orbik http://localhost:8080/mcp \
    --header "Authorization: Bearer orbm_…"
  ```

Your AI can now read the Library, search it, and read your brand and llms.txt.
[Connect your AI](../connect-your-ai/README.md) covers each client, reading several workspaces and
letting your AI write to the Library.

## Next

- [Concepts](concepts.md) — what a workspace, the Library and an agent are.
- [Brand](../guides/brand.md) — review the colours, type and logo Orbik derived.
- [Workspaces and members](../guides/workspaces-and-members.md) — invite your team.
