# Configuration

Every setting of the Docker install, in the `.env` file beside `compose.yaml`. Only
`ORBIK_OPENAI_API_KEY` is required for the full product; without any of them the install still
starts and crawls.

Copy `.env.example` to `.env` to start from the commented list. After changing it, run
`docker compose up -d` again.

| Setting | What it does |
|---|---|
| `ORBIK_OPENAI_API_KEY` | **Required.** Embeddings for search, Ask and `content_search` over MCP; without it nothing is indexed. With no Anthropic key, it also makes every reasoning call: agent runs, the Library's knowledge base, Ask. |
| `ORBIK_ANTHROPIC_API_KEY` | Optional. With it set, Claude makes every reasoning call instead of OpenAI. With neither key, the install still crawls, keeps a word-for-word copy of every page in the Library and runs the agents that need no model. |
| `ORBIK_AI_PROVIDER` | Which provider makes the reasoning calls: `anthropic` or `openai`. Unset: Anthropic when its key is set, otherwise OpenAI. Embeddings use OpenAI either way. |
| `ORBIK_URL` | The address people and AI clients reach the install at, exactly as in the address bar. Default `http://localhost:8080`. |
| `ORBIK_HTTP_PORT`, `ORBIK_HTTPS_PORT` | Ports published on the host. Default 8080 and 8443. |
| `ORBIK_BIND_ADDRESS` | The host address those ports are published on. Default `127.0.0.1`: only this machine reaches the install. `0.0.0.0` opens it to the network, as a server needs. |
| `ORBIK_SITE_ADDRESS` | A domain name, for HTTPS ([A domain with HTTPS](https.md)). Default `:80`, plain HTTP. |
| `ORBIK_SIGNUP` | `closed` (default): people join by invite from a workspace's settings. `open`: anyone who reaches the sign-in page can create an account. |
| `ORBIK_ADMIN_EMAILS` | Comma-separated addresses of the install's admins, who answer access requests and make password reset links on the Admin page (`/admin`). Unset: the install's first account. |
| `SMTP_URL`, `EMAIL_FROM` | Email invites, approved access requests and password reset links as well as showing them, and tell admins about a new access request. Without it, a forgotten password is reset by a link the admin makes (Admin page, or `docker compose exec api node src/cli/resetPassword.js --email …`). `smtp://user:pass@host:587` or `smtps://…:465`. |
| `ORBIK_CRAWLER_CONTACT_URL` | The page the crawler's User-Agent names, so a site owner who sees OrbikBot in their logs can find you. Default: `https://orbik.io/docs/orbikbot`, the [OrbikBot](../orbikbot.md) page, which explains that the crawler is self-hosted and how to block it. |
| `ORBIK_TELEMETRY` | `on` sends anonymous usage statistics ([Usage statistics](usage-statistics.md)). Default `off`. |
| `SESSION_SECRET`, `ORBIK_ASSET_URL_SECRET` | Generated on first start and kept in the database unless you set them. |

Without Docker, the processes read `backend/.env` and `agents/.env` instead; their
`.env.example` files describe every setting.
