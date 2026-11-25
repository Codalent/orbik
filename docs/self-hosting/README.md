# Self-hosting Orbik

Orbik runs on your own machine with Docker: the web app, the API, the agents, MongoDB, Qdrant and a
small proxy, all at one address. Everything is unlimited, and you bring your own AI keys.

There is no plan, no page allowance and no seat count. You pay your AI provider directly, and every
call is listed in the AI call log.

## Install

### With an AI coding agent

The easiest way: give this prompt to an AI agent that can run commands on the machine Orbik will
run on, such as Claude Code, Codex or Cursor's agent. Start it in the folder Orbik should live in
(on a server, run the agent on the server). It checks Docker, chooses free ports, asks for your AI
keys, starts the install and gives you the setup link. You then create your account yourself.

```text
Install Orbik (https://github.com/Codalent/orbik), a self-hosted app, on this machine with Docker.
Stop when it is ready for me to create my account. Tell me what you are doing as you go.

1. Check that git, Docker and Docker Compose v2 are installed and that Docker is running
   (`git --version`, `docker info`, `docker compose version`). If something is missing, tell me how
   to install it (Docker Desktop on a Mac or Windows, Docker Engine on Linux) and wait for me.
   The first build needs about 2 GB of memory: if "Total Memory" in `docker info` is under 3 GB,
   tell me to give Docker more.
2. If the current folder or ./orbik is already a clone of that repository, use it; otherwise clone
   it into ./orbik. Run every command below from that folder. Before changing any setting, read
   docs/self-hosting/README.md and docs/self-hosting/configuration.md there.
3. Ask me whether only this computer will use Orbik, or other people will reach it too (at a
   domain, or on my network). If others will, also read docs/self-hosting/https.md and set the
   install up as it and configuration.md say.
4. Put settings only in a `.env` file beside compose.yaml: copy .env.example to .env if there is
   none, and keep anything already in it. Do not edit compose.yaml, deploy/ or the code.
   - Orbik uses ports 8080 and 8443 of this machine. If anything already listens on either (check
     with the system's own tools, not only `docker ps`), choose free ones and set ORBIK_HTTP_PORT
     and ORBIK_HTTPS_PORT. The address follows ORBIK_HTTP_PORT on its own.
   - If `docker compose ls` lists a project named orbik from another folder, that is another
     install: do not touch it. Set COMPOSE_PROJECT_NAME to a name no listed project has.
5. Ask me for an OpenAI API key, which search needs (alone, it also runs every AI feature), and
   optionally an Anthropic key, for Claude to do the writing instead. I may paste them, or skip
   them and add them to .env later; if I skip, tell me what will not work until I add one. Keys
   go only in .env, as ORBIK_OPENAI_API_KEY and ORBIK_ANTHROPIC_API_KEY: never print them back,
   commit them or write them anywhere else.
6. Run `docker compose up -d`. The first run builds three images and takes several minutes: give it
   a long timeout and let it finish. Then `docker compose ps` should show every service up, with
   api and mongo healthy (the others report no health). If not, read
   `docker compose logs <service>`, fix the cause and run it again.
7. Run `docker compose logs api` and give me the setup link it printed last, which ends in
   /setup?key=… . Do not create the account yourself or ask for my password: I choose my email
   and password on that page.

Finish with a short summary: the address, the folder, which keys are set, and the commands to stop
it (`docker compose stop`), start it again and read its logs. Warn me that `docker compose down -v`
deletes all its data.
```

Then open the link, add your email and a password, and choose **Create account**. Next comes your
first workspace: see the [Quickstart](../getting-started/quickstart.md#4-create-a-workspace).

### By hand

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
by invite or by asking an admin for access. [Accounts and admin](../guides/accounts-and-admin.md)
covers both. Once claimed, the API's log says so under the setup link, and the link sends you to
the sign-in page.

To run it, allow about 1.5 GB of memory, more while the Design system agent has Chromium open
(300–600 MB), and a few GB of disk for MongoDB.

### When port 8080 is taken

The install listens on port 8080 of this machine (and 8443, kept for HTTPS). If something else
already has it, `docker compose up -d` stops with `Bind for 127.0.0.1:8080 failed: port is already
allocated`. Choose another port in `.env` beside `compose.yaml` (copy `.env.example` to `.env` if
you have none yet):

```sh
ORBIK_HTTP_PORT=8081
ORBIK_HTTPS_PORT=8444    # only if 8443 is taken too
```

Then run `docker compose up -d` again.

The install's address follows the port, so the setup link, invite links and sign-in all use
`http://localhost:8081`. Set `ORBIK_URL` only when people reach it at another address, such as a
domain.

### A second install on the same machine

Every install of this compose file is the Compose project `orbik`, so `docker compose up -d` in a
second clone takes over the first one's containers and opens its database. Give the second one its
own project name and port in its `.env`:

```sh
COMPOSE_PROJECT_NAME=orbik-staging
ORBIK_HTTP_PORT=8081
ORBIK_HTTPS_PORT=8444
```

It then has its own containers, images and volumes (`orbik-staging_mongo-data`, …), and its own
setup link. Run every `docker compose` command for it from its own folder.

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
- [A domain with HTTPS](https.md) — needed before Claude.ai, Claude Desktop, ChatGPT, Gemini or
  Grok can sign in; on its own, or behind nginx or a load balancer you already run.
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
