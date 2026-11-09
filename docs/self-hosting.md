# Self-hosting Orbik

Orbik runs on your own machine with Docker: the web app, the API, the agents worker and scheduler,
MongoDB, Qdrant and a small proxy that puts them all at one address. Everything is unlimited — no
plan, no page allowance, no seat count. You bring your own AI keys and pay your provider directly;
every call is listed in the AI call log.

## Install

```sh
git clone https://github.com/Codalent/orbik.git
cd orbik
docker compose up -d
docker compose logs api        # shows the setup code
```

The first start builds three images, which takes several minutes and about 2 GB of memory while the
web app compiles. Then open <http://localhost:8080>: it asks for the setup code the API printed and
creates the first account. The code works once; after that the install is claimed, and people join
by invite (or by signing up, if you open signup).

To run it, allow about 1.5 GB of memory, more while the Design system agent has Chromium open
(300–600 MB), and a few GB of disk for MongoDB.

## Configuration

Settings go in `.env` beside `compose.yaml` (copy `.env.example`); every one is optional. After
changing it, `docker compose up -d` again.

| Setting | What it does |
|---|---|
| `ORBIK_ANTHROPIC_API_KEY` | Every reasoning call: agent runs, the Library's knowledge base, Ask. Without it the install still crawls, keeps a word-for-word copy of every page in the Library and runs the agents that need no model. |
| `ORBIK_OPENAI_API_KEY` | Embeddings for search, Ask and `content_search` over MCP. Without it nothing is indexed. |
| `ORBIK_URL` | The address people and AI clients reach the install at, exactly as in the address bar. Default `http://localhost:8080`. |
| `ORBIK_HTTP_PORT`, `ORBIK_HTTPS_PORT` | Ports published on the host. Default 8080 and 8443. |
| `ORBIK_BIND_ADDRESS` | The host address those ports are published on. Default `127.0.0.1`: only this machine reaches the install. `0.0.0.0` opens it to the network, as a server needs. |
| `ORBIK_SITE_ADDRESS` | A domain name, for HTTPS (below). Default `:80`, plain HTTP. |
| `ORBIK_SIGNUP` | `closed` (default): people join by invite from a workspace's settings. `open`: anyone who reaches the sign-in page can create an account. |
| `ORBIK_ADMIN_EMAILS` | Comma-separated addresses of the install's admins, who answer access requests and make password reset links on the Admin page (`/admin`). Unset: the install's first account. |
| `SMTP_URL`, `EMAIL_FROM` | Email invites, approved access requests and password reset links as well as showing them, and tell admins about a new access request. Without it, a forgotten password is reset by a link the admin makes (Admin page, or `docker compose exec api node src/cli/resetPassword.js --email …`). `smtp://user:pass@host:587` or `smtps://…:465`. |
| `ORBIK_CRAWLER_CONTACT_URL` | The page the crawler's User-Agent names, so a site owner who sees OrbikBot in their logs can find you. Default: [docs/orbikbot.md](orbikbot.md), which explains that the crawler is self-hosted and how to block it. |
| `ORBIK_TELEMETRY` | `on` sends anonymous usage statistics (below). Default `off`. |
| `SESSION_SECRET`, `ORBIK_ASSET_URL_SECRET` | Generated on first start and kept in the database unless you set them. |

### A domain with HTTPS

On a server with a public address, point a DNS name at it and set:

```sh
ORBIK_SITE_ADDRESS=orbik.example.com
ORBIK_URL=https://orbik.example.com
ORBIK_BIND_ADDRESS=0.0.0.0
ORBIK_HTTP_PORT=80
ORBIK_HTTPS_PORT=443
```

The proxy (Caddy) gets and renews the certificate itself. HTTPS matters beyond privacy: Claude.ai,
Claude Desktop and ChatGPT connect to Orbik over OAuth only on HTTPS (or `localhost`), and sessions
use secure cookies when the address is HTTPS.

A plain-HTTP address other than `localhost` works for the web app, but browsers treat it as
insecure; use it only on a network you trust.

### Behind another proxy

If something else sits in front of the published port — a load balancer, nginx on the host — every
request reaches Caddy from that one address, and the sign-in, setup and signup rate limits are then
shared by everyone. Tell Caddy to trust that proxy's `X-Forwarded-For` in the global options block
at the top of `deploy/Caddyfile`, with the address ranges your proxy is in:

```
{
	admin off
	servers {
		trusted_proxies static 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16
	}
}
```

### Connecting your own AI

Every workspace's **Settings → Orbik MCP** mints a token for Claude Code, Cursor and other
clients that take one, at `<ORBIK_URL>/mcp`. Claude.ai and ChatGPT add `<ORBIK_URL>/mcp` as a custom
connector and sign in through Orbik.

## Backups

Everything Orbik keeps is in MongoDB, including the brand images (GridFS, `brand_assets_files`).
Qdrant holds only the search index, which can be rebuilt from MongoDB, at the cost of embedding
everything again.

```sh
# Back up MongoDB to a file on the host
docker compose exec -T mongo mongodump --archive --gzip --db orbik > orbik-$(date +%F).archive.gz

# Restore it (into a fresh install, or over the current data)
docker compose exec -T mongo mongorestore --archive --gzip --drop < orbik-2026-10-31.archive.gz
```

To keep the search index too, copy Qdrant's volume while it is stopped:

```sh
docker compose stop qdrant
docker run --rm -v orbik_qdrant-data:/data -v "$PWD":/backup alpine tar czf /backup/qdrant.tgz -C /data .
docker compose start qdrant
```

Restoring is the reverse with `tar xzf` into the volume. Without a Qdrant backup, a restored install
re-indexes the Library on its own over the next scheduler passes, if `ORBIK_OPENAI_API_KEY` is set.

## Upgrades

Releases are tagged (`v0.1.0`, …) and listed with what changed in
[CHANGELOG.md](../CHANGELOG.md) and on the repository's Releases page. Run a tag rather than
`main`, which moves between releases:

```sh
git fetch --tags
git checkout v0.1.0          # the release you are moving to
docker compose up -d --build
```

The API, the worker and the scheduler each bring the database up to date when they start: indexes
are created, and any **data migrations** the new release brings (`packages/migrations`) run once,
in order, under a lock — whichever process starts first does them and the others wait. A migration
that fails stops that process with its name in the log and is tried again on the next start. Back
up MongoDB before upgrading; going back to an older release after a migration has run is not
supported.

### Collections left by earlier releases

Builds of Orbik from before its first public release shipped SEO agents that now live outside
this repository, and a database those agents ran in still holds their collections. The migration
`2026-11-09-retire-seo-agents` removed what would otherwise be acted on — their schedules, setups
and queued runs, and pending Search Console sync jobs — and left their past runs and AI calls in
Activity and the AI call log as history. It drops no collection: these are kept until you decide
otherwise.

- `lighthouse_reports`, `change_watch_digests`, `technical_audits`, `agent_suggestions`,
  `overlap_scans`, `alt_text_images`
- `search_console_connections`, `search_console_oauth_states`, `search_console_property_days`,
  `search_console_page_days`, `search_console_query_days`, `search_console_reports`
- `competitor_setups`, `competitor_reads`, `competitor_pages`, `competitor_reports`,
  `competitor_site_maps`, `competitor_documents`, `competitor_profiles`, `competitor_changes`

Nothing reads or writes them. Deleting a workspace still removes its rows from them
(`RETIRED_COLLECTIONS` in `packages/core/src/db/collections.js`). A Search Console connection's
row is deleted with it, but Orbik no longer revokes its Google token; to withdraw that access,
remove the app at <https://myaccount.google.com/permissions>.

To drop them all, after a backup:

```sh
docker compose exec -T mongo mongosh orbik --quiet --eval '[
  "lighthouse_reports", "change_watch_digests", "technical_audits", "agent_suggestions",
  "overlap_scans", "alt_text_images",
  "search_console_connections", "search_console_oauth_states", "search_console_property_days",
  "search_console_page_days", "search_console_query_days", "search_console_reports",
  "competitor_setups", "competitor_reads", "competitor_pages", "competitor_reports",
  "competitor_site_maps", "competitor_documents", "competitor_profiles", "competitor_changes"
].forEach((name) => db.getCollection(name).drop())'
```

Without Docker, run the same `mongosh orbik --eval '…'` against your database.

## Anonymous usage statistics

With your permission, the scheduler sends one small JSON document a day to
`https://telemetry.orbik.io/v1/ping`, so the maintainers can tell how many installs there are and
what they use. It is **off** unless you turn it on, and the scheduler says which in its log when it
starts:

```sh
ORBIK_TELEMETRY=on
```

This is all it sends — every ping is also written to the scheduler's log (`telemetry.sending`):

```json
{
  "installId": "a random id made for this install, kept in its database",
  "version": "0.1.0",
  "node": "24.14.0",
  "sentAt": "2026-10-31T15:56:16.312Z",
  "counts": {
    "workspaces": 5,
    "crawlRuns30d": 1,
    "pagesFetched30d": 79,
    "agentRuns30d": { "business-knowledge-base": 2 }
  },
  "services": {
    "anthropic": true,
    "openaiEmbeddings": true,
    "chrome": true,
    "extensions": 0
  }
}
```

No page, address, hostname, workspace name, email or key is read into it.

## Without Docker

The processes run directly on a machine with Node 24, pnpm, MongoDB and (optionally) Qdrant and
Chrome; see the [README](../README.md). On a fresh database the API prints the same setup code, and
`pnpm --dir backend run seed:user -- --email you@example.com` creates an account from a terminal
instead.

## Commands in the Docker install

The images carry no pnpm; run the API's commands with `node` in its container (it asks for a
password on the terminal):

```sh
docker compose exec api node src/cli/seedUser.js --email you@example.com
docker compose exec api node src/cli/resetPassword.js --email you@example.com
```
