# @orbik/library

The Library's domain code: the one filesystem of folders and files per workspace that agents and
people both write. It depends only on `@orbik/core`.

## What belongs here

A rule belongs here when **two writers must share it**. An agent calling `library.write` and a
person saving a file through the API are two doors into the same documents, so everything that
decides what a valid write is lives in one place:

- **Paths, limits and errors** (`src/library.js`) — what a path is, the reserved paths, the bounds.
- **Block rules** (`src/blocks.js`) — the paragraphs a person wrote, which an agent's next version
  must keep.
- **The store** (`src/store.js`, `createLibraryStore`) — the only implementation of reads and
  writes; the API and the tools are thin adapters over it.
- **The source layer** (`src/sourceLayer.js`) — where the copy of a page lives and which pages are
  not stored; **selection** (`src/selection.js`) — which of the stored pages the knowledge base is
  written from, by who links to them; **citations** (`src/sources.js`) — how a cited source is
  resolved against what the workspace holds.
- **Folder vocabulary** (`src/vocabulary.js`) and the **chunk kinds** the retrieval index files
  Library content under (`src/chunkKinds.js`).

## What does not belong here

How a writer is reached does not: HTTP handling and validation stay in `backend/`, the tool
definitions in `@orbik/tools`, the retrieval index in `@orbik/retrieval`, and the job that
mirrors a site into the source layer and the agents that maintain a Library in
`agents/src/library` and `agents/src/ai`.

Consumers are the API, the agents process, `@orbik/tools` and `@orbik/retrieval`. The web app does
not import it; `frontend/src/lib/library/library.js` repeats the few path rules a form needs.

See [docs/architecture/library.md](../../docs/architecture/library.md) for the design.

```sh
pnpm --dir packages/library lint
```
