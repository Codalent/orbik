# Orbik frontend

Next.js 16 App Router UI in plain JavaScript (React 19, SWR, Tailwind), talking to `../backend`.

## Routes

Nothing here is public-facing beyond sign-in, setup and invites, and `robots.txt` asks search
engines to stay out.

- Public: `/` sends someone signed in to their workspace (or to `/workspaces/new`) and anyone else
  to `/login`. `/setup` claims a new install with the code the API prints; `/signup` creates an
  account when signup is open and is a **Request access** form when it is closed; `/invite/[token]`
  and `/join/[token]` accept an invite or an approved request; `/forgot-password` and
  `/reset-password/[token]` reset a password.
- Standalone: `/admin` is the install's admin page; `/llm-calls` is the account's model-call log;
  `/oauth/consent` approves an AI client's request to read a workspace; `/workspaces/new` is the
  two-step name and URL form.
- In the workspace shell under `/workspaces/[id]`: `home`; `library`; `ask`; `markdown`, every
  crawled page as Markdown; `brand`; `agents` and the agent pages under it; `ai-calls`;
  `settings` (with `people`, `ai`, `ai-calls` and extension sections); and one catch-all for pages
  an extension adds.

## Layout

- `src/app`: routes. Workspace routes that read the route's ids pair `page.jsx`, a server component
  that exports `metadata` (a `"use client"` file cannot), with `view.jsx`, a client component that
  reads them with `useParams`, because awaiting `params` would render every request on the server.
- `src/components/<feature>`: UI by feature; `agents` holds what several agent pages share.
  `src/components/ui`: vendored shadcn-style primitives on Base UI (`components.json`).
- `src/lib/api`: one client (`client.js`) and a module per API area. The `…Path` functions build a
  read's URL and double as its SWR key. `src/lib/<feature>`: logic and hooks; `src/lib/format.js`.
- Forms use React Hook Form and Zod for immediate feedback. The API repeats every rule, because
  browser validation is a usability layer, not a trust boundary.

## Configuration and commands

Copy `.env.example` to `.env.local`. `NEXT_PUBLIC_API_BASE_URL` is the API's exact origin, embedded
at build time (default `http://localhost:4100`). Open the app on the host name it uses:
`http://localhost:3100` by default. The session cookie is host-only and `SameSite=Lax`, so it is
withheld from requests a page on `127.0.0.1` makes to `localhost`. The API's `FRONTEND_ORIGINS`
must list the origin you open.

```sh
pnpm dev     # next dev on 127.0.0.1:3100
pnpm lint    # eslint src
pnpm build   # next build --webpack
pnpm start   # next start on 127.0.0.1:3100
```

There are no automated tests: changes are verified against the running dev server, as described in
the repository's `CONTRIBUTING.md`.
