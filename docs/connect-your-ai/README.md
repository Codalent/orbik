# Connect your AI

Orbik MCP lets your own AI — Claude, ChatGPT, Claude Code, Cursor or an agent you built — read a
workspace's knowledge base, and save to its Library if you allow it.

A connected AI reads the Library, the word-for-word copy of every crawled page under
`/sources/website`, the site's llms.txt and its brand (colours, type, logo and images). Your AI does
the reasoning; Orbik only serves what it reads. The one model call Orbik makes for it is turning a
search question into an embedding, with the install's OpenAI key.

## The address

Every client connects to one URL, your Orbik address followed by `/mcp`:

- Docker install: `ORBIK_URL` plus `/mcp`, so `http://localhost:8080/mcp` on your own machine or
  `https://orbik.example.com/mcp` on a server.
- Without Docker: the API's address plus `/mcp`, such as `http://127.0.0.1:4100/mcp`.

The workspace's **Settings → Orbik MCP** page shows the exact URL, with the steps for each client and
a prompt you can paste into your AI to have it connect Orbik for you.

## Pick your client

| Client | How it connects | Steps |
| --- | --- | --- |
| Claude.ai, Claude Desktop | Custom connector; you sign in to Orbik | [Claude](claude.md) |
| ChatGPT | Connector; you sign in to Orbik | [ChatGPT](chatgpt.md) |
| Claude Code | `claude mcp add`; sign in, or a token | [Claude Code](claude-code.md) |
| Cursor, other editors, the Anthropic and OpenAI APIs, your own agents | A token | [Cursor and others](cursor-and-others.md) |

Every tool and argument a connected AI is offered is in the [MCP tool reference](tools.md).

## Two kinds of credential

**Signing in.** Claude.ai, Claude Desktop, ChatGPT and Claude Code connect with OAuth: you give them
the URL, they send you to Orbik in your browser, and on the consent screen you choose which
workspaces the app may read and whether it may write. There is nothing to copy. Claude.ai, Claude
Desktop and ChatGPT reach Orbik from their own servers, so they need the install on an HTTPS address
the internet can reach; see [A domain with HTTPS](../self-hosting/https.md). Claude Code runs on
your machine and can sign in to `http://localhost:8080` as well.

**A token.** For clients that take a URL and a header. On **Settings → Orbik MCP**, choose **Cursor
and others**, name the connection and press **Create token**. The token starts with `orbm_`, is
sent as `Authorization: Bearer orbm_…`, and is shown once: Orbik keeps only a hash of it. You can
hold twenty live tokens at a time. A token made from the workspace's Home page reads that workspace
only and cannot write; make it on Settings for anything more.

## One workspace or several

A credential reads the workspaces you choose when you make it, among those you can read:

- A token reads **This workspace only** or **All workspaces I can read, including ones I create or
  join later**.
- On the consent screen an app reads **All workspaces I can read, including ones I create or join
  later**, or **Only these**, the ones you tick. If you have one workspace, it reads that one.

A connection that reads several workspaces names one on each call. Every tool except `fetch` and
`workspace_list` takes a `workspace` argument — the workspace's id, its website host or its exact
name — and `workspace_list` shows the choices. `search` without `workspace` searches all of them.

Whatever a credential was given, it never reads a workspace you cannot read now: it is checked on
every request. If a workspace is deleted or you are removed from it, your connections stop reading
it at once, and one that read only that workspace is revoked.

## Letting it write

Writing is off unless you turn it on: **May write to the Library** when you create a token, or
**Allow this app to write to the Library** on the consent screen. It needs the member role or above
in every workspace the credential covers, so the box is unavailable where you are read-only.

A connection that may write gets two more tools: `library_write`, which creates or replaces a file,
and `library_mkdir`, which makes a folder. It writes as you:

- Only inside the top-level folders your Library has. Never at the top level itself, under
  `/sources` or `/brand`, or in anything you locked.
- What it adds is kept from Orbik's agents like your own edits, and the file's history names you and
  the connection it came through.
- It cannot move or delete anything, or start an agent. Every file keeps its earlier versions, so a
  change can be undone from the Library.
- Twenty writes a minute per connection.

If your role in a workspace later becomes read-only, writes there are refused while reads, and
writes elsewhere, carry on.

## See and revoke connections

**Settings → Orbik MCP → Connected** lists every token and app of yours that reads the workspace,
what it reads, whether it has **Read access** or **Read and write access**, and when it was last
used. **Revoke** a token or **Disconnect** an app (**Revoke everywhere**, **Disconnect everywhere**
when it reads several workspaces) and it stops on its next request, everywhere it reads.

Connections are per person: a workspace's owner does not see, or revoke, the ones its members hold.
To change which workspaces an app reads, or whether it may write, connect it again and approve the
new choice; it replaces the old one.

Admins and the owner also see **What your AI asked**: how many calls the workspace's connections
made, which failed, and the questions the knowledge base answered least well, which is where to look
for what the site does not cover. It names the client, never the person, and keeps ninety days.

## When something is refused

A refusal comes back to your AI as a result with a code it can read and pass on:

| Code | Means |
| --- | --- |
| `INDEX_UNAVAILABLE` | Search could not answer: the search index (Qdrant) is not answering, or the install has no OpenAI key. `library_search` still works. |
| `CRAWL_NOT_CONFIGURED` | The workspace's site has not been crawled yet. |
| `NODE_MISSING` | No Library file or folder at that path. |
| `BRAND_NOT_DERIVED` | No design system yet. Derive one on the workspace's Brand page. |
| `WORKSPACE_REQUIRED`, `WORKSPACE_NOT_ALLOWED` | A connection that reads several workspaces named none, or one it does not read. The answer lists the choices. |
| `WRITE_NOT_GRANTED` | The connection may not write. Allow it as above. |
| `ROLE_INSUFFICIENT` | Your role in that workspace is read-only. |
| `WRITE_RATE_LIMITED` | More than twenty writes in a minute. The answer says when to try again. |
| `TOP_LEVEL_PROTECTED`, `RESERVED_PATH`, `NODE_LOCKED` | A write at the top level, under `/sources` or `/brand`, or into something locked. |

## On a server with HTTPS

Signing in only works when Orbik describes itself by the address the app actually uses.

- In the Docker install, `ORBIK_URL` does this: set it to the exact address, `https://` included,
  and run `docker compose up -d` again. See [Configuration](../self-hosting/configuration.md).
- Without Docker, two settings in `backend/.env` do it. The first entry of `FRONTEND_ORIGINS` is the
  web app's address, which the consent screen is opened at. `PUBLIC_API_URL` is the API's public
  address, which the sign-in documents name; apps compare it character for character, and without
  it they are told `http://127.0.0.1:4100` and refuse. Both are read when the API starts, so restart
  it after changing them.

To check what apps are told, fetch the two discovery documents; every address in both must start
with your public address:

```sh
curl https://orbik.example.com/.well-known/oauth-authorization-server
curl https://orbik.example.com/.well-known/oauth-protected-resource/mcp
```

A connection that may write sends a whole file in one request, up to 1 MB. If you put your own
proxy in front of the API, let `/mcp` take a body that size (in nginx, `client_max_body_size 1m;`).
