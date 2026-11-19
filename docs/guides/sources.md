# Sources

Sources is everything Orbik reads for a workspace: its website first, and any other site of yours
or page about you that you add. Each source is read on its own schedule and copied, word for word,
into the Library under `/sources`, where the knowledge base, Ask and your AI tools find it.

## The Sources page

**Sources** is in the workspace's rail, between **Brand** and **Agents**, with a lime dot while a
source is being read. Its sidebar lists **All sources**, then **Your sites** and **Elsewhere**, and
**Add a source**; the activity monitor sits at its foot.

**All sources** heads with four figures: how many sources there are, how many pages are in the
Library under `/sources` (and how many more are on the way while a source is being read), how many
page fetches this month has made across every source, and how many sources need a look. Below them
each source is a row: its name, what it reads, how many pages it has, its folder in the Library and
how it is doing. Press a row for the source's own page.

| Status | Means |
| --- | --- |
| **First crawl · copying pages** | The source's first read is running |
| **Reading** | A later read is running, with how far it has got |
| **Queued** | A read was asked for and starts within a minute |
| **Up to date** | The last read finished; when it was read |
| **N pages changed** | The last read found new words on N of the pages |
| **Refused** | The site would not let the crawler in, with the status it answered |
| **Stopped: out of crawl pages** | The month's crawl budget ran out part-way |
| **Stopped** | Somebody stopped the read |

## Two kinds of source

- **A site of yours** — your website, a subdomain such as `docs.example.com`, or another domain
  you own. Orbik follows every link and sitemap on that host, as it does for your website.
- **Pages about you elsewhere** — a review profile, a directory listing, a press article. Orbik
  reads only the pages you list, and never follows links off them.

Each host is read by one source. Your website and `docs.example.com` are two sources, and a link
from one to the other is left to the source it belongs to rather than read twice.

## Add a source

Press **Add a source** and paste an address. Orbik looks at it the way the crawler will — as
OrbikBot, obeying `robots.txt` — and says what it found: the page's title, or that the site
answered with an error, refused OrbikBot, or asks crawlers not to read it. It suggests:

- **What kind of source.** An address under your website's domain is suggested as a site of yours;
  anything else as pages about you. You can say otherwise. Choosing *a site of yours* for somebody
  else's site says what that would cost: Orbik would follow every link on it, all charged to the
  workspace's crawl budget.
- **What it is** — see below.
- **A name**, and the folder it is copied into: `/sources/docs` for `docs.example.com`,
  `/sources/clutch` for a Clutch profile. The folder is set when the source is added.
- **How often**: every day, week or month, or only when you ask.

For pages about you, **Follow its own "next page" links** reads a listing split over several pages
— reviews 1 to 10, 11 to 20 — and nothing else: only addresses that are the listed page with a page
number (`?page=2`, `/page/2`), only on that host.

**Add and read now** adds the source and starts its first read within a minute. Adding a source
needs the member role or above, and the website's crawl set up first.

Some sites cannot be added: those whose `robots.txt` asks every crawler not to read them, such as
LinkedIn, X, Facebook and Instagram. Orbik says so rather than adding a source that would read
nothing.

## What it is, and how the knowledge base uses it

What you say a source is tells the knowledge base how to use its pages:

| What it is | How it is used |
| --- | --- |
| **Company & product** | Read as what the company says about itself and what it sells |
| **Documentation** | Read for what the product does and how; not where the company's claims come from |
| **Blog & news** | Read for what the company has said and when; dated, never taken as current fact on its own |
| **Testimonials & reviews** | Quoted word for word with the reviewer's name and where they wrote it, never rewritten as the company speaking |
| **Press & mentions** | Quoted and attributed to the publication, as what others say about the company |
| **Something else** | Copied for search; the knowledge base decides case by case |

**In the Library** chooses whether the knowledge base may be written from a source:

- **Copy it, and let the knowledge base use it.** Its pages go under its folder, and the knowledge
  base is written from them as it is from your website's. A list of pages is written from in full;
  another site is chosen from by the same rule as your website (see
  [The Library](library.md#which-pages-the-knowledge-base-is-written-from)), up to 40 pages of its own.
- **Copy it only.** Its pages go under its folder for Ask and your AI tools to search, and nothing in
  the knowledge base is written from them. Its pages cannot be included by hand either.

The website is always written from.

## A source's page

A source's page heads with its state and **Read now** (or **Stop crawl** while it is being read)
and **Open in Library**. While a source is read, a bar shows the pages read, left out and waiting.
Below are its settings, which apply from its next read:

- **How much of it**, for a site of yours other than the website: **The whole site**, **One
  section** (only addresses under a path such as `/guides/`) or **Only these pages**.
- **Where it starts** and **Leave out**: the address each read starts from, and address prefixes to
  skip, one per line, with `*` for anything (`/v1/*`). The pages left out so far are counted.
  **Sitemaps** lists those `robots.txt` names and takes more.
- **Pages Orbik reads**, for a list of pages: the pages you listed and the next pages found from
  them. Add or remove pages here; every page is on the source's host.
- **What it is**, **In the Library** and **How often**, as above.
- **Remove this source** (admin or owner): Orbik stops reading it, and its folder leaves the
  Library with every page copied there. What the knowledge base already wrote from it stays, citing
  the pages it was written from. The website cannot be removed: change it under Settings.

Beside them: the latest pages read and the ones left out and why, or for a list of pages what the
last read found on each; **The copy**, the source's folder in the Library; and **Quoted in**, the
knowledge base's files that cite its pages. Every source's full page list — the tree, its figures,
frequencies and crawl logs — is a link away, at **All N pages**. For the website, that is the crawl
page described in [Crawling your site](crawling.md).

## Found on your website

All sources ends with the pages about you that your website links to and that are not sources yet:
a review profile, a directory listing, your public repositories. Each says where your site links to
it. **Add** opens Add a source with the address filled in; **Dismiss** stops suggesting it. A site
Orbik cannot read is listed with why. The list is read from your website's last crawl and costs no
request.

## Crawl budget

Every source draws on the workspace's monthly crawl budget, where an extension sets one (see
[Crawling your site](crawling.md#keeping-pages-up-to-date)). A source other than the website leaves
the last fifth of the month's pages to the website, so the site everything else is built on always
has room to be read.

How sources are crawled and copied inside is in [architecture/crawler.md](../architecture/crawler.md#sources)
and [architecture/library.md](../architecture/library.md#the-source-layer-a-copy-of-every-page).
