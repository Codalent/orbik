# Ask

Ask is a chat beside every workspace page that answers from your own site and Library, with a
source under every answer. Members can also have it save to the Library and rearrange it.

## Opening it

Press the round lime button in a corner of the window, or ⌘J on a Mac (Ctrl+J on Windows and
Linux; hovering the button shows the one for your computer). Drag the button to move it: let go
and it settles in the nearest corner, and stays there next time. Ask opens as a column
of its own down the right of the window, and the rest of Orbik moves into a framed window beside
it; on a phone it covers the page instead. It stays open, with its conversation, as you move
between pages, and while it is answering or changing something the frame's edge glows. In its
header, **Conversations** lists earlier ones, **New conversation** starts afresh and **Widen Ask**
gives it more room. While Ask is open the round button is a cross; press it, Escape, or ⌘J again
to close Ask.

Once the site has been crawled, **Home** offers an ask box and a few questions to start with;
pressing one asks it at once, in a new conversation. Until the first crawl has finished, or while
no AI is configured, Home shows neither.

From the Library's quick switcher (⌘O, or Ctrl+O), ⌘Enter (Ctrl+Enter) puts what you typed in Ask's
box. A link to `/workspaces/<id>/ask?q=<question>` opens the panel with that question in its box.

## What it answers from

Ask searches an index of your site and your Library: every crawled page that is a document in its
own right — not a duplicate URL, a `noindex` page, or a paginated, tag, category or author listing
— and every Library file people and agents wrote. Pages are cut into sections at their headings, so
an answer can point at the part of a page that says it.

- Every answer lists its **Sources**, numbered. A page opens on your live site at the section
  cited; a Library file opens in the Library. **Copy** under an answer copies its text.
- While it works, it shows the step it is on and the ones it has finished: searching your site,
  opening a Library file, writing one.
- When an answer rests on a single mention it says so. When nothing in the index answers the
  question, it says **Nothing indexed answers this** and lists what it searched for. It never fills
  the gap from what a model knows about companies like yours.
- It knows which page you are on, and on the Library which file. That is shown in the box, and
  you can take it off before sending. It is a hint for what "this" and "here" mean, not a limit:
  Ask searches the whole workspace either way.

## Choosing the model

Beside the send button, the model picker says which AI model answers your next question. It lists
every model the install offers, most capable first, each with what it costs beside the most capable
one: with Claude, **Claude Opus 5.5** (the default), **Claude Sonnet 5.5** at about half the cost,
and **Claude Haiku 5.5** at a small fraction of it. A cheaper model answers simple questions well;
the most capable is worth it for a question that needs several searches put together, or for a big
rearrangement.

- The choice applies to the next question you send, and stays chosen: Orbik remembers it for you in
  this workspace, in this browser.
- You can change it between questions of one conversation. The next answer is written by the new
  model, which reads the conversation so far.
- Under each answer, beside **Copy**, is the name of the model that answered it. When the provider
  passed a declined question to another model, that model is the one named.

An install whose AI provider is OpenAI offers its two models instead. When the install changes its
provider, a choice it no longer offers goes back to the default.

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
  `ORBIK_AI_PROVIDER=openai`), on the model chosen in the picker. Without it, the panel says that AI is not available before anything
  is typed (the install's admin is told which setting to change), and Home does not offer
  questions. Every call is listed under
  **Settings** → **AI calls**.

Both keys are set as described in [Configuration](../self-hosting/configuration.md).

How a question becomes a run, and how the index is built, are in
[architecture/library.md](../architecture/library.md#ask-a-chat-over-the-index) and its section on
[the retrieval index](../architecture/library.md#the-retrieval-index).
