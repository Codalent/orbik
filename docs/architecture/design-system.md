# The design system

An agent that renders a workspace's site in a real browser, writes down the design it has, and
proposes a design system from it — colours by role, type, spacing, shape, components, logos and
the style of its imagery. A person corrects it on the **Brand** page; any AI they connect reads the
result over MCP.

It is the visual half of what Orbik knows about a company. The Library says what the company
*says*; this says how it *looks*, and it is the one part of that knowledge where the website is
the ground truth rather than a claim to be reported.

```mermaid
flowchart LR
  S[agent_setups.pages, or the crawl] --> F[1 · Fingerprint: plain requests]
  F -->|unchanged| X[STYLE_UNCHANGED: stop]
  F -->|changed, or forced| R[2 · Render: Chrome via chrome-launcher + puppeteer-core]
  R --> O[(design_observations)]
  R --> A[(brand_assets + GridFS)]
  O & A --> M[3 · Propose: two structured model calls, with images]
  M --> D[(design_systems: proposal + pins = system)]
  P[A person pins a value] --> D
  D & A --> API[/v1/workspaces/:id/brand/*]
  D & A --> MCP[brand_get · brand_tokens · brand_render · brand_assets · brand_asset]
```

Two layers, kept apart on purpose. The **observed** layer is measurement: what Chrome painted,
counted by code and never edited. The **proposed** layer is judgement: which of fourteen observed
greys is the border colour. Every proposed value says which it is, and the labels are checked
rather than believed.

## What a run does

The definition (`packages/agent-definitions/src/designSystem.js`, **v3**) declares
`runtimeRequirements: ["design-system"]`, so the worker executes it with the plain-code runtime in
`agents/src/ai/designSystem/runtime.js` rather than with a tool-looping model. A run is dispatched,
leased, retried, logged and recorded like any other. v1 observed and stored; v2 added the proposal
and a guide in the Library; v3 stopped writing the guide (see below).

### 1. Is there anything to do?

A design system changes when a site is redesigned, a few times a year; the schedule is weekly. So a
run begins with a **style fingerprint** (`fingerprint.js`): two or three plain requests, a hash,
and — when the hash is the one the stored system was derived at — nothing else. The run ends as
`state: "unchanged"`, `skipped: "STYLE_UNCHANGED"`, in about two seconds, with no browser and no
model call.

What is hashed is chosen so content can change and the fingerprint does not:

- the *contents* of the home page's same-origin stylesheets, never their addresses — a build
  renames `app.3f9c.css` on every deploy without changing a rule in it;
- the home page's inline `<style>` blocks;
- the home page's skeleton: its tags and class names in order, with every word of text left out;
- the pages the run would render, and `EXTRACTOR_VERSION`, so choosing different pages or shipping
  a new extractor both cause a fresh derivation.

`{"force": true}` as the run's input skips the question. **Re-derive** on the Brand page sends it.
A fingerprint is remembered only for a *complete* derivation, so one whose model call failed is
tried again next time rather than mistaken for done.

### 2. Choosing and rendering pages

`pages.js` chooses up to eight (`BRAND_LIMITS.pages`). A person's own list on the agent's setup
wins when there is one — **Edit pages** opens a picker of the crawled routes and their pages
(`PagePicker.jsx`) with a limit of eight, and an empty list hands the choice back. Otherwise the choice is the crawl's: the home page, then the most
linked-to page of each of the most linked-to route patterns, then, while slots remain, the most
linked-to page of each section (first path segment, at its depth) not yet represented. Only pages
the crawler rendered to Markdown are candidates, a duplicate under another URL never is, and
privacy, terms, login and cart pages are passed over: they are linked from every footer and show
none of the components a system is read from.

Each page is rendered in one headless Chrome (`browser.js`) at **1440×900** and **390×844**, one at
a time. `chrome-launcher` finds and starts the installed Chrome, and `puppeteer-core` — which ships no browser — attaches to it. A page is settled before it is
read: loaded, network quiet, web fonts in, scrolled to its foot and back so lazy content has
loaded.

**A page is somebody else's program.** The site's address is checked before navigation and every
request the page then makes is intercepted: one that resolves to a non-public address is refused
(`classifyAddress` in `@orbik/core`, the rule the crawler's fetcher uses). The check resolves a
name and Chrome connects separately, so a DNS answer that changes between the two can slip through
— the same known gap the fetcher documents, with the same answer: keep the worker off internal
networks.

A page that answers a browser with a refusal — a 401, 403, 429 or 503, or a challenge screen — is
recorded as `blocked` and the run carries on. A run in which every page was refused fails with
`SITE_BLOCKED`; one in which nothing rendered for another reason, `DESIGN_RENDER_FAILED`.

### 3. What is sampled

`inPage.js` holds the functions that run inside the page. They read computed styles and painted
rectangles, never stylesheet text. One walk of the tree, carrying the background each element sits
on, so a translucent overlay is recorded as the colour it produces and a child repeating its
parent's background paints nothing new. Consent banners (the crawler's own selectors, exported from
`crawler/markdown.js`), chat widgets and other origins' frames are left out.

| Group | What is recorded |
| --- | --- |
| Document | title, language, theme colour, declared icons, the manifest, `og:image`, JSON-LD `Organization.logo` |
| Custom properties | every `--*` on `:root`, `html` and `body` in readable stylesheets, with its computed value and a guessed kind |
| Fonts | what loaded, where each file came from, and — through CDP's `CSS.getPlatformFontsForNode` — which font actually drew the text |
| Colours | every visible colour, weighted by painted area or by text, tagged with the roles it was seen in. Resolved by painting one pixel on a canvas, so `oklch()` and `color-mix()` need no parsing |
| Typography | per kind of text (`h1`–`h6`, paragraphs, links, buttons, inputs…): family, size, weight, line height, tracking, transform, colour |
| Spacing | container widths, section padding, gutters, gaps, margins — reduced to a base unit only when most of them divide by it |
| Shape | radii by kind of element, border widths, shadows with their transparent layers removed |
| Components | buttons (filled, outlined or text, with a forced `:hover` reading), inputs, cards, the navigation bar, the footer, the hero |
| Logos | images and vectors in the header's link home, or a wordmark set in type, which is cut out of the page; the app icon |
| Imagery | every image and inline vector of 24 px or more. Other companies' marks and people's faces are marked as not the brand's |

`reduce.js` merges every page's sample into one record. Colours closer than a just-noticeable
difference (distance under 2 in OKLab, `@orbik/design-system`) are counted as one, centred on the
one the site paints most, so no reported colour is an average nobody wrote. A build tool's renamed
font (`__Inter_e798ec`) is given its name back and kept beside the name the page uses.

Stored in `design_observations`, one document per run, the last five kept. About 45 KB of JSON for
seven pages.

### 4. Assets

Nothing else in Orbik stores a file. `@orbik/assets` (`packages/assets/src/`) is the store: bytes
in MongoDB GridFS (bucket `brand_assets_files`), a metadata row in `brand_assets`, unique on
`(workspaceId, hash)` so a run that finds the same image again refreshes the row. An object store
behind the same five verbs is a second file, when a deployment needs one.

`harvest.js` collects, per run: up to 8 logos, the 12 largest images, 24 icons and inline vectors,
beside the screenshots, up to ten cut-out components, and three sheets Orbik draws itself — a
**type specimen** and a **swatch sheet** drawn on the site's own page, in its own fonts, and a
numbered **contact sheet** of the imagery. Chrome does the image work: decoding and resizing to
1,600 px happen on a blank tab, so no image library is added to the worker. Vectors are kept as
sanitised source. **Fonts are named and never stored**; the specimen is how they look.

A workspace holds 60 assets and 40 MB. When a run finishes, whatever only a superseded run saw is
removed, and then the least useful of its own if it stored too many — other pages' screenshots
first. Nothing a person pinned or marked as a reference is ever removed.

### 5. The proposal

Two calls through `createStructuredWriter` (`agents/src/ai/model/structured.js`), the sibling of
the short-text writer: one question, a JSON schema for its answer, optional images, a ceiling and
a timeout, and it never throws. Both are routed by the definition's `reasoning` capability and
written to `ai_calls`.

| Call | Shown | Answers |
| --- | --- | --- |
| Visual system | the compacted record, three desktop screenshots, the specimen | colours by role, families and a scale, spacing, shape, component recipes, personality, rules, what it could not determine |
| Graphics language | the contact sheet, the home page, the system's colours | the medium and how imagery is drawn, a caption and verdict for every image, a logo description, an image prompt and three to five reference images |

The schemas and their parsers are in `packages/protocol/src/designSystem.js`. Three things are done
to an answer before it is stored:

- **It is parsed into one shape.** Optional parts that do not hold up become null and are listed.
- **Its provenance labels are audited** (`auditProvenance`). A colour called `observed` that is
  not within a just-noticeable difference of an observed colour is relabelled `derived` or
  `proposed`; a size, a family, a radius, a shadow likewise. A label is only ever moved down.
- **Images that are not the brand's own are hidden.** The technology logos, the social marks and
  the testimonial headshot on the development site were all set aside by the second call's
  verdicts. A flag a person set is left as they set it.

Measured on the development site: about 260 seconds for a full derivation — 90 of Chrome, 170 of
two model calls — and $0.15 at list price.

## Pins

`design_systems` holds one document per workspace with three things in it: the **proposal** (what
the agent said), the **pins** (what a person set), and the **system** — the pins laid over the
proposal, recomputed whenever either moves. `@orbik/design-system` (`pins.js`, `store.js`) is the
one implementation, used by the worker and the API alike.

A pin is addressed by a JSON pointer — `/colors/primary/value`, `/typography/scale/h2/px` — which
is why the system is keyed by role and by token rather than by position. Only the places listed in
`pins.js` can be pinned and each has its own check. On the resulting system a pinned value has
`source: "pinned"`; the proposal still holds what the agent said, so unpinning gives it straight
back. Contrast ratios are worked out after the pins are applied.

An image has its own pins: `isReference`, `hidden`, `kind` and `caption` on its `brand_assets` row,
with `pinnedFields` naming the ones a person set.

The last ten systems are kept in `design_system_revisions`. Restoring writes forward.

## Uploads and the brand chat

The website is not the only source. A person drops their own files on the Brand page — a sharp
logo, the agency's brand guide, a font, a design-token file, reference images — and tells the chat
beside the page what is off. Designed in `.devbar/` item 035, with the owner's decisions there.

**The chat is Ask.** On the Brand page the Ask panel opens docked beside the page (from 1024 px
wide) and takes files; a message sent from there goes to the `brand-chat` agent
(`packages/agent-definitions/src/brandChat.js`) instead of `library-chat`, and `brand-chat-read`
for a read-only person (`conversationService`, by `context.page`/`route`, or any attachment). It
writes as the person, like Ask. Dropping files on a section of the page (Logos, Colour, Typography,
Imagery) uploads them and sends them at once, with the section as `context.section`; the panel's
paperclip attaches them to the next message instead.

**What happens to a file** is the agent's decision, from what it sees (`brand.viewFile` hands the
model the image or the PDF itself, through the runtime's `inline` convention):

- *A logo* that is the same mark as the primary becomes the primary, and the website's copy is set
  aside (`hidden`); a different mark is added beside it. It asks about the other tone.
- *A brand guide* is the company's authority (owner, 2026-11-04): what it settles is applied at
  once, each value tagged with the guide and page; what it left out is listed with why, and with
  **Add it** when it is a value that could be set. Tone-of-voice pages are offered to the Library.
- *A font* sets the family on its role. It is stored privately and drawn in a sandboxed iframe
  (`FontSpecimen.jsx`: the page fetches the bytes with the session and posts them to an
  `<iframe sandbox="allow-scripts" srcdoc>` that loads them with `FontFace`). It is never listed
  or served over MCP, and a signed link to it is refused: font licences rarely allow passing the
  file on. The AI is given the family's name.
- *Token files* are read and the values with plain names set; *images* are captioned and may be
  marked as references.

It asks first only before removing something or replacing a value the person set themselves.

**Every change is recorded** in `brand_changes` (`createBrandChangeLog` in
`packages/design-system/src/changes.js`): where, the value and the pin before and after, how
(`via`: `page`, `chat`, or `upload` with the file and page), who, and the chat turn's run. A pin
carries the same `via`, which is what the page's source tags read ("guide.pdf p. 6", "From you").
The chat shows a turn's changes as before → after cards with **Undo**; an undo puts back the pin
that was there, or the website's value, and is refused (`CHANGED_SINCE`) while a later change to
the same place stands. A change on the page goes through the same log.

**Uploads** are `brand_assets` rows with `origin: "upload"`, `uploadedBy`, `fileName`, and what was
read from the file at upload (`backend/src/services/brandUploads.js`): an image's size, a font's
family, style and weight (`fontkit`), a guide's page count and text page by page (`unpdf`, kept on
the row, out of every listing), a token file's format and count. The type is read from the bytes,
never the name; an SVG is cleaned by `sanitiseSvg` (now in `@orbik/assets`, shared with the
worker). Uploads are never pruned by a derivation and have their own limits
(`BRAND_UPLOAD_LIMITS`: 40 files, 20 MB each, 200 MB together). Anything that is not a guide,
font or token file is served inline as an image; the others are downloads.

**No crawl needed.** A pin on a workspace with nothing derived starts an empty proposal
(`ensureSystem`, `startedFromUploads`), so a brand can be built from a person's files alone.

## No guide in the Library

Up to v2 the system was also written into the Library as a document, `/brand/design-system`,
rewritten by every derivation and every pin so `library_read` and the retrieval index reached it.
It was a third place saying what the Brand page and `brand_get` already say, so v3 removed it: a
run ends once the system is stored, and a pin changes the system and nothing else. The worker
deleted the guides already written at its first start after the change, as the Design system
agent and with a revision of each kept, after taking out the line each Library's index gave them
(`agents/src/library/retireBrandGuides.js`).

`/brand` stays a reserved Library folder: the store still refuses every other agent a write
inside it and refuses to move or delete it, and no chosen top-level folder may take its name.
Nothing writes there.

## The Brand page

`/workspaces/:id/brand`, listed under **Knowledge** and beside the agents; the agent route renders
the same page. Components are under `frontend/src/components/brand/`.

- `BrandAgentStrip.jsx` — the page's head (`PageHeader`), with the agent's state as a pill. Idle,
  its meta line says when it was derived, from how many pages, when it is checked next. Working: a
  rail of four stages (Rendering 3/7 · Sampling · Synthesising · Storing). **Re-derive**,
  **Edit pages**, **History**, and Set to work / Pause.
- `BrandOverview.jsx` — the mark on light and on dark with the personality sentence; what changed
  since the derivation before; rules; screenshots; what was not determined.
- `ColourSection.jsx` — a card per role with its source, usage and WCAG contrast, and the
  **Observed palette** drawer: every clustered colour with its share, where it was seen, and
  "use as a role", which pins it there.
- `TypographySection.jsx` — families, the scale as a table of editable cells, and the specimen.
- `LogoSection.jsx`, `GraphicsSection.jsx` — the marks; the graphics language, the image prompt
  with Copy, and every image with **Reference** and **Hide**.
- `ComponentsSection.jsx` and `BrandSample.jsx` — the site's own cut-out components beside a sample
  drawn live from the tokens.
- `SpacingShapeSection.jsx`, `UseItSection.jsx` — the tabs for each export, read from the API.
- `PinField.jsx` — the one way a value is corrected, wherever on the page it is.

## API

All under `/v1/workspaces/:workspaceId/brand`, owner-scoped. Writes require the session's CSRF token.

```
GET    /brand                         the system, its proposal and pins, the images, the pages
PUT    /brand/pins                    {"pointer": "/colors/primary/value", "value": "#c2410c", "source"?: {"assetId", "page"}}
DELETE /brand/pins                    {"pointer": "/colors/primary/value"}
GET    /brand/render?format=          dtcg | css | tailwind | design-md | image-prompt, as text
GET    /brand/revisions               the kept versions
POST   /brand/revisions/:n/restore    put one back, as a new version
GET    /brand/observations/latest     the observed record, for the drawer
GET    /brand/assets?kind=            the stored images
GET    /brand/assets/:assetId         one image, streamed
PUT    /brand/assets/:assetId         {"isReference": true} · {"hidden": true} · kind · caption · tone
POST   /brand/uploads?name=&for=      the file as the body, raw: a logo, image, PDF guide, font or token file
POST   /brand/changes/:changeId/undo  put back what one change replaced

GET    /v1/brand-assets/:assetId?exp=&sig=    one image by signed link, with no session
```

An asset's flags are changed with `PUT` rather than `PATCH`: the browser policy in
`middleware/security.js` admits no `PATCH`. Setup, pages and the schedule are the routes every
agent shares (`/agents/design-system/setup`, `/working`), and a derivation is a `POST /runs`.

Every asset is sent under `Content-Security-Policy: default-src 'none'; … sandbox` with
`nosniff`, because a stored SVG came from somebody's website. `Cross-Origin-Resource-Policy` is
relaxed to `cross-origin` on the asset routes only.

**Signed links.** An outside AI has no session, and an image model can only be handed a URL. A link
carries the asset, when it ends, and an HMAC-SHA256 over both and the workspace the asset belongs
to, made with `ORBIK_ASSET_URL_SECRET`. The workspace is read from the asset's own row when a link
is checked, so a link cannot be edited to reach another asset. Links last an hour; rotating the
secret ends all of them. Every way a link can be wrong gets the same `404 ASSET_LINK_INVALID`.

## Over MCP

Five registry tools (`packages/tools/src/brand.js`), added to `MCP_READ_TOOLS`:

| Tool | Returns |
| --- | --- |
| `brand_get` | the corrected system in one call: colours, type, spacing, shape, component recipes with their tokens resolved, rules, the graphics summary and image prompt, the logo and three reference images as signed links, and a line naming the Library's overview (found by its role, wherever the person's structure keeps it) for voice and tone |
| `brand_tokens` | the system as DTCG design tokens |
| `brand_render({format})` | `css` · `tailwind` · `design-md` · `image-prompt` · `dtcg`, as text |
| `brand_assets({kind?})` | the stored images with captions and signed links |
| `brand_asset({id})` | one image **inline**: MCP image content for a raster up to 1 MB, the source as text for an SVG |

and three resources: `orbik://brand` (DESIGN.md), `orbik://brand/tokens.json`,
`orbik://brand/assets/{id}` (a blob). The server's instructions tell a client to call `brand_get`
before producing anything that has to look like the company.

A credential that reads several workspaces ("roaming", [library.md](library.md) § "One
credential, a set of workspaces") passes `workspace` to each brand tool, and reads the resources
under a workspace instead: `orbik://w/{workspaceId}/brand`, `orbik://w/{workspaceId}/brand/tokens.json`
and `orbik://w/{workspaceId}/brand/assets/{id}`. The un-prefixed `orbik://brand/assets/{id}` still
works for it: an asset id names its own
workspace, so the image's row is read for its owner and the image is served only if that workspace
is in the credential's set, and answered like a missing image otherwise. `orbik://brand` and
`orbik://brand/tokens.json` without a workspace are not registered for a roaming credential.

An image set aside as not the brand's own is never listed and never served. A workspace with no
system answers `BRAND_NOT_DERIVED` — a refusal, not `{}`, which a model would read as "this brand
has no colours". An API without `ORBIK_ASSET_URL_SECRET` serves everything else and says
`ASSET_LINKS_NOT_CONFIGURED` where a link would be.

## Storage

| Collection | Shape |
| --- | --- |
| `design_observations` | one per run: the pages, the observed record, the assets it stored. Last 5 per workspace |
| `design_systems` | one per workspace: proposal, pins, system, synthesis outcome, style fingerprint, what changed |
| `design_system_revisions` | the last 10 systems per workspace |
| `brand_assets` | one per stored image: kind, hash, size, where it was found, caption, the flags a person set |
| `brand_assets_files.files` / `.chunks` | GridFS: the bytes, keyed by the asset's identifier |

Indexes are in `agents/src/db/indexes.js`.

## Operating

```sh
# backend/.env — the secret signed asset links are made with
ORBIK_ASSET_URL_SECRET=$(openssl rand -base64 48)
```

**Chrome on the worker.** The agent needs Google Chrome installed on the machine running the
agents worker; without it a run fails with `CHROME_UNAVAILABLE`. On a hosted Linux
worker it also needs **fallback fonts** (`fonts-liberation`, `fonts-noto`,
`fonts-noto-color-emoji`): a site's fallbacks for Arial or `system-ui` render as whatever the
machine has, and a bare host has nothing, which would corrupt the specimen and the font detection.
Allow 300–600 MB of memory for the browser.

**No model.** A worker without the reasoning provider's key (`ORBIK_AI_PROVIDER`; see
[ai-execution.md](ai-execution.md)) still renders, observes and stores the
assets; the run ends as `state: "observed"` with the proposal skipped (`PROVIDER_NOT_CONFIGURED`),
and a system already stored is left exactly as it was.

The upload route is the one session route whose body is not JSON (`BRAND_UPLOAD_PATH` in
`middleware/security.js`); it keeps the session, the CSRF header and the browser policy. Behind
nginx, `client_max_body_size` must allow 20 MB on `/v1/workspaces/*/brand/uploads`, or an upload
fails with 413.

## What is not finished

- **Whether the output works** is a person's check: paste `brand_get` or the DESIGN.md into a
  coding assistant, and the image prompt with its references into an image model, and judge.
  Nothing in the agent does it.
- **Dark mode.** One colour scheme is rendered: whichever the site serves by default.
- **Removing an upload.** An uploaded file can be set aside but not deleted from the page.
- **Pictures inside a PDF.** A guide's logos cannot be taken out of it; the chat asks for the files.
- **The worker's type specimen** is still drawn with the site's own fonts, not an uploaded file;
  the Brand page draws the uploaded one in its frame.
- **An on-brand check** of something an AI produced against the system.
- **Proposed values drift.** A colour the site gives no evidence for is proposed afresh on each
  derivation and can come back a shade different. Pin one to keep it.
- **`brand_get` is about 17,000 characters** on the development workspace, some 4,300 tokens,
  not the two to three thousand first planned: the usage sentences and the signed links account
  for the difference.
- **Mobile is sampled lightly**: the type sizes and the navigation bar, and screenshots of the
  first three pages. Colours, components and imagery are the desktop page's.
- **One site per workspace**, as everywhere else.
