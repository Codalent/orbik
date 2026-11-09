# Contributing to Orbik

Thank you for wanting to help. This file says how Orbik is worked on, so a pull request does not
have to argue for it.

## License and the CLA

Orbik is licensed under the [AGPL-3.0](LICENSE). Before your first pull request can be merged, you
sign the [Contributor License Agreement](CLA.md): CLA Assistant comments on your pull request with a
link to it, and you sign by replying with the sentence that comment gives. You sign once, and it
covers every pull request after.

You keep the copyright in what you contribute. The agreement gives Codalent Technologies Pvt Ltd,
which maintains Orbik, the right to use your contribution under other licences as well, including
in Orbik's hosted version. Every version of Orbik already published under the AGPL stays available
under it.

If you contribute as part of your job, sign on behalf of your employer only if you are authorised
to, or make sure your employer agrees to your contributing.

## Setting up

Follow **Develop it** in the [README](README.md): Node 24, pnpm, MongoDB, and optionally Qdrant and
Chrome. `pnpm dev` runs the web app, the API, and the worker and scheduler with file watching.

## How changes are checked

**There are no automated tests in this repository, by the maintainers' decision**, and a pull
request should not add unit, contract, integration or browser tests, or a test framework. Every
change is checked against the running processes instead:

- `curl` the API, query MongoDB, open the page in a browser, or run a throwaway script against a
  scratch copy of the database.
- In the pull request, say what you ran and what you saw: the request and its answer, the page and
  what it showed, the rows a script read. That is the evidence a reviewer reads.
- Do not run a production build (`next build`, `docker build`) for a pull request unless it changes
  the build itself.

`pnpm lint` must pass. It includes the repository's boundary rule (below).

## The boundary

Orbik is complete on its own, and deployments add to it only through the extension seam
([docs/extensions.md](docs/extensions.md)). Two rules follow:

- Core starts and serves every page with no extension loaded.
- Nothing in `backend/`, `agents/`, `frontend/` or `packages/` imports from outside this repository.
  ESLint fails on it (`eslint.boundary.mjs`).

A feature that only makes sense for one deployment does not belong in this repository; a hook
that lets a deployment add it may.

## Changing what is stored

New code that needs data stored before it existed in another shape comes with a **migration** in
`packages/migrations/src/migrations.js`: idempotent, filtered on the old shape, and never edited
after it is released. Indexes are not migrations; each process creates its own at start.

## Writing

Comments and documentation say what something is for and why it is that way, in plain sentences.
Agent definitions are code (`packages/agent-definitions/src/`) and change like any other file.
[AGENTS.md](AGENTS.md) is the longer guide to the codebase, written for people and coding agents
alike.

## Reporting a security problem

Not in an issue: see [SECURITY.md](SECURITY.md).
