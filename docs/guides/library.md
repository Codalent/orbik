# The Library

The Library is your workspace's knowledge as folders of Markdown files: a word-for-word copy of
every crawled page, and a knowledge base written from them that people and agents both edit.

## Two layers

- **Sources** (`/sources/website`) holds a copy of every crawled page, at a path that follows the
  page's address. It is written by code when a crawl finishes — no AI model reads a page in order
  to store it — and kept in step with the site after every crawl. A copy is marked **Copy of the
  site · read-only**, with the live page one press away.
- **The knowledge base** is the folders above it: what the company is, said once and in one place
  — an overview, an index, and subjects such as services, pricing and case studies. The
  **Knowledge base agent** writes it with an AI model from a selection of the site's pages, and
  links each file down to the copies it was written from (**Evidence**, at the foot of a file).

Apart from duplicate URLs and pages marked `noindex`, every page is stored, whatever the size of
the site. Only the knowledge base is written from a selection, so what a site costs follows the
size of its knowledge base, not its page count.

## Which pages the knowledge base is written from

Code chooses them, with no model asked: up to 80 pages, by how many of the site's pages link to
each. In order, it takes pages a person asked for, pages a file of the knowledge base already
cites, pages linked from across the site (the navigation), the pages a site-wide page lists when it
lists only a few (a case studies page, say), and then the rest, most linked first. Legal pages,
logins and carts, paginated and tag listings, and pages with next to nothing on them are left out
unless somebody asks for them.

**Source ledger**, at the foot of the explorer, lists every page with the reason it was used or
left out — "Linked from 72 of the site's 72 pages" — under **All**, **Used** and **Left out**. On a
left-out page, **Include** asks for the knowledge base to be written from it too. The row says
**Queued** until the next write run has used it. A copy's inspector offers the same under **In the
knowledge base**.

## Choosing the top-level folders

The top level of the Library is yours. After the first crawl, once the **Knowledge base agent** is
set to work (the switch at the foot of the explorer), Orbik reads the site map and the most
linked-to pages and proposes two or three ways to organise it, each with a line on why it fits,
beside its default. While the agent is paused nothing is proposed, since a proposal is a model
call; the default is there either way:

```
00 Start Here   overview · index · open-questions
01 Company      about · team
02 Offer        services · products · features · pricing · process · faqs
03 Proof        case-studies · customers · testimonials
04 Market       buyers · industries · competitors
05 Content      content
```

Home calls this step **Choose how your Library is organised**, and the Library opens it as a tab.
Pick one, rename, add, remove or reorder its folders (up to twelve; the first holds the overview
and the index), and press **Use this structure**. **Propose again** asks for new proposals. Nothing
is written until you confirm.

After that, agents never write at the top level and never rename, move or delete a folder a person
made. The numbers are part of each folder's name and nothing more; the order is set with **Move
up** and **Move down**. **Rebuild the structure…**, under **What changed**, offers the step again,
and the next run moves what the Library holds into the new folders, links and history included.

Two folders are not yours to choose: **Sources**, and `brand`, which is reserved for the Design
system agent.

## The overview and the index

The **overview** is the Library's front page: the briefing everything else starts from. The
**index** says what to read for which job — for sales outreach these files, for ads these. Both live
in the first top-level folder, move with it when it is renamed, and cannot be deleted. Your own AI
starts from them too when it reads the Library (see
[Connect your AI](../connect-your-ai/README.md)).

The `open-questions` file lists what the site leaves unsaid. Opened in the Library, it becomes
**Answer what the site leaves open**: answer a question in place, and the answer is added as your
paragraph to the file the question is about.

## Editing

Members and above edit the Library; read-only members read it.

Open a file and switch to **Editing** (⌘E). A file is edited block by block — a block is a
paragraph, list, table or heading — with its title, summary and tags above. Type `[[` to link to
another file. **Done** saves and returns to reading, ⌘S saves and stays, and **Discard** drops the
draft. New files and folders come from the explorer's toolbar or a folder's **+**.

What you write is kept:

- A block you write, or change, is yours. It is marked **Your writing · kept** (or **Yours now ·
  changed from the agent's**), and the agent must keep it every time it rewrites the file. Changing
  one word of the agent's paragraph makes the whole paragraph yours.
- A block you delete stays deleted: the agent cannot put it back.
- **Lock: keep agents out** on a file or folder stops every agent writing there, including your
  own AI writing for you. Only a person unlocks it.
- **Rename or move…** rewrites every link to the file or folder, inside your own blocks too.
- **History** keeps the last twenty versions of every file, with who wrote each and what changed.
  **Restore revision N** writes the old version forward as a new one, so nothing is lost.

## When the knowledge base is rewritten

Nobody starts a write run by hand. At the foot of the explorer, the **Knowledge base agent**
switch decides whether the agent works at all:

- Set to work, it rewrites the knowledge base when a crawl finds that a page it is written from
  has changed, a page has been newly chosen, or a chosen page has left the site — once the crawl's
  copies have settled. A new blog post is copied and indexed on its own; it usually starts a run
  only through the blog's listing page, which changes with it and is linked from across the site.
- Paused, the site is still crawled, copied into Sources and indexed for search; the knowledge
  base is left as it is.

While a run is in flight, **This run** shows it and **Stop** ends it. **What changed** lists what
past runs changed. A run that fails is tried again when the site next changes, or when the agent
is paused and set to work again.

Writing needs a reasoning key: `ORBIK_ANTHROPIC_API_KEY`, or `ORBIK_OPENAI_API_KEY` on its own
(`ORBIK_AI_PROVIDER` picks one when both are set; see
[Configuration](../self-hosting/configuration.md)). Without one the copies and the search index are
still made. Every model call is listed under
**Settings** → **AI calls**. On a site of about seventy pages, with Claude making the reasoning
calls, a first build came to about $0.90 and a structure proposal about $0.10; an ordinary
update, which reads only the pages that changed, costs a fraction of a first build.

## Finding things

⌘O (Ctrl+O) opens the quick switcher: **Files** matches titles as you type, and **By meaning**
searches the same index Ask and your own AI search, so a question in your own words finds the
passage that answers it. Ask itself is beside every page: see [Ask](ask.md).

Some folders show pages of the site rather than files of their own: a case studies folder can list,
under **Pages from the site**, the case studies the site links to, each opening its copy in
Sources. The list follows the site as pages are added and removed.

How the Library works inside — the mirror, the selection, the write run and the rules every
writer follows — is in [architecture/library.md](../architecture/library.md).
