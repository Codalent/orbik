import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceTemplate,
  createMcpHandler,
  fromJsonSchema,
} from "@modelcontextprotocol/server";
import { ORBIK_MCP_SERVER, ToolError } from "@orbik/tools";

import { mayWriteIn } from "./credentialWorkspaces.js";
import { buildInstructions } from "./instructions.js";
import { searchRecord } from "./mcpCallLog.js";
import { createSearchAndFetch } from "./searchAndFetch.js";
import {
  MCP_TOOL_SURFACE,
  MCP_WRITE_ALIASES,
  MCP_WRITE_SURFACE,
  WORKSPACE_LIST_TOOL,
  mediaResult,
  searchFailure,
  toolFailure,
  toolResult,
  withWorkspaceArgument,
} from "./tools.js";
import {
  WORKSPACE_ARGUMENT_DESCRIPTION,
  WORKSPACE_WRITE_ARGUMENT_DESCRIPTION,
  WorkspaceRefusal,
  chooseWorkspace,
  workspaceById,
} from "./workspaceChoice.js";
import { refuseReservedPath, roleInsufficient, takeWrite, writeNotGranted } from "./writes.js";

/** The two tools that go through the index, and so are the two whose refusals it can cause. */
const SEARCH_TOOLS = Object.freeze(new Set(["content_search", "search"]));

/**
 * The tools whose answer is a picture rather than only a value, and so is wrapped differently:
 * the image goes in a content block of its own, where a client that can look at one will.
 */
const MEDIA_TOOLS = Object.freeze(new Set(["brand_asset"]));

/**
 * The version this server reports. Bumped when the advertised surface changes, not per release —
 * which is why there are four, one per surface. A pinned credential's surface did not change when
 * sets of workspaces arrived, and it still reports the version it always did; a roaming
 * credential's surface is the one that gained `workspace` and `workspace_list`. A credential that
 * may write sees either of those plus the two Library write tools, and a version of its own, so an
 * app whose grant is re-approved with writing allowed — or without — sees its server change.
 */
const SERVER_VERSION = "1.1.0";
const ROAMING_SERVER_VERSION = "1.2.0";
const WRITER_SERVER_VERSION = "1.3.0";
const ROAMING_WRITER_SERVER_VERSION = "1.4.0";

/** The version one session's surface reports. */
function serverVersion(session) {
  if (session.mayWrite) return session.roaming ? ROAMING_WRITER_SERVER_VERSION : WRITER_SERVER_VERSION;
  return session.roaming ? ROAMING_SERVER_VERSION : SERVER_VERSION;
}

/** Every read tool's annotations. The write tools carry their own (`MCP_WRITE_SURFACE`). */
const READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });

/**
 * Builds the HTTP handler that serves this workspace knowledge base over MCP.
 *
 * One handler for the process, one `McpServer` per request. That is not an optimisation: the
 * 2026-07-28 specification removed protocol-level sessions, and a server with nothing held between
 * requests is what lets this endpoint sit behind nginx with no affinity and be revoked instantly —
 * there is no session to invalidate, because the next request re-reads the credential from scratch.
 *
 * The SDK is handed `authInfo` and verifies nothing itself. Authentication happens in front of it,
 * in the route, so a refusal is a plain HTTP `401` with a `WWW-Authenticate` challenge rather than
 * something wrapped in a JSON-RPC envelope that no client would treat as an auth failure.
 *
 * Legacy serving is left on (the SDK's default): today's Claude Code, Claude Desktop and ChatGPT
 * still open with the 2025 `initialize` handshake, and the same factory answers both eras, so the
 * two can never drift apart.
 *
 * @param {object} options collaborators
 * @param {object} options.mcpService opens sessions and builds registries
 * @param {string} options.appOrigin origin of the Orbik app, for the links Library citations carry
 * @param {(level: string, message: string, context?: object) => void} options.logger
 * @param {{take: (key: string) => Promise<{allowed: boolean, retryAfterSeconds: number}>}} options.writeLimit
 *   the per-credential ceiling on Library writes
 * @param {{record: (session: object, call: object) => Promise<void>} | null} [options.callLog]
 *   where each tool call is recorded (`mcpCallLog.js`); none, and nothing is
 */
export function buildMcpHandler({ mcpService, appOrigin, logger, writeLimit, callLog = null }) {
  return createMcpHandler(
    (ctx) => {
      const session = ctx.authInfo?.extra?.session;
      if (!session) {
        // Unreachable through the route, which refuses an unauthenticated request before the
        // handler sees it. Thrown rather than served empty so a future caller that forgets the
        // middleware gets a failure instead of a knowledge base belonging to nobody.
        throw new Error("The MCP handler was reached without a resolved session.");
      }
      const calledTools = ctx.authInfo?.extra?.calledTools ?? [];
      return buildServer({ session, calledTools, mcpService, appOrigin, logger, writeLimit, callLog });
    },
    {
      onerror: (error) => logger("warn", "mcp.request_failed", { message: error?.message ?? "unknown" }),
      // Nothing here streams: every tool answers in one result. A plain JSON body is what the most
      // clients and the most proxies handle without special configuration.
      responseMode: "json",
    },
  );
}

/**
 * Assembles one request's server: its instructions, its tools and its resources.
 *
 * Two surfaces, decided by the credential. A **pinned** one reads one workspace and is served
 * exactly what it was served before sets existed: same tools, same schemas, same resources, same
 * ids. A **roaming** one reads several, so every tool but `fetch` takes `workspace`, `workspace_list`
 * says what the choices are, and the resources are addressed under a workspace. Either way the
 * registry a call reads through is built for one member of the set this request materialised, and
 * built per call, so nothing a client sends can name a workspace outside it.
 *
 * A credential holding `orbik:write` is also shown `library_write` and `library_mkdir`, last. One
 * without it is shown exactly what it was shown before writing existed — but a call it makes to
 * either is still answered as a tool result the model reads, `WRITE_NOT_GRANTED`, rather than as
 * "no such tool": for a request that calls one, and only for it, the two are registered as
 * refusals. No list is served from such a request, so what a read-only client is listed is
 * untouched.
 */
function buildServer({ session, calledTools, mcpService, appOrigin, logger, writeLimit, callLog }) {
  const libraryUrl = (workspaceId, path) =>
    `${appOrigin}/workspaces/${workspaceId}/library?path=${encodeURIComponent(path ?? "/")}`;
  const report = (name, error, workspaceId) =>
    logger("warn", "mcp.tool_failed", {
      tool: name,
      workspaceId,
      message: error?.message ?? "unknown",
    });
  const refused = (name, error) => logger("info", "mcp.workspace_refused", { tool: name, code: error.code });
  // A write is the one thing this endpoint does that changes anything, so each is logged: which
  // tool, where, and what the store did. Never the text, and never the credential.
  const wrote = (name, workspaceId, written) =>
    logger("info", "mcp.library_written", {
      tool: name,
      workspaceId,
      kind: session.kind,
      path: written?.path ?? null,
      action: written?.action ?? null,
      revision: written?.revision ?? null,
    });
  // Every tool call, into `mcp_calls`. Not awaited: the log is never a reason for a call to wait
  // or fail, and it swallows its own failures.
  const logCall = (entry) => void callLog?.record(session, entry);
  const context = { session, mcpService, report, refused, wrote, logCall };

  const server = new McpServer(
    {
      name: ORBIK_MCP_SERVER,
      title: "Orbik knowledge base",
      version: serverVersion(session),
    },
    {
      instructions: buildInstructions({
        workspaces: session.workspaces,
        roaming: session.roaming,
        mayWrite: session.mayWrite,
      }),
    },
  );

  for (const tool of MCP_TOOL_SURFACE) {
    server.registerTool(
      tool.alias,
      {
        description: tool.description,
        // The registry's own JSON Schema, unconverted — or, for a roaming credential, a copy with
        // `workspace` added. `fromJsonSchema` hands the SDK the schema the model will see *and* the
        // validator the call is checked against, so the two cannot disagree — and the registry
        // validates independently afterwards, because an input that passed a schema is not proof
        // that anything checked it.
        inputSchema: fromJsonSchema(
          session.roaming ? withWorkspaceArgument(tool.inputSchema, WORKSPACE_ARGUMENT_DESCRIPTION) : tool.inputSchema,
        ),
        annotations: READ_ONLY,
      },
      (input, ctx) =>
        call(
          tool.alias,
          async (trace) => {
            // `workspace` is this layer's argument, not the registry's, and is removed before the
            // registry sees the input: its own validation would refuse a field it does not know.
            const { workspace: named, ...rest } = input ?? {};
            const workspace = chooseWorkspace(session, named);
            trace.workspaceId = workspace.id;
            const tools = await mcpService.registryFor(workspace);
            const answer = await tools.invoke(tool.name, session.roaming ? rest : input, ctx.mcpReq.signal);
            // What the AI asked and how much came back: the row the "What your AI asked" report reads.
            if (SEARCH_TOOLS.has(tool.alias)) trace.searches.push(searchRecord(workspace.id, rest.query, answer));
            return answer;
          },
          context,
          MEDIA_TOOLS.has(tool.alias) ? mediaResult : toolResult,
        ),
    );
  }

  registerSearchAndFetch({ server, libraryUrl, context });
  if (session.roaming) {
    server.registerTool(
      WORKSPACE_LIST_TOOL.name,
      {
        description: WORKSPACE_LIST_TOOL.description,
        inputSchema: fromJsonSchema(WORKSPACE_LIST_TOOL.inputSchema),
        annotations: READ_ONLY,
      },
      () => call(WORKSPACE_LIST_TOOL.name, () => mcpService.listWorkspaces(session), context),
    );
  }
  // Last, after `fetch` and `workspace_list`, so the tools a client cached keep their places.
  if (session.mayWrite) registerWriteTools({ server, context, writeLimit });
  else if (calledTools.some((name) => MCP_WRITE_ALIASES.has(name))) registerWriteRefusals({ server, context });

  if (session.roaming) registerRoamingResources({ server, libraryUrl, context });
  else registerResources({ server, libraryUrl, context });
  return server;
}

/**
 * Registers `library_write` and `library_mkdir` for a credential that may write.
 *
 * The registry is the whole implementation: these are `library.write` and `library.mkdir`, through
 * a registry whose scope writes as the person (`mcpService.writerFor`). What this layer adds is
 * what only it can decide — the credential's write ceiling, whether the person's role in the chosen
 * workspace lets them write on this request (`ROLE_INSUFFICIENT` when it is read-only), the paths
 * an outside client may not write to, and for a roaming credential which of its workspaces, taken
 * from `workspace` and stripped before the registry sees the input.
 */
function registerWriteTools({ server, context, writeLimit }) {
  const { session, mcpService, wrote } = context;
  for (const tool of MCP_WRITE_SURFACE) {
    server.registerTool(
      tool.alias,
      {
        description: tool.description,
        inputSchema: fromJsonSchema(
          session.roaming ? withWorkspaceArgument(tool.inputSchema, WORKSPACE_WRITE_ARGUMENT_DESCRIPTION) : tool.inputSchema,
        ),
        annotations: tool.annotations,
      },
      (input, ctx) =>
        call(
          tool.alias,
          async (trace) => {
            // Every call counts, whatever its answer: a client retrying a refused write in a loop
            // is exactly what the ceiling is for.
            await takeWrite(writeLimit, session);
            const { workspace: named, ...rest } = input ?? {};
            const workspace = chooseWorkspace(session, named);
            trace.workspaceId = workspace.id;
            if (!mayWriteIn(workspace)) throw roleInsufficient(workspace);
            refuseReservedPath(rest.path);
            const tools = await mcpService.writerFor(session, workspace);
            const written = await tools.invoke(tool.name, session.roaming ? rest : input, ctx.mcpReq.signal);
            wrote(tool.alias, workspace.id, written);
            return written;
          },
          context,
        ),
    );
  }
}

/**
 * Registers the write tools as refusals, for one request of a read-only credential that calls one.
 *
 * Any input is accepted, because the answer does not depend on it: this connection may not write,
 * and here is how the person would allow it.
 */
function registerWriteRefusals({ server, context }) {
  const { session } = context;
  for (const tool of MCP_WRITE_SURFACE) {
    server.registerTool(
      tool.alias,
      {
        description: tool.description,
        inputSchema: fromJsonSchema({ type: "object", additionalProperties: true }),
        annotations: tool.annotations,
      },
      () => call(tool.alias, async () => { throw writeNotGranted(session); }, context),
    );
  }
}

/**
 * Registers the two-tool surface ChatGPT and most agent frameworks insist on.
 *
 * Their schemas are written here rather than taken from a registry tool because the contract is
 * theirs, not Orbik's: the names, the field names and the result shape are fixed by what ChatGPT's
 * deep-research and company-knowledge readers accept. A roaming credential's `search` takes an
 * optional `workspace` and searches every workspace without one, and its `fetch` ids carry the
 * workspace; a pinned credential's pair is exactly what it always was.
 */
function registerSearchAndFetch({ server, libraryUrl, context }) {
  const { session, mcpService } = context;
  const adapters = createSearchAndFetch({
    session,
    registryFor: (workspace) => mcpService.registryFor(workspace),
    libraryUrl,
  });

  const searchSchema = {
    type: "object",
    properties: {
      query: { type: "string", description: "What you want to know, in words." },
    },
    required: ["query"],
    additionalProperties: false,
  };
  server.registerTool(
    "search",
    {
      description: session.roaming
        ? "Find the sources that answer a question in the knowledge bases this connection reads, by " +
          "meaning rather than by wording. Searches every workspace unless `workspace` names one. " +
          "Returns an id, a title and a URL for each; open one with fetch. Prefer content_search " +
          "when your client can use it — it returns the passages themselves."
        : "Find the sources in this knowledge base that answer a question, by meaning rather than by " +
          "wording. Returns an id, a title and a URL for each; open one with fetch. Prefer " +
          "content_search when your client can use it — it returns the passages themselves.",
      inputSchema: fromJsonSchema(
        session.roaming
          ? withWorkspaceArgument(
            searchSchema,
            "Optional: search only this workspace — its id, website host or name. Omit to search " +
              "every workspace this connection reads.",
          )
          : searchSchema,
      ),
      annotations: READ_ONLY,
    },
    (input, ctx) =>
      call(
        "search",
        (trace) =>
          adapters.search(input, ctx.mcpReq.signal, ({ workspace, answer, fanOut }) =>
            trace.searches.push(searchRecord(workspace.id, input?.query, answer, fanOut)),
          ),
        context,
      ),
  );

  server.registerTool(
    "fetch",
    {
      description:
        "Read one source in full, by an id that search returned. A Library file comes back as its " +
        "Markdown; a page comes back as the Markdown the crawler rendered from it.",
      inputSchema: fromJsonSchema({
        type: "object",
        properties: {
          id: {
            type: "string",
            description: session.roaming
              ? 'An id from search, shaped "library:<workspace id>:<path>" or "page:<workspace id>:<url>".'
              : 'An id from search, shaped "library:<path>" or "page:<url>".',
          },
        },
        required: ["id"],
        additionalProperties: false,
      }),
      annotations: READ_ONLY,
    },
    (input, ctx) => call("fetch", () => adapters.fetch(input, ctx.mcpReq.signal), context),
  );
}

/**
 * Registers the Library, llms.txt and the brand as resources, for clients that attach rather than
 * call — the pinned addresses, which name no workspace because the credential reads one.
 *
 * The templates list nothing: enumerating a Library of a few hundred files into every client's
 * resource picker would bury whatever the person was looking for, and `library_tree` is the tool
 * that answers "what is in here" properly. A client that knows a path can still read it.
 *
 * The brand has three. `orbik://brand` is the design system as one Markdown file — the thing to
 * attach to a conversation that is about to make something. `orbik://brand/tokens.json` is the
 * same system as design tokens. And `orbik://brand/assets/{id}` is one stored image as a blob,
 * which is the first resource here that is not text, addressed by the id brand_get and
 * brand_assets give each image.
 */
function registerResources({ server, libraryUrl, context }) {
  const { session, mcpService } = context;
  const registry = () => mcpService.registryFor(session.workspace);

  server.registerResource(
    "library-file",
    new ResourceTemplate("orbik://library{/path*}", { list: undefined }),
    { title: "Library file", description: "One Library file as Markdown.", mimeType: "text/markdown" },
    (uri, variables) =>
      read("orbik://library", context, async () =>
        readLibraryFile(await registry(), uri, variables.path, (path) => libraryUrl(session.workspace.id, path)),
      ),
  );

  server.registerResource(
    "llms-txt",
    "orbik://llms.txt",
    { title: "llms.txt", description: "The site's llms.txt, as Orbik maintains it.", mimeType: "text/plain" },
    (uri) => read("orbik://llms.txt", context, async () => readLlms(await registry(), uri)),
  );

  server.registerResource(
    "brand-design-md",
    "orbik://brand",
    { title: "Design system", description: "The company's design system as one Markdown file (DESIGN.md).", mimeType: "text/markdown" },
    (uri) => read("orbik://brand", context, async () => readDesignMd(await registry(), uri)),
  );

  server.registerResource(
    "brand-tokens",
    "orbik://brand/tokens.json",
    { title: "Design tokens", description: "The company's design system as design tokens (DTCG JSON).", mimeType: "application/json" },
    (uri) => read("orbik://brand/tokens.json", context, async () => readTokens(await registry(), uri)),
  );

  server.registerResource(
    "brand-asset",
    new ResourceTemplate("orbik://brand/assets/{id}", { list: undefined }),
    { title: "Brand image", description: "One of the company's stored images: a logo, an illustration, a photograph, an icon." },
    (uri, variables) =>
      read("orbik://brand/assets", context, async () => readAsset(await registry(), uri, firstOf(variables.id))),
  );
}

/**
 * Registers the same resources for a roaming credential, each addressed under a workspace:
 * `orbik://w/{workspaceId}/…`. The workspace in an address is checked against the set before
 * anything is read, exactly as a tool's `workspace` argument is.
 *
 * llms.txt, the design system and the tokens are listed once per workspace, which is what the
 * pinned surface lists for its one. The un-prefixed `orbik://brand/assets/{id}` is kept as well,
 * because an asset id names its own workspace: the image's row is read for its owner, and served
 * only if that owner is in the set.
 */
function registerRoamingResources({ server, libraryUrl, context }) {
  const { session, mcpService } = context;
  const member = async (variables) => {
    const workspace = workspaceById(session, firstOf(variables.workspaceId));
    return { workspace, tools: await mcpService.registryFor(workspace) };
  };
  const listEach = (suffix, describe) => async () => ({
    resources: session.workspaces.map((workspace) => ({
      uri: `orbik://w/${workspace.id}/${suffix}`,
      ...describe(workspace),
    })),
  });

  server.registerResource(
    "library-file",
    new ResourceTemplate("orbik://w/{workspaceId}/library{/path*}", { list: undefined }),
    { title: "Library file", description: "One Library file of one workspace, as Markdown.", mimeType: "text/markdown" },
    (uri, variables) =>
      read("orbik://w/library", context, async () => {
        const { workspace, tools } = await member(variables);
        return readLibraryFile(tools, uri, variables.path, (path) => libraryUrl(workspace.id, path));
      }),
  );

  server.registerResource(
    "llms-txt",
    new ResourceTemplate("orbik://w/{workspaceId}/llms.txt", {
      list: listEach("llms.txt", (workspace) => ({ name: `llms-txt-${workspace.id}`, title: `llms.txt — ${workspace.name}`, mimeType: "text/plain" })),
    }),
    { title: "llms.txt", description: "One workspace's llms.txt, as Orbik maintains it.", mimeType: "text/plain" },
    (uri, variables) => read("orbik://w/llms.txt", context, async () => readLlms((await member(variables)).tools, uri)),
  );

  server.registerResource(
    "brand-design-md",
    new ResourceTemplate("orbik://w/{workspaceId}/brand", {
      list: listEach("brand", (workspace) => ({ name: `brand-design-md-${workspace.id}`, title: `Design system — ${workspace.name}`, mimeType: "text/markdown" })),
    }),
    { title: "Design system", description: "One company's design system as one Markdown file (DESIGN.md).", mimeType: "text/markdown" },
    (uri, variables) => read("orbik://w/brand", context, async () => readDesignMd((await member(variables)).tools, uri)),
  );

  server.registerResource(
    "brand-tokens",
    new ResourceTemplate("orbik://w/{workspaceId}/brand/tokens.json", {
      list: listEach("brand/tokens.json", (workspace) => ({ name: `brand-tokens-${workspace.id}`, title: `Design tokens — ${workspace.name}`, mimeType: "application/json" })),
    }),
    { title: "Design tokens", description: "One company's design system as design tokens (DTCG JSON).", mimeType: "application/json" },
    (uri, variables) => read("orbik://w/brand/tokens.json", context, async () => readTokens((await member(variables)).tools, uri)),
  );

  server.registerResource(
    "brand-asset",
    new ResourceTemplate("orbik://w/{workspaceId}/brand/assets/{id}", { list: undefined }),
    { title: "Brand image", description: "One of a company's stored images: a logo, an illustration, a photograph, an icon." },
    (uri, variables) =>
      read("orbik://w/brand/assets", context, async () => readAsset((await member(variables)).tools, uri, firstOf(variables.id))),
  );

  server.registerResource(
    "brand-asset-by-id",
    new ResourceTemplate("orbik://brand/assets/{id}", { list: undefined }),
    { title: "Brand image", description: "One stored image, by the id brand_get or brand_assets gives it." },
    (uri, variables) =>
      read("orbik://brand/assets", context, async () => {
        const id = firstOf(variables.id);
        const owner = await mcpService.assetWorkspace(id);
        const workspace = session.workspaces.find((candidate) => candidate.id === owner);
        // An image in a workspace outside the set is answered exactly like one that does not exist,
        // so this address confirms nothing about anybody else's images.
        if (!workspace) throw coded("ASSET_MISSING", "There is no stored image with that id.");
        return readAsset(await mcpService.registryFor(workspace), uri, id);
      }),
  );
}

/** One Library file or folder, as a resource. */
async function readLibraryFile(tools, uri, segments, libraryUrlOf) {
  const path = `/${[].concat(segments ?? []).join("/")}`;
  const node = await tools.invoke("library.read", { path });
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "text/markdown",
        text: node.markdown ?? node.summary ?? "",
        _meta: { orbikPath: node.path, orbikUrl: libraryUrlOf(node.path) },
      },
    ],
  };
}

/** A workspace's llms.txt, or an empty file when it has none. */
async function readLlms(tools, uri) {
  const document = await tools.invoke("llms.read", {});
  return {
    contents: [
      { uri: uri.href, mimeType: "text/plain", text: document.exists ? document.content : "" },
    ],
  };
}

/** A workspace's design system as DESIGN.md. */
async function readDesignMd(tools, uri) {
  const rendered = await tools.invoke("brand.render", { format: "design-md" });
  return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: rendered.text }] };
}

/** A workspace's design system as DTCG tokens. */
async function readTokens(tools, uri) {
  const answer = await tools.invoke("brand.tokens", {});
  return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(answer.tokens, null, 2) }] };
}

/**
 * One stored image as a blob, or an SVG as text.
 *
 * Read through the tool, so the one rule about which images are served — never one set aside as
 * not the brand's own — is the tool's and is not written a second time here.
 */
async function readAsset(tools, uri, id) {
  const asset = await tools.invoke("brand.asset", { id: String(id ?? "") });
  if (asset.inline?.type === "image") return { contents: [{ uri: uri.href, mimeType: asset.mimeType, blob: asset.inline.data }] };
  if (asset.inline?.type === "text") return { contents: [{ uri: uri.href, mimeType: asset.mimeType, text: asset.inline.text }] };
  throw coded("ASSET_TOO_LARGE", "That image is too large to attach. Fetch it from the link brand_assets gives for it.");
}

/** The first value of a template variable, which the SDK hands over as a string or a list. */
function firstOf(value) {
  return [].concat(value ?? [])[0] ?? "";
}

/** An error carrying a code a caller may see. */
function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Reads one resource, keeping an uncoded failure's message out of the answer.
 *
 * A resource read *should* fail as a protocol error — unlike a tool call, the model is not the one
 * who asked, and a client attaching a file it cannot get needs an error, not a document saying so.
 * The refusals a caller may see are the coded ones: `NODE_MISSING`, `INVALID_PATH`, and for a
 * roaming credential `WORKSPACE_NOT_ALLOWED`, which carries its code and the choices as the
 * error's data.
 */
async function read(label, { session, report, refused }, run) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof WorkspaceRefusal) {
      refused(label, error);
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `${error.code}: ${error.message}`, {
        code: error.code,
        workspaces: error.workspaces,
      });
    }
    if (error instanceof ToolError || error?.code) throw error;
    report(label, error, session.workspace?.id ?? null);
    throw new Error("Something went wrong reading this workspace.");
  }
}

/**
 * Runs one tool call and turns whatever comes back into a result the model can use.
 *
 * Four kinds of failure, told apart on purpose. A refusal to pick a workspace —
 * `WORKSPACE_REQUIRED`, `WORKSPACE_NOT_ALLOWED` — becomes an `isError` result listing the choices,
 * so the model can name one on its next call. A `ToolError` and a scope error both carry a code
 * the model should read out — `INDEX_UNAVAILABLE`, `CRAWL_NOT_CONFIGURED`, `NODE_MISSING`,
 * `BRAND_NOT_DERIVED`, and for a write `WRITE_NOT_GRANTED`, `WRITE_RATE_LIMITED` (with
 * `retryAfterSeconds`), `ROLE_INSUFFICIENT`, `TOP_LEVEL_PROTECTED`, `RESERVED_PATH`, `NODE_LOCKED` — so they become an
 * `isError` result with that code in the body. Anything else has no code, which means
 * nobody wrote it for a reader: its message could be a driver's, a hostname's or a query's, so it
 * becomes one flat `UNEXPECTED_ERROR` and the detail stays in the process log.
 *
 * `run` is handed a trace to record the workspace it chose, so a failure is logged against the
 * workspace it happened in, and the searches it made. Whatever the answer, the call is then
 * recorded in `mcp_calls` with the code the client was answered with (`mcpCallLog.js`).
 */
async function call(name, run, { session, mcpService, report, refused, logCall }, wrap = toolResult) {
  const trace = { workspaceId: session.roaming ? null : session.workspace.id, searches: [] };
  const started = Date.now();
  let outcome = "ok";
  try {
    return wrap(await run(trace));
  } catch (error) {
    outcome = (error instanceof ToolError ? error.code : error?.code) || "UNEXPECTED_ERROR";
    if (error instanceof WorkspaceRefusal) {
      // Checked before the search tools' rewording below: a missing choice is not an index failure.
      refused(name, error);
      return toolFailure({ code: error.code, message: error.message, workspaces: error.workspaces });
    }
    const code = error instanceof ToolError ? error.code : error?.code;
    if (!code) {
      // The SDK would otherwise hand the raw message straight to the client, and an uncoded error's
      // message is whatever threw it — a driver, a hostname, a query. Reported to the process log
      // and replaced here, because a knowledge base is not the place to learn how it is deployed.
      report(name, error, trace.workspaceId);
      return toolFailure({
        code: "UNEXPECTED_ERROR",
        message: MCP_WRITE_ALIASES.has(name)
          ? "Something went wrong writing to this workspace's Library. Try again, or ask the person to check Orbik."
          : "Something went wrong reading this workspace. Try again, or ask the person to check Orbik.",
      });
    }
    report(name, error, trace.workspaceId);
    if (SEARCH_TOOLS.has(name)) {
      // Why the index is missing is recorded once, at startup, by `createRetrieval` — not by the
      // tool, which only knows that it has none. Attaching it here is what turns "search is
      // unavailable" into something a person can act on.
      return searchFailure({ code, message: error.message, reason: mcpService.retrievalReason?.message ?? null });
    }
    return toolFailure({ code, message: error.message, retryAfterSeconds: error.retryAfterSeconds ?? null });
  } finally {
    logCall?.({ tool: name, workspaceId: trace.workspaceId, outcome, durationMs: Date.now() - started, searches: trace.searches });
  }
}
