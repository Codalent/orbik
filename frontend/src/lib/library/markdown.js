/**
 * What the Library page works out from a file's Markdown without asking the server.
 *
 * Three jobs, all of them about showing a person where they stand in a document two writers share:
 * splitting text into the blocks the server records as authorship, listing the headings so the
 * reader has a contents rail, and comparing two versions so History can say what a run changed
 * rather than only that it changed something.
 *
 * The block rule is a simplified copy of the server's — blank-line separated, fenced code kept
 * whole — duplicated rather than imported because the web app is a separate build that does not
 * depend on the workspace packages. It is used for highlighting and for diffs, so a block that
 * fails to line up shows unmarked rather than wrong.
 */

/** Splits Markdown into the same blocks the server records, so marks line up with authorship. */
export function splitBlocks(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const blocks = [];
  let current = [];
  let fence = null;
  const flush = () => {
    const text = current.join("\n").trim();
    current = [];
    if (text) blocks.push(text);
  };
  for (const line of lines) {
    const match = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      current.push(line);
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length) {
        fence = null;
        flush();
      }
      continue;
    }
    if (match) {
      flush();
      fence = match[1];
      current.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

/**
 * The headings of a file, in order, as the contents rail beside it.
 *
 * Only `##` and `###`: the file's own title is already at the top of the page, so a lone `#` in the
 * body is treated as a section like any other rather than as a second title. Identifiers are
 * generated here rather than taken from the renderer, and the reader stamps the same ones onto the
 * rendered headings, so the two cannot disagree.
 */
export function headingsOf(markdown) {
  const headings = [];
  const seen = new Map();
  let fence = null;
  for (const line of String(markdown ?? "").split(/\r?\n/)) {
    const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }
    const match = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const text = match[2].replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/[*_`]/g, "").trim();
    if (!text) continue;
    const base = slugifyHeading(text);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    headings.push({ depth: match[1].length, text, id: count === 1 ? base : `${base}-${count}` });
  }
  return headings;
}

/** The identifier a heading is linked by; matched by the reader when it renders the heading. */
export function slugifyHeading(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

/**
 * What changed between two versions of a file, block by block.
 *
 * A word-level diff would be more precise and much harder to read at a glance; the question this
 * answers is "which paragraphs did the run touch", and a paragraph is also the unit the server
 * protects, so the diff and the thing being protected are the same shape.
 *
 * Returns entries of `{ type: "same" | "removed" | "added", text }`, oldest text first.
 */
export function diffBlocks(before, after) {
  const from = splitBlocks(before);
  const to = splitBlocks(after);
  // Longest common subsequence over whole blocks. Files here are tens of blocks, so the quadratic
  // table costs nothing and keeps the walk-back obvious.
  const table = Array.from({ length: from.length + 1 }, () => new Array(to.length + 1).fill(0));
  for (let i = from.length - 1; i >= 0; i -= 1) {
    for (let j = to.length - 1; j >= 0; j -= 1) {
      table[i][j] = from[i] === to[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const changes = [];
  let i = 0;
  let j = 0;
  while (i < from.length && j < to.length) {
    if (from[i] === to[j]) {
      changes.push({ type: "same", text: from[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      changes.push({ type: "removed", text: from[i] });
      i += 1;
    } else {
      changes.push({ type: "added", text: to[j] });
      j += 1;
    }
  }
  while (i < from.length) { changes.push({ type: "removed", text: from[i] }); i += 1; }
  while (j < to.length) { changes.push({ type: "added", text: to[j] }); j += 1; }
  return changes;
}

/** One line of plain text from a block, for a diff row that has to fit on a couple of lines. */
export function flattenBlock(text) {
  return String(text ?? "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/```[\s\S]*?```/g, "code")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
