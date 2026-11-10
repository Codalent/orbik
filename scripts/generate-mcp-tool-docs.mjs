/**
 * Writes docs/connect-your-ai/tools.md, the MCP tool reference, from what the server itself lists.
 *
 * Nothing here restates a tool. The real server (`backend/src/mcp/server.js`) is built for each of
 * the four surfaces a credential can be shown — one workspace or several, reading or also writing —
 * and asked for `tools/list`, `resources/templates/list` and `resources/list` exactly as a client
 * asks. Each description is the one the model is given, so the page cannot describe a tool the way
 * no client sees it. No database is touched: listing builds the server and calls nothing.
 *
 *   node scripts/generate-mcp-tool-docs.mjs           # write the page
 *   node scripts/generate-mcp-tool-docs.mjs --check   # exit 1 if the page on disk is out of date
 *
 * `pnpm docs:tools` runs the first; the lint runs the second.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the page is written. */
export const OUTPUT = join(root, "docs", "connect-your-ai", "tools.md");

/** Stand-ins for the workspaces a credential reads. Only their shape matters: none of them is shown. */
const FIRST = Object.freeze({
  id: "000000000000000000000001",
  name: "Example",
  websiteUrl: "https://example.com",
  host: "example.com",
  role: "owner",
});
const SECOND = Object.freeze({ ...FIRST, id: "000000000000000000000002", name: "Other", websiteUrl: "https://other.example", host: "other.example" });

/** The four surfaces, as `mcpService.openSession` would describe each kind of credential. */
const SESSIONS = Object.freeze({
  pinned: { roaming: false, mayWrite: false, workspaces: [FIRST], workspace: FIRST },
  roaming: { roaming: true, mayWrite: false, workspaces: [FIRST, SECOND], workspace: null },
  pinnedWriter: { roaming: false, mayWrite: true, workspaces: [FIRST], workspace: FIRST },
  roamingWriter: { roaming: true, mayWrite: true, workspaces: [FIRST, SECOND], workspace: null },
});

/** The tools that are not the registry's: ChatGPT's pair, and the one only a roaming credential has. */
const SEARCH_AND_FETCH = Object.freeze(["search", "fetch"]);
const WORKSPACE_LIST = "workspace_list";

/**
 * Asks the real server for each surface's tools and resources.
 *
 * @returns {Promise<Record<keyof SESSIONS, {version: string, tools: object[], templates: object[], resources: object[]}>>}
 */
export async function readSurfaces() {
  const { buildMcpHandler } = await import(pathToFileURL(join(root, "backend", "src", "mcp", "server.js")).href);
  // The SDK warns, once, that JSON responses drop mid-call notifications. True, and beside the
  // point for a listing; it would only be noise in the lint's output.
  const warn = console.warn;
  console.warn = (...args) => {
    if (!String(args[0] ?? "").startsWith("responseMode: 'json'")) warn(...args);
  };
  try {
    const handler = buildMcpHandler({
      mcpService: {},
      appOrigin: "https://orbik.example.com",
      logger: () => {},
      writeLimit: { take: async () => ({ allowed: true, retryAfterSeconds: 0 }) },
    });
    const surfaces = {};
    for (const [name, shape] of Object.entries(SESSIONS)) {
      const session = {
        userId: "docs",
        tokenId: "docs",
        scopes: shape.mayWrite ? ["orbik:read", "orbik:write"] : ["orbik:read"],
        client: null,
        kind: "token",
        ...shape,
      };
      const ask = (method, params = {}) => request(handler, session, method, params);
      const init = await ask("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "docs", version: "0" } });
      surfaces[name] = {
        version: init.serverInfo.version,
        tools: (await ask("tools/list")).tools,
        templates: (await ask("resources/templates/list")).resourceTemplates ?? [],
        resources: (await ask("resources/list")).resources ?? [],
      };
    }
    await handler.close?.();
    return surfaces;
  } finally {
    console.warn = warn;
  }
}

/** One JSON-RPC request through the handler, authenticated as the route would authenticate it. */
async function request(handler, session, method, params) {
  const body = { jsonrpc: "2.0", id: 1, method, params };
  const response = await handler.fetch(
    new Request("https://orbik.example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    }),
    { authInfo: { token: "docs", clientId: "docs", scopes: session.scopes, extra: { session, calledTools: [] } }, parsedBody: body },
  );
  const text = await response.text();
  // Either a JSON body or one server-sent event carrying it.
  const data = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("");
  const message = JSON.parse(data || text);
  if (message.error) throw new Error(`${method} failed: ${message.error.message}`);
  return message.result;
}

// --- Markdown ---------------------------------------------------------------------------------

/**
 * A description as Markdown text: one paragraph, its `code spans` kept, and everything outside them
 * that Markdown would read as markup escaped — `<workspace id>` would otherwise be raw HTML, and a
 * placeholder such as https://exact/url a link to nowhere.
 */
function inline(text, { table = false } = {}) {
  return String(text ?? "")
    .replace(/\s*\n\s*/g, " ")
    .trim()
    .split(/(`[^`]*`)/)
    .map((part, index) => {
      const escaped = index % 2 === 1 ? part : part.replace(/([\\*[\]<>])/g, "\\$1").replace(/:\/\//g, "\\://");
      // A pipe ends a table cell even inside a code span, so it is escaped in both.
      return table ? escaped.replace(/\|/g, "\\|") : escaped;
    })
    .join("");
}

const code = (value) => `\`${value}\``;

/** A list read as prose: `a`, `b` and `c`. */
function listOf(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** How many items an array takes, as a short note. */
function itemLimits(schema) {
  const { minItems: min, maxItems: max } = schema;
  if (min && max) return ` (${min}–${max})`;
  if (max) return ` (up to ${max})`;
  if (min) return ` (at least ${min})`;
  return "";
}

/** An argument's type, as a person reads it. */
function typeOf(schema) {
  if (schema.enum) return `one of ${schema.enum.map(code).join(", ")}`;
  if (schema.type === "array") {
    const items = schema.items ?? {};
    const of = items.enum
      ? items.enum.map(code).join(", ")
      : items.type === "object"
        ? "objects"
        : `${items.type ?? "value"}s`;
    return `list of ${of}${itemLimits(schema)}`;
  }
  const length = schema.maxLength ? `, up to ${schema.maxLength} characters` : "";
  return `${schema.type ?? "any"}${length}`;
}

/** The rows of an arguments table, nested objects in a list flattened as `name[].field`. */
function argumentRows(schema, { prefix = "", skip = [], other = null } = {}) {
  const required = new Set(schema.required ?? []);
  const rows = [];
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (skip.includes(name)) continue;
    const otherProperty = other?.properties?.[name];
    let description = inline(property.description, { table: true });
    if (otherProperty?.description && otherProperty.description !== property.description) {
      description += ` On a connection that reads several workspaces: ${inline(otherProperty.description, { table: true })}`;
    }
    rows.push(`| ${code(prefix + name)} | ${typeOf(property)} | ${required.has(name) ? "yes" : "no"} | ${description} |`);
    if (property.type === "array" && property.items?.type === "object") {
      rows.push(...argumentRows(property.items, { prefix: `${prefix}${name}[].`, other: otherProperty?.items ?? null }));
    }
  }
  return rows;
}

/** One tool's section: its description as the model gets it, then its arguments. */
function toolSection(tool, { other = null } = {}) {
  const lines = [`### ${tool.name}`, "", inline(tool.description), ""];
  if (other && other.description !== tool.description) {
    lines.push(`On a connection that reads several workspaces: ${inline(other.description)}`, "");
  }
  if (tool.annotations?.destructiveHint) {
    lines.push("Clients are told this tool can replace what is already there (`destructiveHint`), so one that asks before such a change asks here.", "");
  }
  const rows = argumentRows(tool.inputSchema ?? {}, { skip: ["workspace"], other: other?.inputSchema ?? null });
  if (rows.length) {
    lines.push("| Argument | Type | Required | Description |", "| --- | --- | --- | --- |", ...rows, "");
  } else {
    lines.push("No arguments.", "");
  }
  return lines;
}

/** The URI, title and description of each resource or template, as table rows. */
function resourceRows(entries) {
  return entries.map((entry) => {
    const address = entry.uriTemplate ?? entry.uri;
    const type = entry.mimeType ? code(entry.mimeType) : "the image's own";
    return `| ${code(address)} | ${inline(entry.title ?? entry.name, { table: true })} | ${inline(entry.description, { table: true })} | ${type} |`;
  });
}

/**
 * The page, from the four surfaces.
 *
 * @param {Awaited<ReturnType<typeof readSurfaces>>} surfaces
 */
export function renderToolDocs(surfaces) {
  const { pinned, roaming, pinnedWriter, roamingWriter } = surfaces;
  const names = (surface) => surface.tools.map((tool) => tool.name);
  const pinnedNames = new Set(names(pinned));
  const added = (surface) => names(surface).filter((name) => !pinnedNames.has(name)).map(code);
  const byName = (surface, name) => surface.tools.find((tool) => tool.name === name) ?? null;

  const readTools = pinned.tools.filter((tool) => !SEARCH_AND_FETCH.includes(tool.name));
  const writeTools = pinnedWriter.tools.filter((tool) => !pinnedNames.has(tool.name));
  const workspaceList = byName(roaming, WORKSPACE_LIST);

  // What `workspace` means, per distinct wording, with the tools that carry it.
  const workspaceArgument = new Map();
  for (const tool of [...roaming.tools, ...roamingWriter.tools.filter((tool) => !pinnedNames.has(tool.name))]) {
    const description = tool.inputSchema?.properties?.workspace?.description;
    if (!description) continue;
    if (!workspaceArgument.has(description)) workspaceArgument.set(description, new Set());
    workspaceArgument.get(description).add(tool.name);
  }

  // What a roaming connection lists once per workspace, named by the template each listing is of
  // (a listing's own title carries the workspace's name).
  const templateOf = (uri) =>
    roaming.templates.find((template) => template.uriTemplate === uri.replace(/^orbik:\/\/w\/[^/]+\//, "orbik://w/{workspaceId}/"));
  const roamingListed = [...new Set(roaming.resources.map((resource) => templateOf(resource.uri)?.title).filter(Boolean))];

  const lines = [
    "# MCP tool reference",
    "",
    "Every tool and resource Orbik's MCP server offers your AI, with each description exactly as the",
    "server gives it to the model that calls it.",
    "",
    "> [!NOTE]",
    `> This page is generated from the server's own tool list by`,
    `> [${relative(root, join(root, "scripts", "generate-mcp-tool-docs.mjs"))}](../../scripts/generate-mcp-tool-docs.mjs).`,
    "> After changing a tool, run `pnpm docs:tools` rather than editing the page by hand.",
    "",
    "The descriptions are written for the model, not for you: they tell it when to call each tool and",
    "what to do with the answer. Tool names use underscores, so in Claude Code, with the server added",
    "as `orbik`, `library_tree` is `mcp__orbik__library_tree`. What a connection is shown depends on",
    "the credential it holds; see [Connect your AI](README.md).",
    "",
    "## What a connection sees",
    "",
    "The server version changes when what a connection is shown changes, not with each release of",
    "Orbik.",
    "",
    "| Connection | Tools | Server version |",
    "| --- | --- | --- |",
    `| Reads one workspace | ${pinned.tools.length} tools: the read tools, ${code("search")} and ${code("fetch")} | ${code(pinned.version)} |`,
    `| Reads several workspaces | the same, each but ${code("fetch")} with a ${code("workspace")} argument, plus ${listOf(added(roaming))} | ${code(roaming.version)} |`,
    `| Reads one workspace and may write | the same as one workspace, plus ${listOf(added(pinnedWriter))} | ${code(pinnedWriter.version)} |`,
    `| Reads several workspaces and may write | the same as several, plus ${listOf(added(roamingWriter).filter((name) => !added(roaming).includes(name)))} | ${code(roamingWriter.version)} |`,
    "",
    "A refusal — no index yet, a path that does not exist, a write the connection may not make — comes",
    "back as a tool result marked as an error, with a `code` and a `message` the model can read and",
    "pass on, rather than as a protocol error the model never sees.",
    "",
    "## Read tools",
    "",
    "Every connection has these. They only read.",
    "",
    ...readTools.flatMap((tool) => toolSection(tool)),
    "## search and fetch",
    "",
    "The two tools in the shape ChatGPT's deep research and company knowledge require. They read",
    "the same knowledge as the tools above: `search` finds sources by meaning and `fetch` opens one.",
    "A client that can use `content_search` gets the passages themselves from it in one call.",
    "",
    ...SEARCH_AND_FETCH.flatMap((name) => toolSection(byName(pinned, name), { other: byName(roaming, name) })),
    "## Write tools",
    "",
    "Only on a connection the person allowed to write to the Library (the `orbik:write` scope). A",
    "connection without it is not shown these, and one that calls them anyway is answered",
    "`WRITE_NOT_GRANTED`. A write is the person's own, and every file keeps its earlier versions.",
    "",
    ...writeTools.flatMap((tool) => toolSection(tool)),
    "## Workspaces",
    "",
    "Only on a connection that reads several workspaces.",
    "",
    ...(workspaceList ? toolSection(workspaceList) : []),
    "### The workspace argument",
    "",
    "Every tool except `fetch` and `workspace_list` takes `workspace` on such a connection. It is",
    "optional in the schema, but every tool except `search` refuses a call without it",
    "(`WORKSPACE_REQUIRED`), and a workspace the connection does not read is refused",
    "(`WORKSPACE_NOT_ALLOWED`); both answers list the choices. `fetch` reads the workspace from the id",
    "`search` gave.",
    "",
    "| Tools | What it means |",
    "| --- | --- |",
    ...[...workspaceArgument].map(([description, tools]) => `| ${[...tools].map(code).join(", ")} | ${inline(description, { table: true })} |`),
    "",
    "## Resources",
    "",
    "For clients that attach a file to a conversation rather than call a tool. The Library's files are",
    "not listed, since a Library has hundreds; a client that knows a path can read it.",
    "",
    "### Reading one workspace",
    "",
    "| Address | Name | What it is | Type |",
    "| --- | --- | --- | --- |",
    ...resourceRows([...pinned.resources, ...pinned.templates]),
    "",
    "### Reading several workspaces",
    "",
    "Addressed under the workspace's id. A workspace the connection does not read is refused.",
    roamingListed.length ? `${listOf(roamingListed)} are listed once for each workspace.` : "",
    "",
    "| Address | Name | What it is | Type |",
    "| --- | --- | --- | --- |",
    ...resourceRows(roaming.templates),
    "",
  ];
  return `${lines.filter((line, index) => !(line === "" && lines[index - 1] === "")).join("\n").trimEnd()}\n`;
}

async function main() {
  const check = process.argv.includes("--check");
  const page = renderToolDocs(await readSurfaces());
  const where = relative(process.cwd(), OUTPUT);
  if (check) {
    let current = null;
    try {
      current = readFileSync(OUTPUT, "utf8");
    } catch {
      // Missing counts as out of date.
    }
    if (current !== page) {
      console.error(`${where} is out of date with the MCP server's tools. Run \`pnpm docs:tools\` and commit the result.`);
      process.exit(1);
    }
    console.log(`${where} is up to date.`);
    return;
  }
  writeFileSync(OUTPUT, page);
  console.log(`Wrote ${where}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
