# Self-hosting Orbik

Orbik runs on your own machine with Docker: the web app, the API, the agents, MongoDB, Qdrant and a
small proxy, all at one address. Everything is unlimited, and you bring your own AI keys.

There is no plan, no page allowance and no seat count. You pay your AI provider directly, and every
call is listed in the AI call log.

## Install

```sh
git clone https://github.com/Codalent/orbik.git
cd orbik
docker compose up -d
docker compose logs api        # shows the setup link
```

The first start builds three images, which takes several minutes and about 2 GB of memory while the
web app compiles. Then open the link the API printed, `http://localhost:8080/setup?key=…`: the setup
code is filled in, and the page creates the first account. Opening <http://localhost:8080> instead
asks for the code, which the log also prints on its own. The code works once; after that the install is claimed, and people join
by invite (or by signing up, if you open signup). [Accounts and admin](../guides/accounts-and-admin.md)
covers both.

To run it, allow about 1.5 GB of memory, more while the Design system agent has Chromium open
(300–600 MB), and a few GB of disk for MongoDB.

## AI keys

Orbik starts without any key: it crawls, keeps a word-for-word copy of every page in the Library
and runs the agents that need no model. Keys in `.env` beside `compose.yaml` turn on the rest:

- `ORBIK_OPENAI_API_KEY` — **required**: embeddings for search, Ask and `content_search` over MCP.
  On its own it also makes every reasoning call: agent runs, the Library's knowledge base, Ask.
- `ORBIK_ANTHROPIC_API_KEY` — optional: with it set, Claude makes the reasoning calls instead.
  `ORBIK_AI_PROVIDER` (`anthropic` or `openai`) picks one when both keys are set.

Run `docker compose up -d` again after changing `.env`. Every other setting is in
[Configuration](configuration.md).

## Next steps

- [Configuration](configuration.md) — every setting in `.env`.
- [A domain with HTTPS](https.md) — needed before Claude.ai, Claude Desktop or ChatGPT can sign in.
- [Backups and upgrades](backups-and-upgrades.md) — what to back up and how to move to a new release.
- [Usage statistics](usage-statistics.md) — the anonymous daily ping, off unless you turn it on.
- [Connect your AI](../connect-your-ai/README.md) — point Claude, ChatGPT or Cursor at the install.

## Commands in the Docker install

The images carry no pnpm; run the API's commands with `node` in its container (it asks for a
password on the terminal):

```sh
docker compose exec api node src/cli/seedUser.js --email you@example.com
docker compose exec api node src/cli/resetPassword.js --email you@example.com
```

## Without Docker

The processes run directly on a machine with Node 24, pnpm, MongoDB and (optionally) Qdrant and
Chrome; see the [README](../../README.md). On a fresh database the API prints the same setup link and code,
and `pnpm --dir backend run seed:user -- --email you@example.com` creates an account from a terminal
instead.
