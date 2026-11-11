# Orbik

Orbik crawls a site and keeps it in a **Library**: a word-for-word copy of every page, and a
knowledge base written from them — a tree of documents that agents and people both edit — with a
retrieval index and a chat that answers from it. It also derives the site's brand and keeps it.
Your own AI reads all of it over MCP.

## Run it with Docker

```sh
git clone https://github.com/Codalent/orbik.git
cd orbik
docker compose up -d
docker compose logs api        # the one-time setup link
```

Open the link it prints (`http://localhost:8080/setup?key=…`, the setup code filled in) and create
the first account. The install
listens on this machine only until you open it up (`ORBIK_BIND_ADDRESS`). Add your
OpenAI key (required, for search) and optionally an Anthropic key in `.env` (see `.env.example`)
for everything that needs a model. A
self-hosted Orbik has no limits: no page allowance, no seat count, every agent. A domain with
HTTPS, email, backups and upgrades are in [docs/self-hosting](docs/self-hosting/README.md).

**Usage statistics** are off by default. `ORBIK_TELEMETRY=on` sends one anonymous ping a day —
counts of workspaces, pages fetched and agent runs, and which optional services are configured;
never content, addresses, emails or keys. The exact payload is in [docs/self-hosting/usage-statistics.md](docs/self-hosting/usage-statistics.md).

## Develop it

The rest of this file runs the processes directly, with file watching, for working on Orbik.

This is a pnpm monorepo:

| Path | What it is | Runs as |
|---|---|---|
| `frontend/` | Next.js web app | `127.0.0.1:3100` |
| `backend/` | HTTP API | `127.0.0.1:4100` |
| `agents/` | Agents worker and scheduler (crawls, agent runs, indexing) | background, no port |
| `packages/*` | Shared libraries (`core`, `library`, `protocol`, `agent-definitions`, `tools`, `retrieval`, `crawl-budget`, `assets`, `design-system`, `extensions`, `web-extensions`, `migrations`) | imported by the above |
| `deploy/`, `compose.yaml` | The Docker images and the compose file | `docker compose up` |

Supporting services:

| Service | Address | Required? |
|---|---|---|
| MongoDB | `127.0.0.1:27017` | Yes |
| Qdrant | `127.0.0.1:6333` (REST), `6334` (gRPC) | No — only for the retrieval index, search, and chat |

## 1. Prerequisites

- **Node.js 24** (`>=24.14.0 <25`; `.node-version` pins 24.14.0). With nvm:

  ```sh
  nvm install 24.14.0
  nvm use 24.14.0
  node -v   # must print v24.x
  ```

  If `node -v` shows another version after `nvm use`, a different `node` comes earlier on your
  `PATH`. Run `which -a node` to find it.

- **pnpm 11.23**, through Corepack (included with Node):

  ```sh
  corepack enable
  pnpm -v   # 11.23.x
  ```

  **Use pnpm only — do not run `npm install`.** npm cannot read pnpm's `node_modules` layout and
  fails with `Cannot read properties of null (reading 'matches')`.

- **MongoDB** running on `127.0.0.1:27017`. On macOS:

  ```sh
  brew tap mongodb/brew
  brew install mongodb-community
  brew services start mongodb-community
  ```

- **An OpenAI API key (required), and optionally an Anthropic API key**, for the agents worker.
  The embeddings behind the retrieval index are made with `ORBIK_OPENAI_API_KEY`. Every reasoning
  call — agent runs and the Library chat — is made with `ORBIK_ANTHROPIC_API_KEY` when it is set,
  and with the OpenAI key otherwise; `ORBIK_AI_PROVIDER` (`anthropic` or `openai`) chooses when
  both are set. All in `agents/.env`. Without a reasoning key the worker still starts and crawls,
  but AI runs fail saying no AI provider is configured; without the OpenAI key nothing is indexed.

- **Google Chrome**, only if you use the Design system agent. See
  [docs/architecture/design-system.md](docs/architecture/design-system.md).

- **Qdrant** (optional), for the retrieval index. See [Qdrant](#qdrant-optional) below.

## 2. Install dependencies

```sh
git clone https://github.com/Codalent/orbik.git
cd orbik
pnpm install
```

## 3. Configure environment files

Each app reads its own untracked env file. Copy the examples, then edit them:

```sh
cp backend/.env.example  backend/.env
cp agents/.env.example   agents/.env
cp frontend/.env.example frontend/.env.local
```

Settings to check:

**`backend/.env`**

- `MONGODB_URI` — must name a database, e.g. `mongodb://127.0.0.1:27017/orbik`.
- `SESSION_SECRET` — at least 32 random characters. Generate one with:

  ```sh
  node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
  ```

- `FRONTEND_ORIGINS` — exact origins of the web app; the default already covers
  `localhost:3100` and `127.0.0.1:3100`. The first one is the app's own address: invite links,
  the OAuth consent screen and Library links in MCP results are built from it. In production it
  is the web app's public address, e.g. `https://orbik.example.com`.
- `ORBIK_ASSET_URL_SECRET` (optional) — at least 32 random characters, generated the same way. It
  signs the links an AI connected over MCP fetches a workspace's brand images by. Without it the
  Brand page and every MCP tool still work; the brand tools name the images without linking them.

**`agents/.env`**

- `MONGODB_URI` — **must be the same database as the backend**. Both example files name
  `orbik`; if you change one, change the other.
- `ORBIK_AI_PROVIDER` — `anthropic` or `openai`: which provider makes every reasoning call (agent
  runs, the Library chat and the short texts plain-code agents ask for). Unset, it is Anthropic
  when `ORBIK_ANTHROPIC_API_KEY` is set and OpenAI otherwise. The worker logs its choice at start
  (`ai.provider`). Without the chosen provider's key AI runs fail with "no AI provider is
  configured" and the Library's knowledge base is not written. The API reads neither it nor the
  Anthropic key.
- `ORBIK_ANTHROPIC_API_KEY` — Orbik's own Anthropic key, commented out in the example. Optional:
  with it the reasoning calls go to Claude.
- `ORBIK_OPENAI_API_KEY` — Orbik's own OpenAI key, commented out in the example, and required for
  search. The worker makes the embeddings with it, and the reasoning calls too when OpenAI is the
  reasoning provider. Without it indexing is skipped, and the Library and ask pages say the
  index is not configured. Crawling and the copy of every page in the Library work without either
  key. If you set it, set the same key in `backend/.env` too: the API reads it there
  to search the index for AI clients connected over MCP, and for nothing else. `QDRANT_URL`,
  `QDRANT_COLLECTION` and `ORBIK_EMBEDDING_MODEL` must also match between the two files.
- Worker tuning (`AGENT_CONCURRENCY`, intervals, leases) is documented inline in the example.

**`frontend/.env.local`**

- `NEXT_PUBLIC_API_BASE_URL=http://localhost:4100` — this value is embedded at build time, so
  restart the dev server after changing it. Open the app on the same host name it uses
  (`localhost` by default, not `127.0.0.1`): the session cookie is host-only and `SameSite=Lax`,
  so a page on `127.0.0.1` does not send it to an API on `localhost`, and signing in does not
  stick.

## 4. Start the app

Start all three processes (web app, API, and agents worker plus scheduler) with file watching:

```sh
pnpm dev
```

To run them in separate terminals instead:

```sh
pnpm --dir backend dev
pnpm --dir agents dev
pnpm --dir frontend dev
```

Check that they are running:

```sh
curl -fsS http://127.0.0.1:4100/health
open http://localhost:3100
```

## 5. First-time data setup

On a database with no account, the API prints a one-time **setup code** when it starts, and a link
to the setup page with it filled in (`http://localhost:3100/setup?key=…`). Open the link and create
the first account. To do it from a terminal instead (you are asked for the password, so it stays out of
your shell history):

```sh
pnpm --dir backend run seed:user -- --email you@example.com
```

After that, people join by an invite from a workspace's settings, or sign themselves up when
`ORBIK_SIGNUP=open` is set in `backend/.env`.

The agents need no step of their own: their definitions are code
(`packages/agent-definitions`), read by the API and the worker when they start.

There is no page allowance unless an extension sets one: every crawl month is unlimited, and the
crawl page shows how many pages it fetched. Where a plan does set one,
`pnpm --dir backend run grant:crawl-budget -- --email you@example.com --pages 50000` adds pages to the
current month only.

## Qdrant (optional)

Qdrant stores the retrieval index (`orbik_chunks`) that search and the chat read. It is a separate
binary that this repository does not manage. To install it on an Apple Silicon Mac:

```sh
mkdir -p ~/qdrant/config && cd ~/qdrant
curl -L -o qdrant.tar.gz https://github.com/qdrant/qdrant/releases/download/v1.19.1/qdrant-aarch64-apple-darwin.tar.gz
tar xzf qdrant.tar.gz && chmod +x qdrant
curl -L -o config/config.yaml https://raw.githubusercontent.com/qdrant/qdrant/v1.19.1/config/config.yaml
```

On an Intel Mac, download `qdrant-x86_64-apple-darwin.tar.gz` instead; on x86_64 Linux,
`qdrant-x86_64-unknown-linux-gnu.tar.gz`. Run Qdrant in its own terminal:

```sh
cd ~/qdrant && ./qdrant    # REST on 6333, data in ~/qdrant/storage
```

On a Linux box you will want it to survive a reboot. Write
`/etc/systemd/system/qdrant.service` — adjusting the paths to where you unpacked it:

```ini
[Unit]
Description=Qdrant vector search engine
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
WorkingDirectory=/opt/qdrant
ExecStart=/opt/qdrant/qdrant
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s

[Install]
WantedBy=multi-user.target
```

Then `systemctl daemon-reload && systemctl enable --now qdrant`, and read its log with
`journalctl -u qdrant -f`. Stop the service before running the binary in the foreground; both want
the same storage directory.

If Qdrant is down, indexing and search report `INDEX_UNAVAILABLE`, and the next scheduler tick
retries. Nothing crashes.

## Everyday commands

```sh
pnpm dev                          # run frontend, backend, and agents with watchers
pnpm lint                         # eslint across every package
pnpm --dir agents run agent:run   # run one agent from the command line
```

There are no automated tests in this repository; changes are verified against the running
development processes. See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes are checked.

## Production

The simplest production install is Docker: [docs/self-hosting](docs/self-hosting/README.md). To run the
processes directly instead, `ecosystem.config.cjs` defines them for PM2 behind a reverse proxy
that serves the web app and the API over HTTPS; `scripts/start.sh dev|prod` starts or restarts
everything in one mode, and `scripts/frontend.sh`, `scripts/backend.sh` and `scripts/agents.sh`
switch one part at a time.

## Extending Orbik

A deployment adds plans, billing or pages of its own without changing this repository: server
extensions are named by `ORBIK_EXTENSIONS`, and the web app renders the slots of the
`@orbik/web-extensions` package. See [docs/architecture/extensions.md](docs/architecture/extensions.md).

## Further reading

The documentation is in [docs/](docs/README.md) and published at <https://orbik.io/docs>.

- [docs/self-hosting](docs/self-hosting/README.md) — Docker, configuration, HTTPS, backups, upgrades and usage statistics
- [docs/connect-your-ai](docs/connect-your-ai/README.md) — Claude, ChatGPT, Claude Code and Cursor over MCP
- [docs/architecture/extensions.md](docs/architecture/extensions.md) — the extension seam: plan limits, events, routes and web slots

- [docs/architecture/ai-execution.md](docs/architecture/ai-execution.md) — how agents run and the one provider key
- [docs/architecture/crawler.md](docs/architecture/crawler.md) — the crawler
- [docs/architecture/library.md](docs/architecture/library.md) — the Library, its agents, and its API
- [docs/architecture/design-system.md](docs/architecture/design-system.md) — the Design system agent, the Brand page, and the brand over MCP

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `npm error Cannot read properties of null (reading 'matches')` | You ran npm. Use `pnpm install`. |
| `pnpm` warns about the engine, or `node -v` is not 24 | Another `node` comes first on your `PATH`. Run `nvm use 24.14.0`, then check `which -a node`. |
| API exits with `SESSION_SECRET must contain at least 32 non-placeholder characters` | Replace the placeholder in `backend/.env`. |
| `MONGODB_URI must include a database name` | Add a database to the URI path, e.g. `/orbik`. |
| Agent runs report that no AI provider is configured | Set `ORBIK_ANTHROPIC_API_KEY` or `ORBIK_OPENAI_API_KEY` in `agents/.env`; if `ORBIK_AI_PROVIDER` is set, the key of the provider it names. |
| Library or ask page says the index is not configured | Set `ORBIK_OPENAI_API_KEY` in `agents/.env` and start Qdrant. |
| An MCP client's `content_search` says the index is unavailable | Set the same `ORBIK_OPENAI_API_KEY` (and the same Qdrant and embedding-model settings) in `backend/.env`. |
| A Design system run fails with `CHROME_UNAVAILABLE` | Install Google Chrome on the machine running the agents worker. |
| A Design system run finishes in two seconds having done nothing | The site's styling has not changed since the system was derived (`STYLE_UNCHANGED`). Use **Re-derive** on the Brand page to derive it anyway. |
| An MCP client's `brand_get` says `ASSET_LINKS_NOT_CONFIGURED` | Set `ORBIK_ASSET_URL_SECRET` in `backend/.env`. |
| Browser requests to the API fail with CORS errors | Add the exact origin you open the app on to `FRONTEND_ORIGINS`. |
| Signing in succeeds but you land back on the login page | The app and `NEXT_PUBLIC_API_BASE_URL` use different host names, so the browser withholds the session cookie. Open the app on `http://localhost:3100`, or point both at the same host. |

## License

Orbik is free software, licensed under the [GNU Affero General Public License, version 3](LICENSE)
(`AGPL-3.0-only`). You may use, change and self-host it, for yourself or for your business. If you
change Orbik and let other people use your changed version over a network, you must offer them its
source code under the same license. Contributions are accepted under the
[Contributor License Agreement](CLA.md); [CONTRIBUTING.md](CONTRIBUTING.md) says how to sign it.

Copyright © 2026 Codalent Technologies Pvt Ltd.
