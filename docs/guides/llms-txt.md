# llms.txt

Orbik writes your site's llms.txt — a short map of the site for language models — from the pages it
crawled, and keeps it current as the site changes. You publish it on your site.

[llms.txt](https://llmstxt.org) is a Markdown file a site serves at its root, `/llms.txt`, so a
model arriving at the domain can learn what the site is and which pages are worth reading, without
crawling every page. It has one `#` title, a `>` summary line, optionally a paragraph of context,
and then `##` sections of links, each with a line saying what the page covers. A section named
`Optional` holds links a reader may skip.

## Writing it

Open **llms.txt** among the workspace's agents. The agent chooses from the pages your crawler has
rendered, so crawl the site first (see [Crawling](crawling.md)). **Run now** writes the first file;
**Set to work** has it run once a week from then on. Running it needs the **Member** role or above.

A run:

1. Reads the current file, if there is one, so an update keeps what still holds.
2. Reads the Library's overview when there is one, so the title and summary agree with it. The
   agent does not wait for the Library: without one it reads the site itself.
3. Sets aside whole kinds of page that never belong in llms.txt — tag and category listings,
   pagination, author pages, the blog archive — rather than judging them one by one.
4. Chooses the pages that matter: the home page, what the company does and sells, pricing,
   documentation, key guides, about and contact. Usually thirty links or fewer: a map, not an index.
5. Writes the file, grouped into sections that mean something for your site.

**Every link is checked.** A link to your own site must be a page the crawler actually fetched; a
URL the agent made up is refused, and it corrects the file before it finishes. Links to other
sites, such as your code repository or status page, are allowed.

## Publishing it

The page shows the file as written, with **Copy** and **Download**, its revision and when it was
written. Under **What it points at** are its sections with every link, so you can check where each
one goes.

Orbik does not publish the file for you. Put it at the root of your site, so it answers at
`https://<your site>/llms.txt`. When the agent writes a new revision, publish that one. The file is
not edited in Orbik: each revision is the agent's.

## Keeping it current

Each run remembers which pages it has already dealt with — the ones it linked and the ones it
decided against — by their content. The next run is offered only pages that are new or have
changed since, so a second run is quick and cheap.

On an update the agent keeps the sections and descriptions that still hold, adds pages that are
new, rewrites the lines for pages that changed, and removes links to pages that are gone. When
nothing relevant has changed, it leaves the file alone and no new revision appears.

## Your AI reads it too

An AI connected to the workspace reads the current file with `llms_read` (see
[Connect your AI](../connect-your-ai/README.md) and the [tool reference](../connect-your-ai/tools.md)).

How the agent works in detail: [The Library § llms.txt](../architecture/library.md#llmstxt).
