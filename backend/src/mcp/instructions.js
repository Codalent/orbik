import {
  BRAND_ROOT_PATH,
  SOURCE_ROOT_PATH,
  SOURCE_WEBSITE_PATH,
  USER_BLOCK_OPEN,
} from "@orbik/library";

import { mayWriteIn } from "./credentialWorkspaces.js";

/**
 * What the Library's subject files are written from, and where to go for the whole of a set.
 *
 * A subject file is a model's account of the pages chosen for it, and the choice is bounded: a
 * client that read the case-studies file of one workspace and reported its two customers as the
 * company's proof had not been told that fourteen more were posts the file was never written
 * from. Said once, in the same words to every credential.
 */
const COVERAGE_LINES = Object.freeze([
  `The subject files — everything outside ${SOURCE_ROOT_PATH} — are written by a model from a`,
  "selection of the site's pages, not from all of them, so a file on case studies or customers",
  "covers what it cites rather than every one the site has. For a count or a complete list, search",
  `with content_search or list the copies under ${SOURCE_WEBSITE_PATH} with library_tree (\`compact\`, then`,
  "`nextOffset` for the rest); each copy carries its page's `url` and the day it was `published`,",
  "and library_read takes a `url` to open one.",
]);

/**
 * How a credential that may write is told to, said once in the same words to every such credential
 * — pinned or roaming — and to no other. It replaces the closing line a read-only credential gets,
 * which says everything here is read-only.
 *
 * The write is the person's, so nothing in the store refuses a version that leaves something out:
 * this, and the tool's description, are what stand between a careless client and a file somebody
 * relies on. Hence the order: read first, keep what is there, file where the person's structure
 * says, say where. The revisions are the undo, and the person is told where to find them.
 */
const WRITE_LINES = Object.freeze([
  "This connection may also write to the Library, as the person it belongs to. When they ask you",
  "to save, document or remember something in Orbik, write it with library_write. Read the file",
  "first with library_read and keep everything in it you were not asked to change: what you write is",
  "recorded as theirs, and anything you leave out is recorded as deleted by them. Put it inside one",
  "of the top-level folders the company chose, in a new file or a new section of an existing one; if",
  "no folder fits, make one inside a top-level folder with library_mkdir. Write what the person said",
  "to keep, not what you inferred, and say which path you wrote. Do not rewrite a file Orbik wrote",
  "from the site unless the person asked for that file to change. Nothing can be written at the top",
  `level or under ${SOURCE_ROOT_PATH} or ${BRAND_ROOT_PATH}, and a locked file or folder is refused.`,
  "Every file keeps its earlier versions, which the person can restore on the Library page.",
]);

/** The last line a credential that may write is told, after anything about where it may not. */
const WRITE_COST_LINES = Object.freeze(["", "Reading and writing here cost nothing."]);

/**
 * What a credential that may write is told about the workspaces it covers where the person may not
 * write: their role there is read-only, so `library_write` and `library_mkdir` are refused there.
 *
 * Only for those workspaces, and only when there are any. A person's role is checked on every
 * write whatever the instructions say; this is so a client is not surprised by the refusal. A
 * credential that covers only workspaces the person may write in — every credential held by an
 * owner, and any member's that has not been demoted — is told nothing here, so its instructions
 * are exactly what they were before workspaces had members.
 *
 * @param {Array<{id: string, name: string, role?: string}>} workspaces the credential's set
 * @param {boolean} roaming whether it reads several
 * @returns {string[]}
 */
function readOnlyRoleLines(workspaces, roaming) {
  const readOnly = workspaces.filter((workspace) => !mayWriteIn(workspace));
  if (!readOnly.length) return [];
  if (!roaming) {
    return [
      "",
      "The person's role in this workspace is read-only, so library_write and library_mkdir are",
      "refused here with ROLE_INSUFFICIENT: say so rather than retrying. Reading is unaffected.",
    ];
  }
  const named = readOnly.map((workspace) => `${workspace.name} (id ${workspace.id})`).join(", ");
  const rest = readOnly.length === workspaces.length
    ? "Reading is unaffected."
    : "Writing works in the others, and reading in all of them.";
  return [
    "",
    `The person's role is read-only in ${named}, so library_write and library_mkdir are refused`,
    `there with ROLE_INSUFFICIENT: say so rather than retrying. ${rest}`,
  ];
}

/** The closing line of a credential that may only read. */
const READ_ONLY_LINE = "Everything here is read-only, and reading it costs nothing.";

/**
 * Writes the instructions this server announces itself with, for one workspace.
 *
 * Computed per credential rather than fixed, because the first useful thing a client can be told is
 * whose knowledge base this is: a model that knows it is reading Acme's own site will not hedge
 * about "a company like this", and a person watching the conversation can see immediately that the
 * connection points at the workspace they meant.
 *
 * The citation rule and the refusal rule are condensed from Orbik's own `library-chat` agent
 * (`packages/agent-definitions/src/libraryChat.js`), deliberately: an outside client reading this
 * knowledge base should behave the way Orbik's own reader does, and the failure that matters is
 * the same one — a model that answers from what companies like this usually do, when the knowledge
 * base simply does not cover it.
 *
 * The paragraph about the brand is there for the same failure in another form: a model asked for
 * a landing page that is not told a design system exists will invent a plausible one, and the
 * tool list alone does not say that `brand_get` is the thing to call *first*.
 *
 * A credential that reads several workspaces ("roaming") is told about every one of them instead,
 * and that each tool takes `workspace`: see {@link buildRoamingInstructions}. A credential that
 * reads one ("pinned") gets exactly the text it got before sets existed.
 *
 * A credential that may write gets {@link WRITE_LINES} in place of the closing line that says
 * everything is read-only; one that may not gets exactly the text it got before writing existed.
 * If it covers a workspace where the person's role is read-only it is also told that writes are
 * refused there ({@link readOnlyRoleLines}); otherwise nothing about roles is said.
 *
 * @param {object} options
 * @param {Array<{id: string, name: string, websiteUrl: string | null, host: string | null, role?: string}>} options.workspaces
 *   the workspaces the credential covers on this request — those the person can read, each with
 *   their role in it
 * @param {boolean} options.roaming whether the credential may read more than one
 * @param {boolean} [options.mayWrite] whether it may also write to the Library
 */
export function buildInstructions({ workspaces, roaming, mayWrite = false }) {
  const closing = mayWrite
    ? [...WRITE_LINES, ...readOnlyRoleLines(workspaces, roaming), ...WRITE_COST_LINES]
    : [READ_ONLY_LINE];
  if (roaming) return buildRoamingInstructions(workspaces, closing);
  const [workspace] = workspaces;
  const site = workspace.websiteUrl ? ` (${workspace.websiteUrl})` : "";

  return [
    `This is the Orbik knowledge base for ${workspace.name}${site}. It holds the Library — a tree of`,
    "Markdown files written from the company's own website, with a front page (the overview) and a",
    "map of what to read for which job (the index) — a copy of every crawled page under",
    `${SOURCE_WEBSITE_PATH}, word for word as Markdown, and the site's llms.txt.`,
    "",
    "Start with the index the tree root names: library_tree returns `indexPath` and `overviewPath`,",
    "then library_read that path — unless you already know where to look. Both live in the first",
    "top-level folder and move with it when it is renamed, so take them from the tree rather than",
    "assuming a path. Search by meaning with content_search: a question in your own words finds more",
    "than a keyword does, because the match is on meaning. Use library_search for a known term or",
    "title. Open a page with content_readPages only when a passage does not settle it. The top level",
    "of the Library is a few folders the company chose, usually numbered (\"00 Start Here\",",
    "\"02 Offer\"): the number is part of the name and of the path. A folder that lists `sourcePages`",
    `is showing pages of the site by reference: each is a file under ${SOURCE_WEBSITE_PATH}.`,
    "",
    "Every result carries `cite` — a page URL with its section anchor, or a Library path — and you",
    "should cite it. If a search returns nothing, say the knowledge base does not cover it rather than",
    "guessing from what companies like this usually do.",
    "",
    ...COVERAGE_LINES,
    "",
    `Blocks wrapped in \`${USER_BLOCK_OPEN}\` were written by a person and are ground truth; everything else`,
    "reports what the site says.",
    "",
    "It also holds how the company looks. Before you produce anything that has to look like this",
    "company — a page, a component, a slide, a graphic, an image — call brand_get: one call returns",
    "its colours, typefaces, spacing, components, rules, logo and reference images. Use those values",
    "exactly, use the logo file as it is, and for an image put the style prompt before your subject.",
    "If it says no design system has been derived, say so rather than inventing a brand.",
    "",
    ...closing,
  ].join("\n");
}

/**
 * The instructions for a credential that reads several workspaces.
 *
 * The first thing a client is told is still whose knowledge bases these are — every workspace by
 * name, host and id, so a model can pick one without a round trip — followed by the one new rule:
 * name the workspace on every call. The rest is the pinned guidance, reworded only where it said
 * "the company" as though there were one.
 *
 * @param {Array<{id: string, name: string, websiteUrl: string | null, host: string | null}>} workspaces
 * @param {readonly string[]} closing the closing lines: read-only, or how to write
 */
function buildRoamingInstructions(workspaces, closing) {
  const listed = workspaces.map(
    (workspace) => `- ${workspace.name}${workspace.host ? ` (${workspace.host})` : ""} — id ${workspace.id}`,
  );

  return [
    "This connection reads the Orbik knowledge bases of several workspaces, each built from one",
    "company's own website:",
    "",
    ...listed,
    "",
    "Every tool except fetch and workspace_list takes `workspace`: the id, the host or the exact name",
    "of one of these. Say which workspace on every call — a call without it is refused with the list",
    "of choices. workspace_list returns the same list with whether each site has been crawled.",
    "search is the exception: without `workspace` it searches all of them, and the ids it returns",
    "carry the workspace, so fetch needs nothing more.",
    "",
    "Each workspace holds the Library — a tree of Markdown files written from the company's own",
    "website, with a front page (the overview) and a map of what to read for which job (the index) —",
    `a copy of every crawled page under ${SOURCE_WEBSITE_PATH}, word for word as Markdown, and the`,
    "site's llms.txt.",
    "",
    "Start with the index the tree root names, in the workspace you need: library_tree returns",
    "`indexPath` and `overviewPath`, then library_read that path — unless you already know where to",
    "look. Both live in each Library's first top-level folder and move with it when it is renamed,",
    "so take them from the tree rather than assuming a path. Search by meaning with content_search: a",
    "question in your own words finds more than a keyword does, because the match is on meaning. Use",
    "library_search for a known term or title. Open a page with content_readPages only when a passage",
    "does not settle it. The top level of each Library is a few folders the company chose, usually",
    "numbered (\"00 Start Here\", \"02 Offer\"): the number is part of the name and of the path. A",
    "folder that lists `sourcePages` is showing pages of the site by reference: each is a file under",
    `${SOURCE_WEBSITE_PATH}.`,
    "",
    "Every result carries `cite` — a page URL with its section anchor, or a Library path — and you",
    "should cite it, saying which company it belongs to. If a search returns nothing, say the",
    "knowledge base does not cover it rather than guessing from what companies like this usually do.",
    "",
    ...COVERAGE_LINES,
    "",
    `Blocks wrapped in \`${USER_BLOCK_OPEN}\` were written by a person and are ground truth; everything else`,
    "reports what the site says.",
    "",
    "Each workspace also holds how its company looks. Before you produce anything that has to look",
    "like one of them — a page, a component, a slide, a graphic, an image — call brand_get with that",
    "workspace: one call returns its colours, typefaces, spacing, components, rules, logo and",
    "reference images. Use those values exactly, use the logo file as it is, and for an image put",
    "the style prompt before your subject. If it says no design system has been derived, say so",
    "rather than inventing a brand.",
    "",
    ...closing,
  ].join("\n");
}
