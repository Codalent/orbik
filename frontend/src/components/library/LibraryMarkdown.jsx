"use client";

import { useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuth } from "@/lib/auth/AuthProvider";
import { personFromEmail } from "@/lib/format";
import { slugifyHeading, splitBlocks } from "@/lib/library/markdown";
import { cn } from "@/lib/utils";

/**
 * A Library file's Markdown, rendered, with the person's own passages marked.
 *
 * Rendered block by block rather than as one document so the mark covers exactly what the server
 * recorded as theirs — the same unit it protects on the next run. Their passages read like the
 * rest of the file; a run of them carries a small circle with their initial in the left margin,
 * and pointing at it (or focusing it) tints the run, so the page stays one document until somebody
 * asks whose words are whose.
 *
 * Whose they are comes from the server, block by block (`blockAuthors`): in a workspace several
 * people write in, the passage a colleague wrote carries their initial, not the reader's, and a
 * run of passages by two people is two runs with a mark each. Without it every passage is the
 * signed-in person's, as it was when only the owner could write.
 *
 * A `[[/path]]` link reads as the title of the file it points at when the page knows it, because
 * a sentence that says "see /02-offer/pricing" is an address where a reader expected a word; a
 * labelled link, `[[/path|the pricing page]]`, reads as its label. Either opens the file inside
 * the Library rather than navigating, and hands the click to `onOpen` with the event, so a
 * modifier key can send it to a new tab or the pane beside.
 *
 * @param {object} props
 * @param {string} props.markdown
 * @param {Set<string>|null} [props.userBlocks] the person's passages, trimmed; none are marked without it
 * @param {Map<string, {userId: string, email: string}|null>|null} [props.blockAuthors] who wrote
 *   each of those passages, by its trimmed text, from {@link blockAuthorsOf}
 * @param {(path: string, event?: MouseEvent) => void} props.onOpen
 * @param {(path: string) => string|null} [props.titleOf] the title of a file the page knows of
 * @param {string} [props.idPrefix] prefixes heading identifiers, so two panes showing one file
 *   do not hand out the same ones
 * @param {string} [props.className]
 */
export function LibraryMarkdown({ markdown, userBlocks = null, blockAuthors = null, onOpen, titleOf, idPrefix = "", className }) {
  const blocks = useMemo(() => splitBlocks(markdown ?? ""), [markdown]);
  // Heading identifiers are handed out in document order, the same way the contents rail works
  // them out, so the two agree without either of them holding the other's list.
  const counts = new Map();
  const idFor = (text) => {
    const base = slugifyHeading(text);
    const next = (counts.get(base) ?? 0) + 1;
    counts.set(base, next);
    return `${idPrefix}${next === 1 ? base : `${base}-${next}`}`;
  };
  const components = markdownComponents({ idFor, onOpen });
  const { user } = useAuth();
  const viewer = personFromEmail(user?.email) ?? { name: "you", initial: "Y" };
  const runs = groupRuns(blocks, userBlocks, blockAuthors);
  const render = ({ block, index }) => (
    <div key={`${index}-${block.slice(0, 24)}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={keepLibraryLinks}>
        {withLibraryLinks(block, titleOf)}
      </ReactMarkdown>
    </div>
  );

  return (
    <div className={cn("doc-prose [&>:first-child>:first-child]:mt-0", className)}>
      {runs.map((run) => {
        if (!run.mine) return render(run.blocks[0]);
        const author = authorOf(run.author, viewer);
        // The run's box has no padding, so the first block's top margin falls outside it and the
        // text sits exactly where it would unmarked; the tint is drawn a little beyond the box,
        // behind the text. The mark and the tint come after the blocks so the first-child rules
        // still reach the first block, and the tint follows the mark as its `peer`.
        return (
          <div key={`mine-${run.blocks[0].index}`} className="relative isolate [&>div+div]:mt-[1em]">
            {run.blocks.map(render)}
            <Tooltip>
              <TooltipTrigger
                render={<button type="button" aria-label={`Written by ${author.name}`} />}
                className="peer absolute top-[0.3rem] -left-4 grid size-3.5 place-items-center rounded-full bg-orb-raised text-[0.5rem] font-semibold text-orb-gray ring-1 ring-orb-line outline-none select-none transition-colors hover:text-orb-white hover:ring-orb-lime/50 focus-visible:ring-2 focus-visible:ring-ring/70 md:-left-8 md:size-5 md:text-[0.625rem]"
              >
                <span aria-hidden="true">{author.initial}</span>
              </TooltipTrigger>
              <TooltipContent side="top" align="start">Written by {author.name} · kept when the agent rewrites this file</TooltipContent>
            </Tooltip>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -inset-x-3 -inset-y-1.5 -z-10 rounded-lg transition-colors duration-150 peer-hover:bg-orb-lime/[0.06] peer-focus-visible:bg-orb-lime/[0.06]"
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Who wrote each of a file's passages, by the passage's trimmed text, from the node the API
 * returned: `userBlockAuthors` beside `userBlocks`. Null when the node does not say, which leaves
 * every passage the reader's.
 *
 * @param {{userBlocks?: string[], userBlockAuthors?: Array<{userId: string, email: string}|null>}} node
 * @returns {Map<string, {userId: string, email: string}|null>|null}
 */
export function blockAuthorsOf(node) {
  const texts = node?.userBlocks ?? [];
  const authors = node?.userBlockAuthors;
  if (!Array.isArray(authors) || authors.length !== texts.length) return null;
  const map = new Map();
  texts.forEach((text, index) => {
    const key = text.trim();
    if (!map.has(key)) map.set(key, authors[index] ?? null);
  });
  return map;
}

/** Marks a passage the server records with no author it can name. */
const UNKNOWN = Symbol("unknown author");

/**
 * Consecutive passages by one person, grouped into one run so a few paragraphs they wrote
 * together carry one mark rather than one each. Passages by two people side by side are two runs.
 * Every other block is a run of its own.
 */
function groupRuns(blocks, userBlocks, blockAuthors) {
  const runs = [];
  blocks.forEach((block, index) => {
    const key = block.trim();
    const mine = Boolean(userBlocks?.has(key));
    // Without authors every passage is the reader's: one author, the viewer, keyed by nothing.
    const author = mine && blockAuthors ? (blockAuthors.has(key) ? blockAuthors.get(key) ?? UNKNOWN : null) : null;
    const who = author === UNKNOWN ? UNKNOWN : author?.userId ?? null;
    const last = runs.at(-1);
    if (mine && last?.mine && last.who === who) last.blocks.push({ block, index });
    else runs.push({ mine, author, who, blocks: [{ block, index }] });
  });
  return runs;
}

/**
 * A run's author as the mark names them: the person the server recorded, or — with no record —
 * the signed-in person, which is who wrote every passage before workspaces had members.
 */
function authorOf(author, viewer) {
  if (author === UNKNOWN) return { name: "someone", initial: "?" };
  if (!author) return viewer;
  return personFromEmail(author.email) ?? { name: author.email, initial: "?" };
}

/** The identifier of a heading in a pane, as `LibraryMarkdown` stamps it: for the contents rail. */
export function headingId(idPrefix, id) {
  return `${idPrefix}${id}`;
}

/**
 * How the renderer draws what it is given.
 *
 * Headings take the identifiers the contents rail links to; a Library link is a button that opens
 * the file in place, because the Library is one page and a wiki link inside it is a selection,
 * not a new document. A link still reading as an address keeps the address's monospace.
 */
function markdownComponents({ idFor, onOpen }) {
  const heading = (Tag) => function Heading({ children, ...props }) {
    const text = typeof children === "string" ? children : flatten(children);
    return <Tag id={idFor(text)} {...props}>{children}</Tag>;
  };
  return {
    h1: heading("h2"),
    h2: heading("h2"),
    h3: heading("h3"),
    a({ href, children, ...props }) {
      if (href?.startsWith("library:")) {
        const path = href.slice("library:".length);
        const asAddress = flatten(children) === path;
        return (
          <button
            type="button"
            onClick={(event) => onOpen(path, event)}
            onAuxClick={(event) => { if (event.button === 1) onOpen(path, event); }}
            title={path}
            className={cn(
              "text-left text-orb-cyan underline decoration-orb-cyan/40 underline-offset-[3px] hover:text-orb-white hover:decoration-current",
              asAddress && "font-mono text-[0.9em]",
            )}
          >
            {children}
          </button>
        );
      }
      return <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>;
    },
    // No image is loaded: a Library file is partly written from a crawled site, and a picture
    // fetched from wherever a file says would tell that place who is reading.
    img({ alt }) {
      return alt ? <span className="text-orb-muted">[{alt}]</span> : null;
    },
  };
}

/**
 * Lets the Library's own links through the renderer's check of what a link may point at.
 *
 * The renderer drops any address whose scheme it does not know, which is right for a document
 * that is partly written from a crawled site — and which also dropped the scheme the Library
 * itself writes for a `[[/path]]` link, `library:`. That one is kept as written, because the
 * components above decide what it opens; everything else gets the renderer's own rule.
 */
function keepLibraryLinks(url) {
  return /^library:\//.test(url) ? url : defaultUrlTransform(url);
}

/** The text of a heading or a link, whatever the renderer nested inside it. */
function flatten(children) {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(flatten).join("");
  if (children?.props?.children) return flatten(children.props.children);
  return "";
}

/** A Library path, as a `[[link]]` names it. */
const LINK_TARGET = "\\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)*";

/**
 * Turns the Library's own `[[/path]]` and `[[/path|label]]` links into links the renderer
 * understands, read as their label, or the title of what they point at, or failing both the path.
 */
function withLibraryLinks(markdown, titleOf) {
  const pattern = new RegExp(`\\[\\[(${LINK_TARGET})(?:\\|([^\\]\\n]*))?\\]\\]`, "g");
  return markdown.replace(pattern, (_match, path, label) => {
    const text = (label?.trim() || titleOf?.(path) || path).replace(/[[\]\\]/g, "\\$&");
    return `[${text}](library:${path})`;
  });
}
