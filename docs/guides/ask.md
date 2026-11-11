# Ask

Ask is a chat beside every workspace page that answers from your own site and Library, with a
source under every answer. Members can also have it save to the Library and rearrange it.

## Opening it

Press **Ask** in the workspace's rail, the **Ask ⌘J** button at the top of the page, or ⌘J (Ctrl+J
elsewhere). The panel opens at the right and stays open, with its conversation, as you move between
pages. **Conversations** lists earlier ones and **New conversation** starts afresh.

From the Library's quick switcher (⌘O), Cmd+Enter puts what you typed in Ask's box. A link to
`/workspaces/<id>/ask?q=<question>` opens the panel with that question in its box.

## What it answers from

Ask searches an index of your site and your Library: every crawled page that is a document in its
own right — not a duplicate URL, a `noindex` page, or a paginated, tag, category or author listing
— and every Library file people and agents wrote. Pages are cut into sections at their headings, so
an answer can point at the part of a page that says it.

- Every answer lists its **Sources**. A page opens on your live site at the section cited; a
  Library file opens in the Library.
- When an answer rests on a single mention it says so. When nothing in the index answers the
  question, it says **Nothing indexed answers this** and lists what it searched for. It never fills
  the gap from what a model knows about companies like yours.
- It knows which page you are on, and on the Library which file. That is shown above the box, and
  you can take it off before sending.

## Saving and rearranging

Members and above can tell Ask to save something to the Library ("Save this to the Library: …") or
to rearrange it: new folders, moves, renames, the order things are shown in, and deletions.

- Small, explicit changes are made at once. A bigger plan — more than five moves or renames,
  renaming or deleting a top-level folder, deleting anything, merging files — comes back as a list
  first, with **Go ahead** and **Change the plan**.
- What it changed is listed under **Changed in your Library**, each path opening where the thing
  now is. The changes are recorded as yours, via Ask, and every one can be undone from the file's
  history.
- It follows the Library's rules: it does not write in a locked file or folder, or in Sources.

Read-only members can ask questions; saving and rearranging need a member.

On the Brand page the same panel talks about the brand instead: drop in a logo, a brand guide,
fonts or design tokens, or say what to change. See [Brand](brand.md).

## What it needs

- **A search index.** Pages are indexed within a minute of a crawl finishing, and Library files
  after they are written. That needs `ORBIK_OPENAI_API_KEY`, which makes the embeddings, and Qdrant,
  which holds them. A new conversation starts with a line saying what is searched — "Searching 412
  sections from 60 pages and 18 Library files, updated …" — or that nothing is indexed yet, or why
  the index cannot be searched. Ask says which, rather than answering as though the site said
  nothing.
- **A model for the answer.** Each question is an agent run, made with the reasoning provider's
  key: `ORBIK_ANTHROPIC_API_KEY`, or `ORBIK_OPENAI_API_KEY` when that is the only one set (or
  `ORBIK_AI_PROVIDER=openai`). Without it, questions fail saying no AI provider is configured. Every call is listed under
  **Settings** → **AI calls**.

Both keys are set as described in [Configuration](../self-hosting/configuration.md).

How a question becomes a run, and how the index is built, are in
[architecture/library.md](../architecture/library.md#ask-a-chat-over-the-index) and its section on
[the retrieval index](../architecture/library.md#the-retrieval-index).
