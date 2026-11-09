import { createHash } from "node:crypto";

/**
 * Markdown blocks: the unit in which a person's writing is protected from an agent's.
 *
 * Two writers share every Library file. The rule that makes that survivable is not "who owns this
 * file" — nobody owns one — but "what must survive a write": every block a person wrote or edited
 * is recorded, and an agent's next version is refused unless it still contains all of them. The
 * agent may reorder, write before and after, and rewrite its own paragraphs freely.
 *
 * A block is a paragraph, list, table or heading separated by blank lines, with fenced code kept
 * whole because a fence's own blank lines are not paragraph breaks. Comparison is on normalized
 * whitespace, so re-wrapping a paragraph at a different column is not an edit; changing one word
 * of it claims the whole paragraph, which is the deliberately coarse and predictable rule. A finer
 * one — sentences, words — would let an agent rewrite half of somebody's paragraph and still pass
 * the check, which is exactly the surprise this exists to prevent.
 */

/** Opens a run of the person's own writing in Markdown handed to an agent. */
export const USER_BLOCK_OPEN = "<!-- user -->";

/** Closes a run of the person's own writing. */
const USER_BLOCK_CLOSE = "<!-- /user -->";

/** Matches either marker on a line of its own, for stripping them back out on write. */
const USER_MARKER_LINE = /^[ \t]*<!--[ \t]*\/?user[ \t]*-->[ \t]*$/gm;

/** Matches the opening or closing line of a fenced code block. */
const FENCE_LINE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/**
 * Splits Markdown into blocks.
 *
 * Fenced code is the one construct that must not be split: a fence holds blank lines, and cutting
 * it into paragraphs would produce blocks that are not Markdown at all and hashes that change
 * whenever an unrelated line inside the fence moves.
 *
 * @param {string} markdown a whole document
 * @returns {Array<{hash: string, text: string}>} blocks in document order
 */
function splitMarkdownBlocks(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const blocks = [];
  let current = [];
  let fence = null;

  const flush = () => {
    const text = current.join("\n").trim();
    current = [];
    if (text) blocks.push({ hash: hashMarkdownBlock(text), text });
  };

  for (const line of lines) {
    const fenceMatch = FENCE_LINE.exec(line);
    if (fence) {
      current.push(line);
      // Only a fence of the same character and at least the same length closes the run, which is
      // what lets a Markdown sample inside a four-backtick fence contain three backticks.
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = null;
        flush();
      }
      continue;
    }
    if (fenceMatch) {
      flush();
      fence = fenceMatch[1];
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
 * The identity of a block: a hash of its text with whitespace normalized.
 *
 * Normalized so that re-flowing a paragraph, indenting a list differently, or saving with Windows
 * line endings is not an edit. Hashed rather than compared as text so that a node can carry the
 * identity of every block a person deleted without carrying the deleted text forever.
 *
 * @param {string} text one block
 * @returns {string} a stable hexadecimal identity
 */
function hashMarkdownBlock(text) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

/** The hashes of a document's blocks, in document order. */
export function markdownBlockHashes(markdown) {
  return splitMarkdownBlocks(markdown).map((block) => block.hash);
}

/**
 * What changed between two versions of a document, block by block.
 *
 * The same blocks and the same identity a person's writing is protected by: a paragraph, list,
 * table or heading, compared after whitespace is normalized, with fenced code whole. A block is
 * *removed* when the earlier version has it and the later does not, and *added* the other way
 * round; a block that moved is neither. For a page watched over time, where "what changed" is the
 * paragraphs that came and went rather than a line diff of a rendering.
 *
 * @param {string} previous the earlier version
 * @param {string} current the later version
 * @returns {{added: string[], removed: string[]}} block texts, in the order each version has them
 */
export function diffMarkdownBlocks(previous, current) {
  const before = splitMarkdownBlocks(previous);
  const after = splitMarkdownBlocks(current);
  const had = new Set(before.map((block) => block.hash));
  const has = new Set(after.map((block) => block.hash));
  return {
    added: after.filter((block) => !had.has(block.hash)).map((block) => block.text),
    removed: before.filter((block) => !has.has(block.hash)).map((block) => block.text),
  };
}

/**
 * Removes the user-block markers from Markdown an agent is handing back.
 *
 * Reads show the boundary and writes accept it back: an agent that returns the document it was
 * given, markers and all, must not have the markers stored as content. Stripping rather than
 * refusing is deliberate — the markers are the agent's own view of the file, and punishing it for
 * echoing them would make the read format a trap.
 *
 * @param {string} markdown as the agent wrote it
 * @returns {string} the document without markers
 */
export function stripUserBlockMarkers(markdown) {
  return String(markdown ?? "")
    .replace(USER_MARKER_LINE, "\0")
    .split("\n")
    .filter((line) => line !== "\0")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Wraps the blocks a person wrote in markers, so an agent reading the file can see them.
 *
 * Consecutive user blocks share one pair of markers rather than getting one each: a run of three
 * paragraphs somebody wrote reads as one passage, and six markers through it would be noise in
 * the one place the agent most needs to read carefully.
 *
 * @param {string} markdown the stored document
 * @param {ReadonlyArray<{hash: string}>} protectedBlocks blocks recorded as the person's
 * @returns {string} the document with the person's writing marked
 */
export function markUserBlocks(markdown, protectedBlocks = []) {
  const owned = new Set(protectedBlocks.map((block) => block.hash));
  if (!owned.size) return String(markdown ?? "").trim();

  const parts = [];
  let inUser = false;
  for (const block of splitMarkdownBlocks(markdown)) {
    const isUser = owned.has(block.hash);
    if (isUser && !inUser) parts.push(USER_BLOCK_OPEN);
    if (!isUser && inUser) parts.push(USER_BLOCK_CLOSE);
    inUser = isUser;
    parts.push(block.text);
  }
  if (inUser) parts.push(USER_BLOCK_CLOSE);
  return parts.join("\n\n");
}

/**
 * Works out what a person's save claims, and what it deletes.
 *
 * Called on every save by a person, against the hashes of the version the agent last wrote.
 * Anything in the saved document that the agent did not write is the person's, and anything the
 * agent wrote that the saved document no longer contains is a deletion the agent must not undo.
 * Both are recorded on the node, and both are checked on the next agent write.
 *
 * Blocks already recorded as the person's stay recorded while they are still present — which is
 * what keeps protection through the cycle where an agent dutifully preserves somebody's paragraph
 * and thereby makes it look, on the next comparison, like the agent's own.
 *
 * A block claimed by this save records who claimed it (`userId`), so a workspace several people
 * write in can say whose each passage is. A block that was already somebody's keeps its record
 * as it was — its author, or none for one claimed before authors were recorded — however many
 * other people save the file around it. Changing a block makes it a new block, and the person who
 * changed it claims it.
 *
 * @param {object} options
 * @param {string} options.markdown the document as the person saved it
 * @param {readonly string[]} options.agentBlocks hashes the agent last wrote
 * @param {ReadonlyArray<{hash: string, text: string, userId?: unknown}>} [options.protectedBlocks] what was already the person's
 * @param {readonly string[]} [options.removedBlocks] what the person had already deleted
 * @param {unknown} [options.userId] who is saving; recorded on the blocks this save claims
 * @returns {{protectedBlocks: Array<{hash: string, text: string, userId?: unknown}>, removedBlocks: string[]}}
 */
export function recordUserEdit({ markdown, agentBlocks = [], protectedBlocks = [], removedBlocks = [], userId = null }) {
  const blocks = splitMarkdownBlocks(markdown);
  const present = new Set(blocks.map((block) => block.hash));
  const written = new Set(agentBlocks);
  const alreadyOwned = new Map(protectedBlocks.map((block) => [block.hash, block]));

  const owned = [];
  const seen = new Set();
  for (const block of blocks) {
    if (seen.has(block.hash)) continue;
    // Either the agent never wrote it, or it was already recorded as the person's and is still
    // here. A block the agent wrote and the person left alone stays the agent's to rewrite.
    const previous = alreadyOwned.get(block.hash);
    if (previous) {
      seen.add(block.hash);
      owned.push({ ...previous, hash: block.hash, text: block.text });
    } else if (!written.has(block.hash)) {
      seen.add(block.hash);
      owned.push({ hash: block.hash, text: block.text, ...(userId ? { userId } : {}) });
    }
  }

  const deleted = new Set(removedBlocks.filter((hash) => !present.has(hash)));
  for (const hash of written) {
    if (!present.has(hash)) deleted.add(hash);
  }

  return { protectedBlocks: owned, removedBlocks: [...deleted] };
}

/**
 * Checks an agent's version against what the person's edits claimed.
 *
 * Returns what is wrong rather than throwing, because the caller has to name the offending text
 * back to the model: "you dropped this paragraph, here it is, put it back" is a message a run can
 * recover from inside the same turn.
 *
 * @param {object} options
 * @param {string} options.markdown the document as the agent wrote it
 * @param {ReadonlyArray<{hash: string, text: string}>} [options.protectedBlocks] the person's writing
 * @param {readonly string[]} [options.removedBlocks] what the person deleted
 * @returns {{missing: Array<{hash: string, text: string}>, reintroduced: string[]}}
 */
export function checkAgentWrite({ markdown, protectedBlocks = [], removedBlocks = [] }) {
  const present = new Set(markdownBlockHashes(markdown));
  return {
    missing: protectedBlocks.filter((block) => !present.has(block.hash)),
    reintroduced: removedBlocks.filter((hash) => present.has(hash)),
  };
}

/**
 * Rewrites a generated document so that it keeps what a person wrote in the one it replaces.
 *
 * `library.write` refuses an agent's version that drops a person's block, and a model that is
 * told so can put the block back and try again. Plain code that *generates* a file has nobody to
 * tell: it would produce the same document on every attempt and be refused every time. So this
 * does, by rule, what the instruction asks of a model:
 *
 * - every block the person wrote that the new document lacks is put back, under the heading it
 *   sat under before when the new document still has that heading, and otherwise at the end;
 * - every block the person deleted that the new document would bring back is left out.
 *
 * Consecutive blocks of theirs stay together and in order. Nothing of theirs is reworded, and
 * nothing the generator wrote is kept that they removed — which is the whole contract, applied
 * without a model in the loop.
 *
 * @param {object} options
 * @param {string} options.markdown the document as generated
 * @param {string} [options.previous] the stored document it replaces
 * @param {ReadonlyArray<{hash: string, text: string}>} [options.protectedBlocks] the person's writing
 * @param {readonly string[]} [options.removedBlocks] hashes of what the person deleted
 * @returns {string} the document to store
 */
export function keepUserWriting({ markdown, previous = "", protectedBlocks = [], removedBlocks = [] }) {
  const removed = new Set(removedBlocks);
  const blocks = splitMarkdownBlocks(markdown).filter((block) => !removed.has(block.hash));
  if (!protectedBlocks.length) return blocks.map((block) => block.text).join("\n\n");

  const present = new Set(blocks.map((block) => block.hash));
  const owned = new Map(protectedBlocks.map((block) => [block.hash, block]));
  const isHeading = (block) => /^#{1,6}\s/.test(block.text);

  // Where each of the person's blocks sat: under which heading of the document being replaced.
  const homes = new Map();
  const order = [];
  let heading = null;
  for (const block of splitMarkdownBlocks(previous)) {
    if (isHeading(block) && !owned.has(block.hash)) heading = block.hash;
    if (owned.has(block.hash) && !present.has(block.hash) && !homes.has(block.hash)) {
      homes.set(block.hash, heading);
      order.push(block.hash);
    }
  }
  // A block recorded as theirs that the stored document no longer shows still has to survive.
  for (const block of protectedBlocks) {
    if (!present.has(block.hash) && !homes.has(block.hash)) {
      homes.set(block.hash, null);
      order.push(block.hash);
    }
  }
  if (!order.length) return blocks.map((block) => block.text).join("\n\n");

  // A section runs from its heading to the next heading of any level; theirs go at its end.
  const result = [];
  const pending = new Map();
  for (const hash of order) {
    const home = homes.get(hash);
    const key = home && present.has(home) ? home : null;
    if (!pending.has(key)) pending.set(key, []);
    pending.get(key).push(owned.get(hash).text);
  }
  let section = null;
  const closeSection = () => {
    if (section !== null && pending.has(section)) {
      result.push(...pending.get(section));
      pending.delete(section);
    }
  };
  for (const block of blocks) {
    if (isHeading(block)) {
      closeSection();
      section = block.hash;
    }
    result.push(block.text);
  }
  closeSection();
  // Whatever had no heading to return to — theirs from a section the new document dropped.
  for (const texts of pending.values()) result.push(...texts);
  return result.join("\n\n");
}

/**
 * The wiki-style links a document makes.
 *
 * `[[/clients/deeplearning-ai]]` is how one file points at another instead of restating it, which
 * is the convention that keeps one home per fact. The target is returned exactly as written; it is
 * the store that resolves it against the tree and refuses an agent's dangling link.
 *
 * @param {string} markdown a whole document
 * @returns {string[]} link targets, de-duplicated, in document order
 */
export function extractWikiLinks(markdown) {
  const text = String(markdown ?? "");
  const pattern = /\[\[([^\]|\n]{1,400})(?:\|[^\]\n]{0,200})?\]\]/g;
  const links = [];
  let match = pattern.exec(text);
  while (match) {
    const target = match[1].trim();
    if (target && !links.includes(target)) links.push(target);
    match = pattern.exec(text);
  }
  return links;
}

/** Matches one wiki link: its target, and the label after a `|` when it has one. */
const WIKI_LINK = /\[\[([^\]|\n]{1,400})((?:\|[^\]\n]{0,200})?)\]\]/g;

/**
 * Rewrites the targets of a document's `[[links]]`, leaving everything else exactly as it was.
 *
 * `retarget` is handed each target as written and returns the new one, or null to leave it alone;
 * a link's label (`[[/path|label]]`) is kept. Used when a node is renamed or moved, so a link to
 * the old path, or to anything under it, follows it.
 *
 * @param {string} markdown a whole document, or one block of it
 * @param {(target: string) => string|null} retarget the new target for a link, or null
 * @returns {string} the document with its links rewritten
 */
export function rewriteWikiLinks(markdown, retarget) {
  return String(markdown ?? "").replace(WIKI_LINK, (whole, target, label) => {
    const next = retarget(target.trim());
    return next ? `[[${next}${label}]]` : whole;
  });
}

/**
 * Rewrites a file's links and keeps the record of whose block is whose in step with the text.
 *
 * A person's block is protected by the hash of its text, and the agent's own blocks are recorded
 * by theirs. A rename that rewrote `[[/02-offer/pricing]]` inside somebody's paragraph would
 * otherwise leave the recorded hash describing a paragraph that no longer exists: the next agent
 * write would be refused for "dropping" it, and the person's paragraph would stop being theirs.
 * So every hash that names a block whose links changed is replaced by the hash of the rewritten
 * block, in the same write as the text.
 *
 * Blocks a person deleted are kept by hash only, without their text, so a deleted block that
 * held a link cannot be rewritten; its old hash stays recorded, which still refuses the version
 * with the old link should an agent bring it back.
 *
 * @param {object} options
 * @param {string} options.markdown the stored document
 * @param {ReadonlyArray<{hash: string, text: string, userId?: unknown}>} [options.protectedBlocks] the person's blocks
 * @param {readonly string[]} [options.agentBlocks] the hashes of the agent's blocks
 * @param {(target: string) => string|null} options.retarget the new target for a link, or null
 * @returns {{changed: boolean, markdown: string, protectedBlocks: Array<{hash: string, text: string, userId?: unknown}>, agentBlocks: string[]}}
 */
export function relinkMarkdown({ markdown, protectedBlocks = [], agentBlocks = [], retarget }) {
  const blocks = splitMarkdownBlocks(markdown);
  const renamed = new Map();
  for (const block of blocks) {
    const text = rewriteWikiLinks(block.text, retarget);
    if (text !== block.text) renamed.set(block.hash, hashMarkdownBlock(text));
  }
  const rewritten = rewriteWikiLinks(markdown, retarget);
  if (rewritten === String(markdown ?? "")) {
    return { changed: false, markdown: rewritten, protectedBlocks: [...protectedBlocks], agentBlocks: [...agentBlocks] };
  }
  return {
    changed: true,
    markdown: rewritten,
    protectedBlocks: protectedBlocks.map((block) => {
      const text = rewriteWikiLinks(block.text, retarget);
      // Whoever wrote the block still did: only its link changed, and only its record follows.
      return text === block.text ? block : { ...block, hash: hashMarkdownBlock(text), text };
    }),
    agentBlocks: agentBlocks.map((hash) => renamed.get(hash) ?? hash),
  };
}
