# OrbikBot

If you found this page from your server's logs: **OrbikBot** is the crawler of
[Orbik](https://github.com/Codalent/orbik), open-source software that copies a website into a
knowledge base its owner's AI can read. Orbik is self-hosted, so the crawler you saw is run by
whoever installed that copy of Orbik and added your site to it — not necessarily by the people who
publish the software. An operator can name their own contact page in the User-Agent; when it
points here, they have not.

It identifies itself as:

```
Mozilla/5.0 (compatible; OrbikBot/1.0; +<contact URL>)
```

## What it does

- It fetches the pages of the site it was given, starting from that site's home page and
  sitemaps.
- It obeys `robots.txt` for the product token `orbikbot` (and `*`), unless the person running it
  explicitly overrides that for a site they say is their own.
- It makes at most four requests a second to one host, slower when your `robots.txt` sets a
  `Crawl-delay`, and stops asking for as long as a `429` or `503` response tells it to.
- It does not fetch loopback or private network addresses.
- For the design system, it may load a handful of pages in a headless browser and download images
  and stylesheets those pages use.

## Blocking it

Add this to your site's `robots.txt`:

```
User-agent: orbikbot
Disallow: /
```

The next crawl reads it and fetches nothing else from your site.

## Running it yourself

Set `ORBIK_CRAWLER_CONTACT_URL` in the agents' environment (`agents/.env`, or `.env` beside
`compose.yaml` for the Docker install) to a page that says who you are and how to reach you.
