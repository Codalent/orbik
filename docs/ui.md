# UI building blocks

How a page inside the Orbik web app is put together, so every page looks like the same product.
Read this before building or restyling a page. The pieces live in `frontend/src/components/ui/`.

## Colour and what it means

Use the `orb-*` tokens (`frontend/src/app/globals.css`), never raw colours and not the shadcn
`text-muted-foreground` family on new work. Light mode follows automatically.

| Token | Use |
|---|---|
| `orb-white` | Strongest text: names, values, headings |
| `orb-gray` | Body text and descriptions |
| `orb-muted` | Labels, timestamps, hints |
| `orb-line` | Borders and dividers |
| `orb-raised` | Panel fill (at `/40`), hover (`/70`), selected nav item |
| `orb-space` | Insets inside a panel: code, URLs, lists (`/50`–`/80`) |

The accents carry fixed meanings. Do not use one for decoration where it could be read as a state.

| Tone | Means |
|---|---|
| lime | Done, healthy, or moving (pulsing). The one primary action on a page. |
| cyan | Information, links in prose, admins |
| orange | Wants a look: a choice waiting, an invite pending |
| coral | Failed, destructive, needs reconnecting |

## Type

`text-title` for a page's h1, `text-base font-semibold` for a section's h2, `text-sm` for body,
`text-compact` (13px) for dense rows and status lines, `text-xs` for meta, `text-2xs` (11px) for
pills and counts. Big figures are `font-display text-[2rem] font-bold tabular-nums` (see
`StatTile`). Do not write other `text-[…rem]` sizes.

## Pieces

| Piece | File | Use |
|---|---|---|
| `PageHeader` | `ui/page-header.jsx` | Every page's head: icon tile, h1, one-line description, status pills, a meta line, actions |
| `SectionHeading` | `ui/page-header.jsx` | An h2 above a panel or list, with a quiet figure and an action |
| `Panel`, `PanelTitle` | `ui/panel.jsx` | Every bordered box. `Card` from `ui/card.jsx` is drawn the same and may stay where it is |
| `RowList` | `ui/panel.jsx` | A divided list inside a panel; each row an `<li>` with `px-3 py-2.5 sm:px-4` |
| `EmptyState` | `ui/panel.jsx` | What will appear here, and when, in a dashed box |
| `StatTile` | `ui/stat-tile.jsx` | A headline figure, in a grid of two to four (`grid-cols-2 lg:grid-cols-4 gap-3`) |
| `Pill`, `StatusDot` | `ui/pill.jsx` | Short states and kinds; tones as above |
| `Avatar` | `ui/avatar.jsx` | A person's initial |
| `CopyButton` | `brand/CopyButton.jsx` | Anything a person pastes elsewhere: tokens, URLs, IDs, proposed text |
| `Dialog`, `useConfirm` | `ui/dialog.jsx`, `ui/confirm-dialog.jsx` | Dialogs; `useConfirm()` asks a yes/no question and answers with a promise. Never `window.confirm` |
| `Select` | `ui/select.jsx` | Dropdowns. Never a native `<select>` |
| `Skeleton`, `SkeletonRegion` | `ui/skeleton.jsx` | Loading placeholders shaped like the content, rather than a spinner where the layout is known; wrap them in `SkeletonRegion` for the "Loading…" a screen reader hears |

## Layout

- A page sits in `PageFrame` (`workspaces/PageFrame.jsx`): a gutter and a width ceiling. Pages
  with a two-column body use `max-w-6xl`.
- Head, then headline figures, then the body. Sections are `space-y-4` inside, pages `space-y-6`
  to `space-y-12` between sections.
- Icon tiles: `size-9` (sections) or `size-11` (page head), `rounded-lg`/`rounded-xl`, bordered,
  the icon in lime or the tone of the thing.
- Every list row and button must work at 390px: give a row's text a minimum width
  (`min-w-[11rem] flex-1`) so its buttons wrap underneath instead of squeezing the text.
- A person's words, counts and statuses come from the API; the UI words them, never decides them.
