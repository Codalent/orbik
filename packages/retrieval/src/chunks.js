import { createHash } from "node:crypto";

/**
 * Cutting a document into the passages a retrieval index is built from.
 *
 * It lives in `@orbik/retrieval`, beside the index that is its only caller, and both kinds of
 * document go through it: the crawler's rendered page Markdown in `crawl_page_markdown`, and the
 * Library files that agents and people write. One chunker means a passage from a source page and a
 * passage from a Library file are cut the same way and compare honestly at query time; two would
 * drift, and the symptom would be search results whose scores meant different things depending on
 * where they came from.
 *
 * **Structure-aware rather than fixed-width.** A sliding window of N characters cuts a price table
 * in half and separates a heading from the paragraph that answers it, which is exactly the case
 * retrieval has to get right. So the unit here is the *section*: a heading and everything under it
 * until the next heading of the same or higher rank. Each chunk remembers the full heading path —
 * `["Pricing", "Enterprise"]` — which is what lets a citation point at `#enterprise` rather than at
 * a page, and what lets a model tell two similarly-worded passages apart.
 *
 * **Blocks are never split.** A fenced code block, a table, and a run of list items are held
 * together, because half a table is not a fact about anything. Only a section that is too long to
 * embed is divided, and then only at a block boundary, with the previous block repeated at the
 * head of the next part so a sentence that straddles the cut is still findable from both sides.
 */

/**
 * Characters of one chunk before it is divided.
 *
 * About 1,500 tokens, at the four-characters-a-token rule of thumb that holds for English prose.
 * The number is a trade between two failure modes: chunks so small that an answer is spread over
 * six of them and the model sees none of them whole, and chunks so large that the one sentence
 * that matters is averaged away by everything around it. Section-shaped chunks of roughly this
 * size are what a marketing site's pages and a Library file naturally produce anyway — the limit
 * is what catches the documentation page that does not.
 */
const CHUNK_LIMIT_CHARACTERS = 6_000;

/**
 * Characters of a single indivisible block that are kept.
 *
 * A table or a code fence longer than this is cut with a marker rather than divided, because a
 * block is kept whole by design and one enormous one must not be able to spend a whole embedding
 * request on its own.
 */
const MAX_BLOCK_CHARACTERS = 12_000;

/** Heading levels the chunker recognises; deeper ones are treated as text. */
const MAX_HEADING_DEPTH = 6;

/** Matches an ATX heading line and captures its level and text. */
const HEADING = /^(#{1,6})\s+(.*)$/;

/** Matches the opening or closing line of a fenced code block. */
const FENCE = /^\s*(?:```|~~~)/;

/**
 * Reads and removes the crawler's front-matter block.
 *
 * The block is written by `toMarkdown` in the crawler and carries the URL, title, description,
 * canonical and language of the page. It is stripped from the text because it is metadata rather
 * than something anybody asks a question about — a chunk that began "url: …, title: …" would match
 * every query that mentioned a URL — and its fields are kept, because they are exactly what a
 * citation needs.
 *
 * @param {string} markdown a document, with or without front matter
 * @returns {{fields: Record<string, string>, body: string}}
 */
export function splitFrontMatter(markdown) {
  const text = String(markdown ?? "");
  if (!text.startsWith("---\n")) return { fields: {}, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { fields: {}, body: text };

  const fields = {};
  for (const line of text.slice(4, end).split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const raw = line.slice(at + 1).trim();
    if (!key) continue;
    // The crawler writes every value as JSON, so quotes and colons inside a title survive.
    try {
      const value = JSON.parse(raw);
      if (typeof value === "string" && value) fields[key] = value;
    } catch {
      if (raw) fields[key] = raw;
    }
  }
  return { fields, body: text.slice(end + 5) };
}

/**
 * Cuts one document into chunks.
 *
 * @param {string} markdown the document, front matter included
 * @param {object} [options]
 * @param {string} [options.title] what to call the document when it has no leading heading; it
 *   becomes the first element of every heading path, so a chunk from an untitled page still says
 *   what it is part of
 * @param {number} [options.limit] characters before a section is divided
 * @returns {{fields: Record<string, string>, chunks: Array<{ordinal: number, headingPath: string[],
 *   heading: string|null, text: string, hash: string, characters: number}>}}
 */
export function chunkMarkdown(markdown, { title = null, limit = CHUNK_LIMIT_CHARACTERS } = {}) {
  const { fields, body } = splitFrontMatter(markdown);
  const sections = toSections(body, title);

  const chunks = [];
  for (const section of sections) {
    for (const text of divide(section, limit)) {
      const trimmed = text.trim();
      // A heading with nothing under it says nothing on its own: it would embed as a two-word
      // document and outrank real passages on any query that happened to use those two words.
      if (!trimmed || !hasProse(trimmed, section.heading)) continue;
      chunks.push({
        ordinal: chunks.length,
        headingPath: section.headingPath,
        heading: section.heading,
        text: trimmed,
        hash: hashText(trimmed),
        characters: trimmed.length,
      });
    }
  }

  return { fields, chunks };
}

/** The content hash of one passage, which is what says whether it has to be embedded again. */
function hashText(text) {
  return createHash("sha256").update(String(text ?? "")).digest("hex");
}

/**
 * The content hash of a whole document, used to decide whether to re-chunk it at all.
 *
 * The crawler already stores one for every page it renders, so this exists for the documents that
 * have none: a Library file, whose `revision` says that *a* write happened rather than that the
 * text changed. Restoring a file to a version it already held bumps the revision and must not cost
 * an embedding.
 *
 * @param {...unknown} parts everything that changes the meaning of the document
 */
export function hashDocument(...parts) {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(`${String(part ?? "")}\u0000`);
  return digest.digest("hex");
}

/**
 * Splits a document into sections at its headings.
 *
 * A section carries its own heading line at the top of its text, so an embedded passage answers
 * "what is this about" without the index having to join anything back on.
 */
function toSections(body, title) {
  const blocks = toBlocks(body);
  const root = title ? [title] : [];
  const sections = [];
  let current = { headingPath: [...root], heading: null, blocks: [] };
  // Index 0 is the document title, so a level-1 heading replaces index 1 and never the title.
  const path = [...root];

  for (const block of blocks) {
    const heading = block.kind === "text" ? HEADING.exec(block.text) : null;
    if (!heading) {
      current.blocks.push(block);
      continue;
    }
    if (current.blocks.length || current.heading) sections.push(current);
    const level = Math.min(heading[1].length, MAX_HEADING_DEPTH);
    const text = heading[2].trim();
    path.length = Math.min(path.length, root.length + level - 1);
    path[root.length + level - 1] = text;
    for (let index = 0; index < path.length; index += 1) path[index] ??= "";
    // A page whose <title> and H1 are both "Pricing" would otherwise cite as "Pricing > Pricing >
    // Retainer", which reads like a mistake. Consecutive repeats are dropped from the path only;
    // the chunk's own text is untouched, so this changes no hash and costs no re-embedding.
    const headingPath = path.filter(Boolean).filter((part, index, all) => part !== all[index - 1]);
    current = { headingPath, heading: block.text.trim(), blocks: [] };
  }
  if (current.blocks.length || current.heading) sections.push(current);
  return sections;
}

/**
 * Splits text into the units that are never divided.
 *
 * A block is a fenced code block, or a run of consecutive non-blank lines — which is what a
 * paragraph, a table and a tight list all are. That is deliberately the simplest rule that keeps
 * the three cases that matter whole; a list written with blank lines between its items is divided
 * like the paragraphs it is written as, and that is an acceptable cost for a rule with no corner
 * cases in it.
 */
function toBlocks(body) {
  const lines = String(body ?? "").split("\n");
  const blocks = [];
  let buffer = [];
  let fence = null;

  const flush = (kind) => {
    if (!buffer.length) return;
    const text = buffer.join("\n").trim();
    if (text) blocks.push({ kind, text });
    buffer = [];
  };

  for (const line of lines) {
    if (fence) {
      buffer.push(line);
      if (FENCE.test(line)) {
        flush("code");
        fence = null;
      }
      continue;
    }
    if (FENCE.test(line)) {
      flush("text");
      buffer.push(line);
      fence = true;
      continue;
    }
    if (!line.trim()) {
      flush("text");
      continue;
    }
    // A heading ends the run before it and stands alone, so a section boundary is never buried
    // inside a block that would then be kept whole across it.
    if (HEADING.test(line)) {
      flush("text");
      blocks.push({ kind: "text", text: line });
      continue;
    }
    buffer.push(line);
  }
  // An unterminated fence is the page's mistake, not the reader's: keep what it opened.
  flush(fence ? "code" : "text");
  return blocks;
}

/**
 * Divides one section into parts small enough to embed.
 *
 * The heading is repeated at the head of every part, and the last block of a part is repeated at
 * the head of the next one. The overlap is one block rather than a fixed number of characters
 * because a fixed overlap cuts mid-sentence, which is the thing this whole module exists to avoid.
 */
function divide(section, limit) {
  const head = section.heading ? `${section.heading}\n` : "";
  const blocks = section.blocks.map((block) => cap(block.text));
  if (!blocks.length) return head ? [head] : [];

  const parts = [];
  let current = [];
  let size = head.length;

  for (const block of blocks) {
    if (current.length && size + block.length + 2 > limit) {
      parts.push(head + current.join("\n\n"));
      // One block of overlap, and only when there is room for it beside what follows.
      const overlap = current.at(-1);
      current = overlap.length + block.length + head.length + 4 <= limit ? [overlap, block] : [block];
      size = head.length + current.reduce((total, entry) => total + entry.length + 2, 0);
      continue;
    }
    current.push(block);
    size += block.length + 2;
  }
  if (current.length) parts.push(head + current.join("\n\n"));
  return parts;
}

/** Keeps one indivisible block inside a bound, marking the cut so nothing reads as the whole. */
function cap(text) {
  if (text.length <= MAX_BLOCK_CHARACTERS) return text;
  return `${text.slice(0, MAX_BLOCK_CHARACTERS)}\n… (cut off)`;
}

/** Whether a chunk holds anything besides its own heading. */
function hasProse(text, heading) {
  if (!heading) return true;
  return text.slice(heading.length).trim().length > 0;
}
