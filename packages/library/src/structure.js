import { LIBRARY_LIMITS, slugifySegment } from "./library.js";
import { BRAND_ROOT_PATH } from "./brand.js";
import { SOURCE_ROOT_PATH } from "./sourceLayer.js";
import { LIBRARY_STANDARD_FOLDER_NAMES } from "./vocabulary.js";

/**
 * The Library's top level: a few numbered folders a person chose, and three that code writes.
 *
 * Until version 9 of the knowledge agent the top level was a flat set of subject files and
 * folders — `/about`, `/services`, `/pricing` — that a person saw grouped under *sections*, which
 * were headings and never part of a path. Somebody looking at their Library saw a grouping they
 * could not open, rename or move, over paths they did not choose. Now the groups are the folders:
 * `00 Start Here`, `01 Company`, `02 Offer`, real nodes with paths that follow their titles
 * (`/02-offer/services/ai`), which a person renames and reorders like any other folder.
 *
 * **The number is a name, not a mechanism.** It is part of the title and therefore of the path,
 * and nothing reads it: order is the `order` field, and with none set the default sort happens to
 * put `00` before `01`. A person who renames `02 Offer` to `Offer` changes its path to `/offer`,
 * every link to it is rewritten, and nothing else moves.
 *
 * **The structure is the person's.** When a Library is first built — and again on a rebuild — a
 * model reads the site map and the core pages and proposes two or three variants of this list,
 * the person picks one and may edit it, and code creates exactly those folders, as theirs. The
 * write run files into them and may not create, rename, move or delete one: a top-level folder
 * nobody chose is the thing this replaces.
 *
 * **Two folders are not chosen.** `/brand` (the Design system agent's) and `/sources` (the
 * mirror's) are written by code, fixed in path and title, carry no number, and are shown after
 * the chosen folders by a fixed rank (`compareLibrarySiblings`). No group may take one of their
 * names.
 */

/**
 * The structure the suggestion starts from, and the shape every variant is written in.
 *
 * Groups are created only when the site has something for them: a site with no proof has no
 * `03`. `subjects` are the standard subject names (`./vocabulary.js`) filed into each; the start
 * group also holds the overview and the index, which are roles rather than subjects.
 */
export const DEFAULT_LIBRARY_STRUCTURE = Object.freeze([
  group("00 Start Here", ["open-questions"], "The overview, the index, and what the site leaves unanswered. Read this first.", true),
  group("01 Company", ["about", "team"], "Who the company is: its own account of itself, its people, where it is."),
  group("02 Offer", ["services", "products", "features", "pricing", "process", "faqs"], "What the company sells, what it costs, how it works with a customer, and what it answers."),
  group("03 Proof", ["case-studies", "customers", "testimonials"], "The evidence: work the site describes, named customers and what they say."),
  group("04 Market", ["buyers", "industries", "competitors"], "Who it sells to, the sectors it serves, and who it positions against."),
  group("05 Content", ["content"], "What the company publishes: the blog and other writing, by count, date and subject."),
]);

/** One group of a structure. */
function group(title, subjects, summary, start = false) {
  return Object.freeze({ title, subjects: Object.freeze(subjects), summary, ...(start ? { start: true } : {}) });
}

/** Top-level names no chosen folder may take: the code-written folders and the old entry points. */
const RESERVED_TOP_LEVEL = Object.freeze(new Set([
  SOURCE_ROOT_PATH,
  BRAND_ROOT_PATH,
  "/overview",
  "/index",
]));

/** The two entry points, which a proposal sometimes lists among a folder's subjects. */
const ENTRY_POINTS = Object.freeze(new Set(["overview", "index"]));

/** Bounds on a structure, beyond the group count and title length in `LIBRARY_LIMITS`. */
export const STRUCTURE_LIMITS = Object.freeze({
  subjects: 20,
  summary: LIBRARY_LIMITS.summary,
  variants: 3,
  variantName: 60,
  why: 400,
});

/**
 * Checks a structure a person or a model wrote, and returns it in the one shape everything stores.
 *
 * Each group's path is its title, slugified: `02 Offer` is `/02-offer`. Exactly one group is the
 * start group — the one marked `start`, or the first — which is where the overview and the index
 * are written. A subject may be in one group only; names outside the standard vocabulary are kept
 * (a site may have a subject the list lacks), as long as they are path segments.
 *
 * @param {unknown} input `{groups: [{title, summary?, subjects?, start?}]}` or the array itself
 * @returns {{groups: Array<{title: string, path: string, summary: string, subjects: string[], start: boolean}>, errors: string[]}}
 */
export function normalizeLibraryStructure(input) {
  const raw = Array.isArray(input) ? input : input?.groups;
  const errors = [];
  if (!Array.isArray(raw) || !raw.length || raw.length > LIBRARY_LIMITS.groups) {
    return { groups: [], errors: [`A structure has between 1 and ${LIBRARY_LIMITS.groups} folders.`] };
  }
  const paths = new Set();
  const filed = new Set();
  const groups = [];
  for (const [position, entry] of raw.entries()) {
    const title = String(entry?.title ?? "").replace(/\s+/g, " ").trim();
    const label = title || `Folder ${position + 1}`;
    if (!title || title.length > LIBRARY_LIMITS.groupTitle) {
      errors.push(`${label}: a folder's name is 1 to ${LIBRARY_LIMITS.groupTitle} characters.`);
      continue;
    }
    const segment = slugifySegment(title);
    if (!segment) {
      errors.push(`${label}: the name needs at least one letter or digit.`);
      continue;
    }
    const path = `/${segment}`;
    if (RESERVED_TOP_LEVEL.has(path)) {
      errors.push(`${label}: ${path} is kept for a folder Orbik writes itself. Choose another name.`);
      continue;
    }
    if (paths.has(path)) {
      errors.push(`${label}: two folders would both be ${path}. Give each its own name.`);
      continue;
    }
    paths.add(path);

    const subjects = [];
    for (const value of Array.isArray(entry?.subjects) ? entry.subjects.slice(0, STRUCTURE_LIMITS.subjects) : []) {
      const subject = slugifySegment(value);
      // The overview and the index are roles of the start folder, not subjects filed anywhere.
      if (!subject || filed.has(subject) || ENTRY_POINTS.has(subject)) continue;
      filed.add(subject);
      subjects.push(subject);
    }
    const summary = String(entry?.summary ?? "").replace(/\s+/g, " ").trim().slice(0, STRUCTURE_LIMITS.summary)
      || defaultSummary(subjects);
    groups.push({ title, path, summary, subjects, start: entry?.start === true });
  }
  const starts = groups.filter((entry) => entry.start);
  if (starts.length > 1) errors.push("Only one folder holds the overview and the index.");
  if (groups.length && !starts.length) groups[0].start = true;
  return { groups, errors };
}

/** What a folder holds, in a sentence, when nobody wrote one. */
function defaultSummary(subjects) {
  if (!subjects.length) return "A part of the business, as the people who run it think of it.";
  return `Holds ${subjects.join(", ")}.`;
}

/** Whether a name is one of the standard subjects, for a reader that wants to tell them apart. */
export function isStandardSubject(name) {
  return LIBRARY_STANDARD_FOLDER_NAMES.includes(name);
}

/**
 * The default structure as the lines a prompt or an agent's instructions carry.
 *
 * @returns {string}
 */
export function describeDefaultStructure() {
  return DEFAULT_LIBRARY_STRUCTURE
    .map((entry) => `${entry.title.padEnd(16)}${entry.start ? "overview · index · " : ""}${entry.subjects.join(" · ")}`)
    .join("\n");
}

/**
 * Where a workspace is in choosing its Library's structure, read from the knowledge agent's setup.
 *
 * The setup document carries `structure`:
 *
 * - `chosen` — `{groups, start, chosenAt, chosenBy}`: what the person confirmed, as
 *   `normalizeLibraryStructure` returns it.
 * - `rebuildRequestedAt` — a person asked to choose again. Later than `chosenAt`, the step is open
 *   again and the write run waits for the new choice.
 * - `suggestion` — `{status, variants, generatedAt, reason}`: what a model proposed, `pending`
 *   while the job that asks it is queued.
 *
 * One reading of it, shared by the scheduler that waits on the choice and the API that shows it,
 * so the page and the run can never disagree about whether the Library is waiting on a person.
 *
 * @param {object|null} setup the knowledge agent's setup document
 * @returns {{needsChoice: boolean, reason: "first"|"rebuild"|null, chosen: object|null, chosenAt: Date|null,
 *   suggestion: object|null, openedAt: Date|null}}
 */
export function libraryStructureState(setup) {
  const structure = setup?.structure ?? {};
  const chosen = Array.isArray(structure.chosen?.groups) && structure.chosen.groups.length ? structure.chosen : null;
  const chosenAt = chosen?.chosenAt ? new Date(chosen.chosenAt) : null;
  const rebuildAt = structure.rebuildRequestedAt ? new Date(structure.rebuildRequestedAt) : null;
  const rebuilding = Boolean(rebuildAt && (!chosenAt || rebuildAt > chosenAt));
  const needsChoice = !chosen || rebuilding;
  return {
    needsChoice,
    reason: needsChoice ? (rebuilding ? "rebuild" : "first") : null,
    chosen,
    chosenAt,
    suggestion: structure.suggestion ?? null,
    // The moment the step was opened: a suggestion older than this was made for an earlier choice.
    openedAt: rebuilding ? rebuildAt : null,
  };
}
