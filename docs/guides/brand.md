# Brand

Orbik reads how your company looks from your own website — colours, type, spacing, components,
logos and imagery — and keeps it as a design system you can correct and your AI can read.

Open **Brand** in a workspace's left-hand rail. The page shows the system section by section
(**Colours**, **Typography**, **Logos and marks**, **Graphics language**, **Components**,
**Spacing and shape**, **Rules**), with the screenshots it was read from and what could not be
determined.

## How it is derived

The **Design system** agent renders up to eight pages of your crawled site in a real browser, at
desktop and phone widths. It measures what the pages actually paint, collects your logos and
images, and proposes a system from what it measured. A first derivation takes a few minutes.

It needs a crawl to choose pages from, so crawl the site first (see [Crawling](crawling.md)). If
there is no crawl yet, you can build the brand from your own files instead (see below).

Every value carries a label saying where it came from:

| Label | Means |
| --- | --- |
| **Observed** | Seen on your site as it is. |
| **Derived** | Normalised from several values seen on your site. |
| **Proposed** | Suggested to fill a gap your site leaves. |
| **Pinned** | Set by you. The agent leaves it alone. |

**Which pages.** By default the agent chooses: your home page, then the most linked-to page of each
main kind of page on the site. Legal, login and cart pages are passed over. To choose yourself,
open **Agent settings** from the Brand page and use **Edit pages**: up to eight, and pages that
look different from each other teach it more. Clearing your list hands the choice back.

**Keeping it current.** Once the agent is set to work it checks the site weekly. It first compares
the site's styling with what the system was derived from, and when nothing changed it stops within
seconds without opening a browser. **Re-derive** renders the pages again whether or not the styling
changed. Your pinned values are kept either way.

**History** lists the earlier versions of the system; **Restore** puts one back as a new version.

## Correcting it

Anything you know better than the site shows, you pin:

- Use the pencil beside a value, change it and choose **Pin**. A pinned value survives every later
  derivation. **Unpin** goes back to what the agent proposed.
- **Observed palette**, under **Colours**, lists every colour the site paints with its share of the
  page; **Use as** pins one to a role.
- On an image, **Reference** marks it as an example of your style for image models, and **Hide**
  sets it aside as not your brand's own. A logo can be **Set aside** and used again later.

Images the agent judged not to be yours — other companies' logos, people's photos — are set aside
already; you can show them again.

## Your own files and the brand chat

The website is not the only source. Drop files on a section of the page, or in the **Ask** panel,
which opens docked beside the Brand page on a wide enough screen (**⌘J**, or **Ctrl+J**):

- logos and images,
- a brand guide as a PDF,
- font files,
- design tokens (JSON or CSS).

Each file can be up to 20 MB, and a workspace keeps up to 40 uploaded files. Dropping a file on a
section tells Orbik what it is for: a file dropped on **Logos and marks** is a logo.

On the Brand page, Ask is the brand chat. It decides what each file means and changes the brand as
you:

- **A logo** that is the same mark as your current one replaces it, and the website's copy is set
  aside; a different mark is added beside it.
- **A brand guide** is treated as the company's authority. What it settles is applied at once, each
  value marked with the file and page it came from. What it left out is listed with the reason,
  and with **Add it** where it is a value that could be set.
- **A font** sets the family for its role.
- **A token file** sets the values whose names say what they are.
- **Images** are captioned, and may be marked as references.

You can also say in words what is off — "the primary colour is darker than that", "headings are
never in capitals" — and it changes the brand. It asks first before removing anything or replacing
a value you set yourself.

Every change is recorded. The chat shows each one as a before-and-after card with **Undo**, which
puts back what was there. An undo is refused while a later change to the same value still stands.
Changes you make on the page are recorded the same way.

You don't need a crawl to start: a brand can be built from your files alone.

> [!NOTE]
> Uploaded fonts stay private. The page draws them for you, but they are never handed to an AI or
> served over MCP, because font licences rarely allow passing the file on. Your AI is told the
> family's name instead.

An uploaded file can be set aside, but not yet deleted from the page.

People with the **Read-only** role can ask the chat about the brand; it answers but changes
nothing. Changing the brand needs the **Member** role or above (see
[Workspaces and members](workspaces-and-members.md)).

## Using it

**Use it**, at the foot of the page, gives the whole system in the form you need, with your pinned
values already in it. Copy or download:

- **Design tokens (DTCG)** — for a token pipeline or a design tool's importer,
- **CSS variables** — custom properties, with the components as classes,
- **Tailwind theme** — a Tailwind 4 `@theme` block,
- **DESIGN.md** — the whole system as one Markdown file for a coding agent's context,
- **Image prompt** — the style of your imagery, to put before your subject in an image model.

Your AI reads the same system over MCP (see [Connect your AI](../connect-your-ai/README.md)).
`brand_get` returns it in one call: colours, type, spacing, shape, component recipes, rules, the
image style, the logo and a few reference images. `brand_tokens`, `brand_render`, `brand_assets`
and `brand_asset` return the tokens, a format above, the images and one image (see the
[tool reference](../connect-your-ai/tools.md)).

Images are handed out as signed links that need no credential and stop working after an hour.
Anything set aside is never listed or served. A workspace with no system yet answers that no design
system has been derived, rather than an empty brand.

## Running it

What the operator of an install needs for the Brand page:

- **Google Chrome on the agents worker's machine.** The agent starts Chrome to render pages; without
  it a run fails with `CHROME_UNAVAILABLE`. The Docker install's `agents` image includes Chromium.
  On a Linux server without Docker, also install fallback fonts (`fonts-liberation`, `fonts-noto`,
  `fonts-noto-color-emoji`), or text drawn in a site's fallback fonts is measured wrongly. Allow
  300–600 MB of memory while the browser is open.
- **`ORBIK_ANTHROPIC_API_KEY`** for the proposal. Without it a run still renders the pages and
  stores what it observed, with your logos and images, and records that the proposal was skipped.
  The brand chat needs it too.
- **`ORBIK_ASSET_URL_SECRET`** to sign image links. The Docker install generates one on first
  start. Without Docker, set it in `backend/.env` (`openssl rand -base64 48`). Without it every
  other MCP tool still answers, and the brand tools say `ASSET_LINKS_NOT_CONFIGURED` where a link
  would be.
- **Room for uploads.** A proxy of your own in front of Orbik must allow request bodies of 20 MB on
  `/v1/workspaces/*/brand/uploads`, or uploads fail with 413.

A site that refuses browsers on every page ends the run with `SITE_BLOCKED`.

How the agent works in detail: [The design system](../architecture/design-system.md).
