import { TOOLS, toolAlias } from "@orbik/tools";

/**
 * The registry tools an outside client may call, in the order they are advertised.
 *
 * Read-only, and a deliberate subset rather than "everything that does not write". `content.*`'s
 * two listing tools and `content.review` are missing because they require `scope.agentSlug`: each
 * labels pages with one agent's verdicts and writes to that agent's own ledger, and an outside
 * client belongs to no agent. `crawl.*` and `knowledge.*` describe the machinery that produced the
 * knowledge rather than the knowledge itself, which is not what a client connects for.
 *
 * The `brand.*` tools are the design system: how the company looks, where the rest of this
 * surface is what it says. They are reads like the others — the system is corrected on the Brand
 * page, never from here — and they are listed last so the tools a client already cached keep
 * their places.
 *
 * The order is fixed because a client caches the list, and a list whose order moved between two
 * requests would look like the server had changed.
 */
export const MCP_READ_TOOLS = Object.freeze([
  "library.tree",
  "library.read",
  "library.search",
  "content.search",
  "content.readPages",
  "llms.read",
  "brand.get",
  "brand.tokens",
  "brand.render",
  "brand.assets",
  "brand.asset",
]);

/**
 * The registry tools a credential holding `orbik:write` may also call, in the order they are
 * advertised: after everything else, so the tools a client cached keep their places.
 *
 * Writing a file and making a folder, and nothing else. Moving and deleting are left to the Library
 * page: they are the two actions with no undo for a folder, and a revision is what makes a write
 * safe to hand to somebody's AI — every file keeps its last twenty versions. A write here is the
 * person's own (`mcpService.writerFor`), so what it adds is protected from Orbik's agents exactly
 * as a save from the Library page is.
 */
export const MCP_WRITE_TOOLS = Object.freeze(["library.write", "library.mkdir"]);

/**
 * Sentences in the registry's own descriptions that only make sense inside an agent run, and what
 * an outside client should be told instead.
 *
 * Each `find` must appear verbatim in the tool's description or this module throws at import — so
 * editing a tool's wording in `@orbik/tools` fails the API's startup rather than quietly leaving a
 * client told to call a tool that is not on this surface, or told about a reading budget that does
 * not exist here. That is the same bargain the schemas make: refuse to advertise a tool half
 * described.
 */
const AMENDMENTS = Object.freeze({
  "content.readPages": [
    {
      find: "given their exact URLs from content.listPages",
      replace: "given their exact URLs, as each `content_search` result reports in its `url`",
    },
    {
      find: "A run has a ceiling on how much of a site it may read in total; the reply says how much is left.",
      replace:
        "There is no wider reading budget here: the 15,000 characters a call is the whole ceiling, " +
        "and you may call again straight away for the next pages.",
    },
  ],
  "content.search": [
    {
      find: "Open a page with content.readPages, or a Library file with library.read, only when the passages do not settle the question.",
      replace:
        "Open a page with content_readPages, or a Library file with library_read, only when the " +
        "passages do not settle the question. If this returns an error saying the index is " +
        "unavailable, fall back to library_search, which needs no index.",
    },
  ],
  "library.search": [
    {
      find: "open the ones worth reading with library.read.",
      replace: "open the ones worth reading with library_read.",
    },
  ],
  "llms.read": [
    {
      find: "Read the llms.txt file this agent maintains for the site, or find out that there is none yet. Always call this first: an update should keep the sections that still make sense.",
      replace:
        "Read the llms.txt file Orbik maintains for this site, or find out that there is none yet. " +
        "It is the short, hand-publishable map of the site written for language models.",
    },
  ],
  // The brand tools point at each other by name, and here every name is its alias.
  "brand.get": [
    {
      find: "For the same system as design tokens call brand.tokens; as CSS, a Tailwind theme, a DESIGN.md or an image prompt call brand.render; for more of the company's own images call brand.assets.",
      replace:
        "For the same system as design tokens call brand_tokens; as CSS, a Tailwind theme, a DESIGN.md or an image " +
        "prompt call brand_render; for more of the company's own images call brand_assets.",
    },
  ],
  "brand.tokens": [
    { find: "for reading the system yourself, brand.get is smaller and says more.", replace: "for reading the system yourself, brand_get is smaller and says more." },
  ],
  "brand.assets": [
    { find: "to look at one yourself, call brand.asset with its id.", replace: "to look at one yourself, call brand_asset with its id." },
  ],
  "brand.asset": [
    { find: "Use an id from brand.get or brand.assets.", replace: "Use an id from brand_get or brand_assets." },
  ],
  // The write tools were written for an agent, whose writes the store checks against what a person
  // wrote. Here the writer *is* the person, so nothing refuses a version that leaves something out:
  // the description says so, and says what the safeguards in its place are.
  "library.write": [
    {
      find:
        "`sources` are what it is built from, as {\"kind\": \"page\", \"ref\": \"https://exact/url\"}; " +
        "citing them marks those pages reviewed at their current content, which is how the next run " +
        "knows what changed.",
      replace:
        "`sources` are optional: the pages of the site the text is grounded in, as " +
        "{\"kind\": \"page\", \"ref\": \"https://exact/url\"}, each the `url` a content_search result " +
        "reports. Text the person decided on — a bio they chose, a decision they made — needs none. " +
        "They replace the file's own, so when you rewrite a file that cites pages, send back the " +
        "`sources` library_read gave you, each as {\"kind\": \"page\", \"ref\": <its url>}.",
    },
    {
      find: "Keep every block a person wrote: the call is refused, and names the text, if your version drops one.",
      replace:
        "Read the file with library_read first and keep everything in it you were not asked to " +
        "change: this write is recorded as the person's own, so whatever you leave out is recorded " +
        "as their deletion, and nothing refuses it.",
    },
    {
      find: "Write the overview and the index at the `overviewPath` and `indexPath` library.tree gives.",
      replace:
        "The overview and the index are the files at the `overviewPath` and `indexPath` library_tree " +
        "gives; change them only when the person asks.",
    },
    {
      find: "Nothing is written at the top level itself: every file goes inside one of its folders.",
      replace:
        "Nothing is written at the top level itself: every file goes inside one of the folders the " +
        "company chose, which library_tree lists. Nothing is written under /sources or /brand, or " +
        "inside a locked file or folder. Write what the person asked you to keep, not what you " +
        "inferred, and prefer a new file, or a new section of an existing one, to restating a file " +
        "written from the site. Say in your reply which path you wrote.",
    },
  ],
  "library.mkdir": [
    {
      find:
        "Create a folder only when nothing that exists fits, and only inside one of the top-level " +
        "folders: the top level is the person's, and a folder there is refused (TOP_LEVEL_PROTECTED).",
      replace:
        "Create a folder only when nothing that exists fits — library_tree lists what does — and only " +
        "inside one of the top-level folders: the top level is the person's, and a folder there is " +
        "refused (TOP_LEVEL_PROTECTED). Say in your reply which path you created.",
    },
  ],
});

/**
 * The same, for a sentence inside a tool's input schema: an argument's description that names a
 * tool this surface does not have. Each entry is the path to a `description` and the sentence in
 * it, and it throws at import when the sentence is gone, as the descriptions' amendments do.
 */
const SCHEMA_AMENDMENTS = Object.freeze({
  "library.write": [
    {
      at: ["properties", "sources", "items", "properties", "ref", "description"],
      find: "The exact page URL from content.listPages.",
      replace: "The exact page URL, as a content_search result reports it in `url`.",
    },
  ],
  "library.mkdir": [
    {
      at: ["properties", "listing", "description"],
      find: "as content.siteMap gives it under `listings`",
      replace: "as the site itself or a content_search result gives it",
    },
  ],
});

/**
 * Arguments a write tool's schema requires of an agent that an outside client may leave out.
 *
 * `sources`: an agent always says what a file was written from, if only `[]`; a person bringing
 * back what they decided has nothing to cite, and the registry reads an absent list as empty.
 */
const OPTIONAL_HERE = Object.freeze({ "library.write": ["sources"] });

/**
 * How a client is told what each write tool does to what is there, so one that asks a person
 * before anything destructive asks before a whole file is replaced.
 */
const WRITE_ANNOTATIONS = Object.freeze({
  "library.write": Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }),
  "library.mkdir": Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
});

/**
 * The tools this server advertises: alias, description and JSON schema, resolved once at import.
 *
 * `toolAlias` swaps the registry name's dot for an underscore, so a Claude Code user calls
 * `mcp__orbik__content_search`. Keeping one naming rule matters more than a prettier `content_read_pages`: two spellings of one
 * tool is a support conversation waiting to happen.
 */
export const MCP_TOOL_SURFACE = Object.freeze(
  MCP_READ_TOOLS.map((name) => {
    const tool = TOOLS[name];
    if (!tool) {
      throw new Error(`The MCP surface names a tool this build does not provide: ${name}.`);
    }
    return Object.freeze({
      name,
      alias: toolAlias(name),
      description: amend(name, tool.description),
      inputSchema: tool.inputSchema,
    });
  }),
);

/**
 * The write tools, as a credential holding `orbik:write` is shown them: alias, description,
 * schema and annotations, resolved once at import like the read surface.
 *
 * The schema is a copy of the registry's with its amendments applied, so the registry's
 * definition — what every agent run is shown — is untouched.
 */
export const MCP_WRITE_SURFACE = Object.freeze(
  MCP_WRITE_TOOLS.map((name) => {
    const tool = TOOLS[name];
    if (!tool) {
      throw new Error(`The MCP surface names a tool this build does not provide: ${name}.`);
    }
    return Object.freeze({
      name,
      alias: toolAlias(name),
      description: amend(name, tool.description),
      inputSchema: amendSchema(name, tool.inputSchema),
      annotations: WRITE_ANNOTATIONS[name],
    });
  }),
);

/** The write tools' advertised names, for telling a call to one apart from a read. */
export const MCP_WRITE_ALIASES = Object.freeze(new Set(MCP_WRITE_SURFACE.map((tool) => tool.alias)));

/**
 * Wraps a tool's result the way every current client reads one.
 *
 * Both `structuredContent` and a JSON text block, not one or the other: ChatGPT reads the text,
 * newer clients read the structured value, and a server that sent only one of them works in half
 * the places it was configured.
 *
 * The text is JSON without indentation. It is read by a model, which parses either as well, and
 * the indentation was a third of what a listing cost: a client that cut a long answer off cut it
 * off that much sooner.
 */
export function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

/**
 * Wraps the result of a tool that returns a picture, so a client that can look at one does.
 *
 * `brand_asset` answers with an image, which is the first thing on this surface that is not text.
 * The tool hands back the facts about the asset and, under `inline`, the asset itself; here that
 * becomes a content block of its own — an image for a raster, the source as text for an SVG —
 * ahead of the facts, and is left out of `structuredContent`, which is for values a program reads
 * and would otherwise carry a megabyte of base64 twice.
 */
export function mediaResult(value) {
  const { inline, ...facts } = value;
  const blocks = [];
  if (inline?.type === "image") blocks.push({ type: "image", data: inline.data, mimeType: inline.mimeType });
  if (inline?.type === "text") blocks.push({ type: "text", text: inline.text });
  return {
    content: [...blocks, { type: "text", text: JSON.stringify(facts) }],
    structuredContent: facts,
  };
}

/**
 * Turns a refusal into a result the model can reason about, rather than a protocol error.
 *
 * `isError: true` with the code in the body, because a JSON-RPC error is something the client
 * handles and the model never sees — and `INDEX_UNAVAILABLE` or `CRAWL_NOT_CONFIGURED` is precisely
 * what the model needs to say to the person. It is the same reason the registry refuses instead of
 * returning an empty list: an empty result cannot be told apart from "the site does not say that".
 *
 * `WORKSPACE_REQUIRED` and `WORKSPACE_NOT_ALLOWED` come through here too, with `workspaces` listing
 * the choices a roaming credential has.
 */
export function toolFailure({ code, message, reason = null, detail = null, workspaces = null, retryAfterSeconds = null }) {
  return {
    ...toolResult({
      code,
      message,
      ...(reason ? { reason } : {}),
      ...(detail ? { detail } : {}),
      // Only on a refusal to pick a workspace: the choices, so the next call can name one.
      ...(workspaces ? { workspaces } : {}),
      // Only on a write past the write ceiling: how long until the next one is accepted.
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    }),
    isError: true,
  };
}

/**
 * Describes a search failure in terms of the tools this surface actually has.
 *
 * `content.search` is the one tool whose refusals name tools an outside client cannot call: written
 * for an agent inside a run, they send the reader to `content.listRoutes` and `content.listPages`,
 * which need an agent's verdict ledger and are therefore not advertised here. A model told to call a
 * tool that does not exist spends a turn finding out.
 *
 * So the message is this layer's, and the registry's own is kept as `detail` rather than discarded —
 * it is what says which of the vector store and the embedding provider refused. The alternative,
 * rewriting tool names inside somebody else's sentence, would break silently the next time that
 * sentence was edited.
 *
 * @param {object} failure
 * @param {string} failure.code the code the registry refused with
 * @param {string} failure.message the registry's message, kept as detail
 * @param {string | null} failure.reason why this API has no index at all, when that is the cause
 */
export function searchFailure({ code, message, reason }) {
  return toolFailure({
    code,
    message:
      "Search could not answer. Use library_search to find files by term and library_read to read " +
      "them: they read the Library directly and need no index. Say in your reply that search was " +
      "unavailable rather than answering as though the knowledge base were empty.",
    reason,
    detail: message,
  });
}

/**
 * The schema a roaming credential is shown for one tool: the registry's own, plus `workspace`.
 *
 * A copy, so the registry's frozen definition is untouched and a pinned credential keeps seeing it
 * exactly. `additionalProperties: false` stays, which is why the server strips `workspace` again
 * before handing the input to the registry: the registry validates on its own and would refuse a
 * field it does not know. The argument lives in this layer and not in `@orbik/tools` because no
 * Orbik agent takes one — an agent's workspace is its run's, closed over in the registry's scope.
 *
 * @param {object} inputSchema a JSON Schema object with `properties`
 * @param {string} description what `workspace` is, for this tool
 */
export function withWorkspaceArgument(inputSchema, description) {
  return {
    ...inputSchema,
    properties: {
      ...inputSchema.properties,
      workspace: { type: "string", maxLength: 200, description },
    },
  };
}

/**
 * The one tool only a roaming credential has: what it may read, so a model can choose.
 *
 * No arguments. Listed last, after `fetch`, so the tools a client cached keep their places.
 */
export const WORKSPACE_LIST_TOOL = Object.freeze({
  name: "workspace_list",
  description:
    "List the workspaces this connection may read: each one's id, name, website and host, and " +
    "whether its site has been crawled. Every other tool except fetch takes one of them as " +
    "`workspace` — its id, its host or its name.",
  inputSchema: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
});

/**
 * A copy of a tool's input schema with this surface's amendments applied: sentences in argument
 * descriptions rewritten, and arguments an outside client may leave out no longer required.
 */
function amendSchema(name, inputSchema) {
  const schema = structuredClone(inputSchema);
  for (const { at, find, replace } of SCHEMA_AMENDMENTS[name] ?? []) {
    const holder = at.slice(0, -1).reduce((node, key) => node?.[key], schema);
    const key = at.at(-1);
    if (typeof holder?.[key] !== "string" || !holder[key].includes(find)) {
      throw new Error(
        `${name}'s schema no longer contains the sentence the MCP surface rewrites for outside ` +
        `clients at ${at.join(".")}: "${find}". Update backend/src/mcp/tools.js to match.`,
      );
    }
    holder[key] = holder[key].replace(find, replace);
  }
  const optional = OPTIONAL_HERE[name] ?? [];
  if (optional.length) schema.required = (schema.required ?? []).filter((field) => !optional.includes(field));
  return schema;
}

/** Applies this surface's amendments, insisting every one of them still matches. */
function amend(name, description) {
  let text = description;
  for (const { find, replace } of AMENDMENTS[name] ?? []) {
    if (!text.includes(find)) {
      throw new Error(
        `${name}'s description no longer contains the sentence the MCP surface rewrites for ` +
        `outside clients: "${find}". Update backend/src/mcp/tools.js to match.`,
      );
    }
    text = text.replace(find, replace);
  }
  return text;
}
