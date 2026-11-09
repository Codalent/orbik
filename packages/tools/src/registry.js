/**
 * Failure raised by the tool layer.
 *
 * Carries a stable `code` and nothing else, because a tool failure is handed back to a language
 * model as a tool result it has to reason about, where an ordinary `Error` would lose its
 * meaning. None of these are retryable: a malformed tool call and
 * a tool that does not exist fail identically however many times they are attempted.
 */
export class ToolError extends Error {
  /**
   * @param {object} options failure detail
   * @param {string} options.code stable upper-case code, e.g. `UNKNOWN_TOOL`
   * @param {string} options.message safe description; never include credentials
   */
  constructor({ code, message }) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.retryable = false;
  }
}

/**
 * Creates the set of tools one run may call, already scoped to that run's workspace.
 *
 * Two boundaries meet here, and both matter.
 *
 * **Authorization.** The scope is closed over at construction, not passed per call. A tool
 * therefore has no parameter that could name another workspace's site, which means an agent's
 * instructions cannot reach one however they are written — including instructions a model was
 * talked into by content it read on a crawled page. The definition's own `tools` array is a second
 * allow-list on top: an agent can only call what its definition declares.
 *
 * **Cost.** Every tool here is deterministic code over data the crawler already collected. Asking
 * a language model to count broken links, parse a sitemap, or extract a canonical tag would be
 * slower, more expensive, less reproducible, and worse at it. The model's job is to decide what
 * matters and explain why; the tools' job is to know what is true.
 *
 * @param {object} options collaborators
 * @param {object} options.tools tool definitions keyed by name, from {@link defineTool}
 * @param {object} options.scope the run's authorization scope
 * @param {import("mongodb").ObjectId} options.scope.workspaceId owning workspace
 * @param {import("mongodb").ObjectId} [options.scope.siteId] crawl site the run is about
 * @param {readonly string[]} options.allowed tool names this agent definition declares
 * @param {object} options.context collaborators passed to each tool's handler
 * @param {{pages: number, characters: number}|null} [options.readingBudget] how much of a site
 *   this run may read in total, from the definition; omitted means no ceiling
 */
export function createToolRegistry({ tools, scope, allowed, context, readingBudget = null }) {
  const available = new Map(
    Object.values(tools)
      .filter((tool) => allowed.includes(tool.name))
      .map((tool) => [tool.name, tool]),
  );

  // The run's reading allowance lives with the registry because the registry is built once per
  // run: the counter is the closure, and every tool call of that run shares it. A ceiling written
  // into instructions is a suggestion to a model; this one is arithmetic.
  const budget = readingBudget ? createReadingBudget(readingBudget) : null;

  const missing = allowed.filter((name) => !available.has(name));
  if (missing.length) {
    // A definition naming a tool this deployment does not have is a permanent failure: it means
    // the definition outlived the code that could serve it, usually a rollback. Retrying it
    // against this deployment will fail identically forever.
    throw new ToolError({
      code: "UNKNOWN_TOOL",
      message: `Agent definition requires tools this runtime does not provide: ${missing.sort().join(", ")}.`,
    });
  }

  return {
    /**
     * Describes every callable tool, in the shape a model provider expects.
     *
     * @returns {Array<{name: string, description: string, inputSchema: object}>}
     */
    list() {
      return [...available.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    },

    /**
     * Validates a tool call and runs it.
     *
     * Input is validated here rather than trusted from the model. A model's tool call is a
     * generated string that happened to parse as JSON: it is exactly as untrusted as a request
     * body, and treating it otherwise would put a hallucinated limit or a malformed identifier
     * straight into a database query.
     *
     * @param {string} name tool to call
     * @param {unknown} input arguments the model produced
     * @param {AbortSignal} [signal] cancellation
     * @returns {Promise<object>} the tool's result
     * @throws {ToolError} `UNKNOWN_TOOL` or `INVALID_TOOL_INPUT`
     */
    async invoke(name, input, signal) {
      const tool = available.get(name);
      if (!tool) {
        throw new ToolError({
          code: "UNKNOWN_TOOL",
          message: `${name} is not a tool this agent may call.`,
        });
      }

      const errors = [];
      const parsed = tool.parseInput(input ?? {}, errors);
      if (errors.length) {
        throw new ToolError({
          code: "INVALID_TOOL_INPUT",
          message: `Invalid input for ${name}: ${errors.join(" ")}`,
        });
      }

      return tool.handler(parsed, { ...context, scope, signal, readingBudget: budget });
    },
  };
}

/**
 * How much of a site one run has read, and how much it has left.
 *
 * Counted in both pages and characters because the two failure modes are different: thirty short
 * pages is a reasonable first run, and three enormous ones can fill a context on their own.
 *
 * @param {{pages: number, characters: number}} limits the definition's ceiling
 */
function createReadingBudget({ pages, characters }) {
  return {
    pages,
    characters,
    pagesRead: 0,
    charactersRead: 0,
    /** Records one page read, of this many characters. */
    spend(count) {
      this.pagesRead += 1;
      this.charactersRead += count;
    },
    /** Characters left, or zero once either ceiling is reached. */
    remaining() {
      if (this.pagesRead >= pages) return 0;
      return Math.max(0, characters - this.charactersRead);
    },
  };
}

/**
 * Declares one tool.
 *
 * `parseInput` is separate from `handler` so that validation is a value the registry can run
 * before dispatch, and so a tool's accepted input is documented by executable code rather than by
 * a schema that drifts from it. `inputSchema` is what the model is shown; `parseInput` is what is
 * enforced. They are written together and tested together.
 *
 * @param {object} definition tool definition
 * @param {string} definition.name namespaced name, e.g. `crawl.listPages`
 * @param {string} definition.description one sentence, written for a model to read
 * @param {object} definition.inputSchema JSON-schema description shown to the model
 * @param {(input: unknown, errors: string[]) => object} definition.parseInput validator
 * @param {(input: object, context: object) => Promise<object>} definition.handler implementation
 */
export function defineTool(definition) {
  return Object.freeze({ ...definition });
}
