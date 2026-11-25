# Crawling your site

Orbik reads your website page by page and keeps a Markdown copy of each one. Everything else — the
Library, search, Ask, llms.txt and the brand — works from what the crawl keeps. The website is the
first of a workspace's [sources](sources.md); other sites of yours and pages about you elsewhere are
crawled the same way, each as a source of its own.

## Start the first crawl

1. Create a workspace: give it a **Workspace name**, then the **Website URL** it is about, and
   press **Create workspace**.
2. On **Home**, the first step is **Connect your website**. **Start first crawl** starts the crawl
   from the workspace's website and opens the website's pages under **Sources** in the workspace's
   rail (**Sources** → **Website** → **All N pages**). The crawl is queued, starts within a minute,
   and the page follows it without a reload: the pages appear in the table as they are found. If it
   cannot start — the month's crawl budget is used up, say — the step says why.
3. To begin somewhere else on the same site, or to list sitemaps first, press **Choose the start
   address or add sitemaps first** instead. On the crawl's set-up, **Start crawling from** is
   filled in with the workspace's website; an address typed without `https://` (`example.com`) is
   read as one. Orbik finds sitemaps through robots.txt and the usual locations; only if yours
   live somewhere unusual, open **Add sitemap URLs** and list them, one per line. Then press
   **Start crawling this site**, right under the address. What a crawl does is explained under the
   button.
4. When the first crawl is in, the crawl page says what comes next: choosing how the Library is
   organised, in the [Library](library.md).

Setting up and starting crawls needs the member role or above. A read-only member sees the
crawl's results but not the controls.

## What a crawl does

- It reads robots.txt and your sitemaps, then follows links outward from the start address. A page
  nothing links to is still found if a sitemap lists it; a page that is in no sitemap and linked
  from nowhere cannot be found.
- It crawls the start address's hostname only. A subdomain is a different site: add it as a
  [source](sources.md) of its own, beside the website. `example.com` and `www.example.com` are the
  one pair treated as the same site, when one only redirects to the other: Orbik crawls the one that
  answers, whichever you typed, and **Start crawling from** then shows that address (see
  [When your address redirects to www](#when-your-address-redirects-to-www)).
- It turns every page that answers successfully into content-only Markdown, leaving out the
  navigation, the page's header and footer, cookie banners and forms. No AI model is involved in
  crawling.
- When it finishes, it hands the site to the Library, which copies every page into its Sources
  folder and indexes them for search (see [The Library](library.md)).

## The crawl page

Every source has one: the **Pages** tab of its page under **Sources** (the website's is at
**Sources** → **Website** → **Pages**). The old address, `/agents/crawler`, leads to the website's.

A source's page has three tabs under one head. The head says how the crawl stands, the site's
address, when it was last crawled and **Next visit in …**, when Orbik next comes back on its own
(see [Keeping pages up to date](#keeping-pages-up-to-date)), and holds **Crawl now** (**Stop
crawl** while a crawl runs or waits to). Hover over **Crawl now** for what it fetches.

- **Overview** — the figures below, the month's crawl budget, the latest pages read, the source's
  folder in the Library and the knowledge base's files that quote it.
- **Pages** — every page, the pages behind each finding, and **Crawl logs** (every run, how it was
  started and how it ended).
- **Settings** — where the crawl starts and what it leaves out, **Set crawl frequencies**, **Fresh
  crawl** and **Clear crawl data**, with the rest of the source's settings
  ([Sources](sources.md#a-sources-page)).

While a crawl runs, the head shows its progress as pages fetched "of about N". N grows as the
crawl finds new pages through links, which is why it is a count rather than a percentage. A live
log on the Pages tab lists what each page answered.

The figures on the Overview tab describe the site as the last crawl left it, each in the colour of
what it means: **Crawled** is lime once the last crawl has finished, and **Duplicate URLs** cyan,
**Nothing links here** orange and **Broken** coral whenever they count a page. A figure of none
stays grey.

| Figure | Means |
|---|---|
| **Pages** | Distinct pages, with duplicate URLs folded into one |
| **Crawled** | Pages fetched by the last crawl |
| **Duplicate URLs** | Addresses that lead to a page already counted |
| **Broken** | Pages that answered with an error when they were last fetched |
| **Nothing links here** | Pages reached through the sitemap alone |

Press **Duplicate URLs**, **Broken** or **Nothing links here** to list those pages on the Pages tab,
each with what it answered (and, for a duplicate, the page it is folded into). On the Pages tab the
same three are buttons above the list, in the same colours and with their counts; **Every page**,
or **Show every page**, brings back the tree.

The Pages tab lists every page as a tree of paths, with each page's crawl frequency. Hover over a
column's heading for what it counts:

| Column | Means |
|---|---|
| **Noindex** | Pages search engines are told not to index, or cannot: a noindex tag or header, a canonical naming another page, a redirect or an error |
| **Orphan** | Pages no other page links to; only the sitemap names them |
| **Not crawled** | Pages found but not fetched yet: they wait for the next crawl |
| **Recrawl** | How often the page is fetched again. **Manual**: only when somebody asks. **varies**: the folder holds pages of several kinds; open it to see each one's |

Select a page to open it: its Markdown, rendered as Orbik keeps it (**Raw** shows the text, **Copy**
and **Download** take it elsewhere), and beside it what the crawl recorded — status and
indexability, title, description, headings, canonical, the pages that link to it, its history and
how it was found — with its own crawl frequency and a **Crawl now** for that page alone.

While a crawl is queued or running it is also listed in the **Activity** box at the foot of the
Sources and Agents sidebars (on a phone, the one line under them), named by its workspace and, for
a source other than the website, the source.

## How OrbikBot treats your server

The crawler identifies itself as **OrbikBot** and obeys robots.txt for the token `orbikbot` (and
`*`). It makes at most four requests a second to your host. A `Crawl-delay` in robots.txt slows it
down further, and a `429` or `503` stops it asking for as long as the `Retry-After` header says, or
thirty seconds without one, up to an hour. Ten refusals in a row end the crawl, and the pages left
are tried by the next one. It never fetches loopback or private network addresses.

[OrbikBot](../orbikbot.md) is the page site owners land on from their logs. If you crawl sites
that are not yours, point the crawler at a page of your own with `ORBIK_CRAWLER_CONTACT_URL` (see
[Configuration](../self-hosting/configuration.md)).

## Keeping pages up to date

Every page starts on **Manual trigger**: it is fetched once when it is found, and again only when
somebody asks.

- **Set crawl frequencies**, under **How often** on the source's Settings tab, opens the page list
  with checkboxes. Tick pages or whole folders,
  choose **Daily**, **Weekly**, **Monthly** or **Manual trigger**, and press **Apply**. A folder
  means the pages under it today; pages found later start on manual trigger.
- One page's frequency can be changed from its detail panel.
- Orbik visits the site at least once a week, and more often when any page is set more often:
  that is the **Next visit** at the top of the page. Each visit checks the sitemaps, fetches pages
  it has never fetched, and fetches again the pages whose frequency has come round; a page on
  **Manual** is not fetched again on a visit. A page that comes back unchanged changes nothing
  downstream.
- **Crawl now** asks for a crawl straight away. The source shows **Queued** until the scheduler
  starts it, within a minute (**Stop crawl** takes the request back), and it fetches what is due:
  new pages, pages somebody asked for, and pages whose frequency has come round. Pages on Manual are
  not fetched again.
- **Fresh crawl**, on the Settings tab and confirmed in a dialog, fetches every page of the site
  again in full, whatever its frequency. Frequencies are left as they were. Use it when much of the site has changed at
  once.

> [!NOTE]
> The crawl page can show a monthly crawl budget. In this open-source edition every month is
> unlimited; a budget applies only when an extension sets one. Where one does, a month whose
> pages are spent, or a plan that includes no crawl pages at all, disables **Crawl now**, **Fresh
> crawl** and **Start crawling this site** and says why under them; the page promises a date
> crawling resumes only when the next month has pages. A crawl that runs out part-way stops
> fetching, shows **Stopped: out of crawl pages**, and leaves the pages it did not fetch for the
> next crawl.

## When your address redirects to www

Many sites answer on `www.example.com` and only redirect from `example.com`, or the other way
round. At the start of every crawl Orbik asks for the start address and looks at where it lands.
When that is the same name with or without `www.`, the crawl moves there:

- **Start crawling from** becomes the same address on the host that answered, and the crawl
  settings say which name redirects to which. The workspace's website stays as you typed it.
- Pages are found and fetched at their real addresses, without a redirect each. A link or a
  sitemap entry still written with the other name is read as the same page.
- A sitemap you list yourself can be on either name.

Nothing else is treated this way. A start address that redirects to a subdomain or to another
domain is still crawled where you pointed it.

If the site was crawled before the crawl moved, the next crawl fetches its pages again at their
real addresses. The addresses it used before stay listed under **Duplicate URLs**, each folded into
the page it redirects to, until **Clear crawl data**. Crawl frequencies you set are kept. A page
you asked for with **Include** in the Library's [Source ledger](library.md) needs including again.

## A site that will not let the crawler in

Some sites sit behind bot protection that answers a crawler with a refusal or a "prove you are a
browser" page. Orbik recognises the common services (among them Cloudflare, Imperva, DataDome,
Akamai, AWS WAF and Vercel). When the start page is refused, or five pages in a row are
challenges, the crawl stops and fails with `ACCESS_REFUSED`, naming the host, the service and the
status. Nothing from a blocked page is stored, so the Library keeps what was last read.

The fix is on the site's side: allow the user agent `OrbikBot` in that service's bot rules, then
press **Crawl now**. Orbik does not disguise itself or solve challenges to get past one.

## Changing where the crawl starts

**Where it starts**, on the source's Settings tab, changes **Start crawling from**, and **Sitemaps**
under it takes more sitemap addresses. Changes apply to the next crawl, and the schedule is not
reset.

The workspace's own website is changed on **Settings** → **Workspace**, by an admin or the owner:

- **The same site at a new address** (the same hostname) keeps everything crawled. The next crawl
  starts from the new address, unless a start page was chosen for the crawl, which is kept.
  The name the crawl was moved from counts as the same hostname: if `example.com` redirects to
  `www.example.com`, a website typed with either is the same site.
- **A different site** (another hostname) starts over, so Orbik asks first. **Change the website**
  removes every page crawled from the old site and its crawl history, and a crawl of the new site
  starts within a minute. The Library keeps what people and agents wrote, and its copies of the old
  pages are replaced as the new pages are crawled. The brand stays as it is. This cannot be done
  while a crawl is running.

## Clearing crawled data

**Clear crawl data**, on the source's Settings tab and confirmed in a dialog, deletes every crawled
page, its history and the crawl logs. The crawl settings are kept. It cannot be undone, it needs an admin or the owner, and
it is refused while a crawl is running. Press **Crawl now** afterwards to read the site again.

How the crawler works inside — the queue, the pace and the Markdown rules — is in
[architecture/crawler.md](../architecture/crawler.md).
