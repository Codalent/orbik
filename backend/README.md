# Orbik API

Express 5 JavaScript API behind the Orbik web app, listening only on a loopback `HOST`. It serves
`/health`, the session-authenticated `/v1` routes — sign-in (signup is disabled), owner-scoped
workspaces, crawl configuration and results, agent runs and setups, the llms.txt file and source
verdicts, the Library, a workspace's design system with its pins and images (`/brand`),
conversations and the AI call log — and two surfaces that outside software talks to: the MCP
endpoint (`POST /mcp`, bearer token) that a person's own AI reads a workspace through, and the
OAuth 2.1 authorization server (`/oauth/*`, `/.well-known/*`) that issues the tokens Claude.ai and
ChatGPT use. See `docs/library.md` § "Outside agents" before changing either.

## Structure

Session features flow through `routes` → `validators` → `controllers` → `services` →
`repositories`. Routes define middleware order, validators reject and canonicalize every external
input, controllers translate HTTP, services enforce use-case invariants, and repositories hold the
persistence queries. Shared validator helpers live in `validators/shared.js`, and the one workspace
ownership check every service uses is `services/workspaceAccess.js`. Only repositories and the
stores from `@orbik/core` and `@orbik/library` query MongoDB; a service is handed those, never a
raw collection.

The surfaces outside software talks to are feature folders instead, because they carry no session
and speak someone else's protocol:

- `mcp/` — the endpoint's router and service, the MCP server and its tool surface, and the pasted
  tokens it accepts (`mcpTokenService.js`, `mcpTokenRepository.js`).
- `oauth/` — the authorization server's router, its service, client registration, the repository
  for clients, requests, codes, grants and tokens, and the OAuth error envelope.

What the signed-in web app does with those credentials — minting and revoking tokens, listing and
disconnecting approved apps, and the consent screen — is ordinary session work and sits in the
layers (`mcpTokenRoutes.js`, `oauthConsentRoutes.js` and their controllers and validators), calling
the services in the two folders.

Errors use the `{ error: { code, message, correlationId, fields? } }` envelope; the OAuth routes
answer in the RFC 6749 shape instead. Unknown JSON fields, oversized bodies, non-JSON mutations,
disallowed origins, CSRF failures and unauthenticated workspace access are rejected before any write.

## Configuration

Copy `.env.example` to the untracked `.env`; it lists every variable the API reads.
Every value is validated before the listener opens, and the process refuses to start on a bad one.

## Commands

```sh
pnpm dev
pnpm start
pnpm lint
pnpm run seed:user -- --email owner@example.com
pnpm run grant:crawl-budget -- --email owner@example.com --pages 50000 [--reason "..."]
```

`seed:user` is the only way to create an account, in every environment. It prints the target
database and email, prompts for the password on a TTY without echo (8–1024 characters), and stores
an Argon2id hash; an email that already exists fails on the unique index. `grant:crawl-budget` adds
pages to an account's crawl budget for the current month only.

There are no automated tests: changes are verified against the running API and database, as
described in the repository's `AGENTS.md`.
