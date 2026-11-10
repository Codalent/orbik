# Crawling your site

Orbik reads your website page by page and keeps a Markdown copy of each one. Everything else — the
Library, search, Ask, llms.txt and the brand — works from what the crawl keeps.

## Start the first crawl

1. Create a workspace: give it a **Workspace name**, then the **Website URL** it is about, and
   press **Create workspace**.
2. On **Home**, the first step is **Connect your website**. **Start first crawl** opens the
   **Crawler** page, which is also listed under **Agents** in the workspace's rail.
3. **Start crawling from** is filled in with the workspace's website. Change it if the crawl should
   begin somewhere else on the same site. Orbik finds sitemaps through robots.txt and the usual
   locations; only if yours live somewhere unusual, open **Add sitemap URLs** and list them, one
   per line.
4. Press **Start crawling this site**. The crawl is queued, starts within a minute, and the page
   follows it without a reload.

Setting up and starting crawls needs the member role or above. A read-only member sees the
crawl's results but not the controls.

## What a crawl does

- It reads robots.txt and your sitemaps, then follows links outward from the start address. A page
  nothing links to is still found if a sitemap lists it; a page that is in no sitemap and linked
  from nowhere cannot be found.
- It crawls the start address's hostname only. A subdomain is a different site: give it a
  workspace of its own.
- It turns every page that answers successfully into content-only Markdown, leaving out the
  navigation, the page's header and footer, cookie banners and forms. No AI model is involved in
  crawling.
- When it finishes, it hands the site to the Library, which copies every page into its Sources
  folder and indexes them for search (see [The Library](library.md)).

## The Crawler page

Along the top are the crawl's state and its controls: **Crawl now**, **Fresh crawl**, **Set crawl
frequencies**, **Crawl logs** (every run, how it was started and how it ended), the settings gear
and **Clear crawl data**.

While a crawl runs, the page shows its progress as pages fetched "of about N". N grows as the
crawl finds new pages through links, which is why it is a count rather than a percentage. A live
log underneath lists what each page answered.

The figures under it describe the site as the last crawl left it:

| Figure | Means |
|---|---|
| **Pages** | Distinct pages, with duplicate URLs folded into one |
| **Crawled** | Pages fetched by the last crawl |
| **Duplicate URLs** | Addresses that lead to a page already counted |
| **Broken** | Pages that answered with an error |
| **Nothing links here** | Pages reached through the sitemap alone |

Below them is every page as a tree of paths, with each page's crawl frequency. Select a page to
see what was read from it — status, title, description, headings, canonical — its **Markdown**,
its own crawl frequency and a **Crawl now** for that page alone.

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

- **Set crawl frequencies** opens the page list with checkboxes. Tick pages or whole folders,
  choose **Daily**, **Weekly**, **Monthly** or **Manual trigger**, and press **Apply**. A folder
  means the pages under it today; pages found later start on manual trigger.
- One page's frequency can be changed from its detail panel.
- Orbik visits the site at least once a week, and more often when any page is set more often. Each
  visit checks the sitemaps, fetches pages it has never fetched, and fetches again the pages whose
  frequency has come round. A page that comes back unchanged changes nothing downstream.
- **Crawl now** asks for a crawl straight away. It shows **Queued** until the scheduler starts it,
  within a minute, and fetches what is due: new pages, pages somebody asked for, and pages whose
  frequency has come round.
- **Fresh crawl**, pressed twice to confirm, fetches every page of the site again in full, whatever
  its frequency. Frequencies are left as they were. Use it when much of the site has changed at
  once.

> [!NOTE]
> The Crawler page can show a monthly crawl budget. In this open-source edition every month is
> unlimited; a budget applies only when an extension sets one.

## A site that will not let the crawler in

Some sites sit behind bot protection that answers a crawler with a refusal or a "prove you are a
browser" page. Orbik recognises the common services (among them Cloudflare, Imperva, DataDome,
Akamai, AWS WAF and Vercel). When the start page is refused, or five pages in a row are
challenges, the crawl stops and fails with `ACCESS_REFUSED`, naming the host, the service and the
status. Nothing from a blocked page is stored, so the Library keeps what was last read.

The fix is on the site's side: allow the user agent `OrbikBot` in that service's bot rules, then
press **Crawl now**. Orbik does not disguise itself or solve challenges to get past one.

## Changing where the crawl starts

**Crawl settings** (the gear on the Crawler page) changes **Start crawling from** and the sitemap
addresses. Changes apply to the next crawl, and the schedule is not reset.

The workspace's own website is changed on **Settings** → **Workspace**, by an admin or the owner:

- **The same site at a new address** (the same hostname) keeps everything crawled. The next crawl
  starts from the new address, unless a start page was chosen on the Crawler page, which is kept.
- **A different site** (another hostname) starts over, so Orbik asks first. **Change the website**
  removes every page crawled from the old site and its crawl history, and a crawl of the new site
  starts within a minute. The Library keeps what people and agents wrote, and its copies of the old
  pages are replaced as the new pages are crawled. The brand stays as it is. This cannot be done
  while a crawl is running.

## Clearing crawled data

**Clear crawl data**, pressed twice to confirm, deletes every crawled page, its history and the
crawl logs. The crawl settings are kept. It cannot be undone, it needs an admin or the owner, and
it is refused while a crawl is running. Press **Crawl now** afterwards to read the site again.

How the crawler works inside — the queue, the pace and the Markdown rules — is in
[architecture/crawler.md](../architecture/crawler.md).
