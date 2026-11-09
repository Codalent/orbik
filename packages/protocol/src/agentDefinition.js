/**
 * What an SEO agent *is*: instructions, an allow-list of tools, and the shapes of its input and
 * output. Not code.
 *
 * This is the single most important consequence of the architecture. Because an agent is a
 * definition the worker reads when it executes a run, changing what an agent does is a change to
 * its definition (`@orbik/agent-definitions`), and code changes only when the *runtime or tools*
 * do — which is rare.
 *
 * A definition names tools; it never names a provider or a model. `capability` says what kind of
 * thinking the agent needs, and the model router decides what satisfies that.
 */
import {
  TOOL_NAME_PATTERN,
  assertValid,
  defaulted,
  rejectUnknownKeys,
  requireEnum,
  requireInteger,
  requirePlainObject,
  requireString,
  requireStringArray,
} from "./validate.js";

/**
 * What an agent needs from a model, expressed so that any provider can satisfy it.
 *
 * The router maps these onto concrete models; the definition never learns which one it got.
 */
export const AGENT_CAPABILITIES = Object.freeze({
  /** Cheap and quick: classification, extraction, short rewrites. */
  fast: "fast",
  /** Careful multi-step analysis with tool use — the default for an audit. */
  reasoning: "reasoning",
  /** Needs a large context window more than it needs depth. */
  longContext: "long-context",
});

/** Every capability, as an array. */
const AGENT_CAPABILITY_VALUES = Object.freeze(Object.values(AGENT_CAPABILITIES));

/** Bounds on a definition, chosen to be generous for real agents and hostile to runaway ones. */
const DEFINITION_LIMITS = Object.freeze({
  slug: 64,
  name: 80,
  summary: 300,
  instructions: 100_000,
  tools: 40,
  runtimeRequirements: 10,
});

/** Matches an agent slug: lowercase words joined by hyphens, as in `business-knowledge-base`. */
const SLUG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Top-level fields a definition declares; {@link parseAgentDefinition} refuses any other. */
const AGENT_DEFINITION_FIELDS = Object.freeze([
  "slug",
  "version",
  "name",
  "summary",
  "instructions",
  "tools",
  "inputSchema",
  "outputSchema",
  "capability",
  "runtimeRequirements",
  "readingBudget",
  "writesAs",
]);

/**
 * Whose name an agent's writes are recorded under.
 *
 * `agent`, the default, is every agent but one: what it writes is the agent's, held to the rules
 * the Library keeps for agents (no top-level folders, nothing a person made moved, every block a
 * person wrote kept). `person` is the chat in the side panel: it acts on a person's instruction,
 * typed a moment ago, so what it writes is theirs — recorded as "you, via Ask" — and it may do
 * what they may do on the Library page, except lift a lock. It is a property of the definition,
 * never of a run's input, so nothing a person types or a page says can turn an agent's writes into
 * a person's.
 */
export const AGENT_WRITERS = Object.freeze({ agent: "agent", person: "person" });

/**
 * Requirements a definition may place on the process that executes it.
 *
 * A definition that needs more than a model and Orbik's cloud tools says so here, and the
 * executing process picks its job by it. Some requirements name a **plain-code runtime**: code in
 * the agents worker that executes the definition itself, with no model deciding what happens.
 * `design-system` turns a run from "reason over the crawl" into "render the site in Chrome and
 * write down what its design is". The worker keeps the table of those runtimes
 * (`agents/src/ai/index.js`); a definition that names none of them is executed by a model.
 */
export const RUNTIME_REQUIREMENTS = Object.freeze({
  /** The crawl dataset must exist for the workspace. */
  crawlDataset: "crawl-dataset",
  /**
   * A Chrome to render pages in, and the code that samples what it rendered into a design system.
   * It needs a browser on the executing machine, and ends by asking a model two bounded questions
   * about what was sampled.
   */
  designSystem: "design-system",
});

/** Fields of the reading budget. */
const READING_BUDGET_FIELDS = Object.freeze(["pages", "characters"]);

/**
 * Validates one agent definition and returns it canonicalized.
 *
 * Called once per definition when `@orbik/agent-definitions` loads, so a process never starts
 * with a definition it would refuse to run.
 *
 * @param {unknown} input the definition document
 * @returns {Readonly<object>} the canonical definition
 * @throws {import("./validate.js").ProtocolError} `INVALID_AGENT_DEFINITION` listing every
 *   rejected field
 */
export function parseAgentDefinition(input) {
  const errors = [];
  const source = requirePlainObject(input, "definition", errors);
  assertValid("INVALID_AGENT_DEFINITION", errors);
  rejectUnknownKeys(source, AGENT_DEFINITION_FIELDS, "definition", errors);

  const slug = requireString(
    source.slug,
    "definition.slug",
    { max: DEFINITION_LIMITS.slug, pattern: SLUG_PATTERN, patternDescription: "lowercase words joined by hyphens" },
    errors,
  );
  const version = requireInteger(source.version, "definition.version", { min: 1, max: 100_000 }, errors);
  const name = requireString(source.name, "definition.name", { max: DEFINITION_LIMITS.name }, errors);
  const summary = requireString(source.summary, "definition.summary", { max: DEFINITION_LIMITS.summary }, errors);
  const instructions = requireString(
    source.instructions,
    "definition.instructions",
    { max: DEFINITION_LIMITS.instructions },
    errors,
  );
  const capability = requireEnum(source.capability, "definition.capability", AGENT_CAPABILITY_VALUES, errors);

  const tools = requireStringArray(
    source.tools,
    "definition.tools",
    {
      max: DEFINITION_LIMITS.tools,
      itemRules: { max: 64, pattern: TOOL_NAME_PATTERN, patternDescription: "a namespaced tool name such as crawl.listPages" },
    },
    errors,
  );
  if (Array.isArray(tools) && new Set(tools).size !== tools.length) {
    errors.push("definition.tools must not repeat a tool.");
  }

  const inputSchema = requirePlainObject(source.inputSchema, "definition.inputSchema", errors);
  const outputSchema = requirePlainObject(source.outputSchema, "definition.outputSchema", errors);

  const runtimeRequirements = requireStringArray(
    defaulted(source.runtimeRequirements, []),
    "definition.runtimeRequirements",
    { max: DEFINITION_LIMITS.runtimeRequirements, itemRules: { max: 64 } },
    errors,
  );

  const readingBudget = parseReadingBudget(source.readingBudget, errors);
  const writesAs = source.writesAs === undefined || source.writesAs === null
    ? AGENT_WRITERS.agent
    : requireEnum(source.writesAs, "definition.writesAs", Object.values(AGENT_WRITERS), errors);

  assertValid("INVALID_AGENT_DEFINITION", errors);
  return Object.freeze({
    slug,
    version,
    name,
    summary,
    instructions,
    tools: Object.freeze([...tools]),
    inputSchema,
    outputSchema,
    capability,
    runtimeRequirements: Object.freeze([...runtimeRequirements]),
    readingBudget,
    writesAs,
  });
}

/**
 * Validates how much source material one run of this definition may read.
 *
 * On the definition rather than in the tools because it is a property of the *agent*: the Library
 * agent's first run reads a site's core pages and writes them up, and an agent that summarised
 * every page of a documentation site would want a different number. It is enforced by the tool
 * registry rather than asked for in instructions, because an instruction is a suggestion to a
 * model and this is the difference between a run that finishes and one that fills its context.
 *
 * Optional: a definition without one has no ceiling, which is right for agents that read nothing.
 */
function parseReadingBudget(value, errors) {
  if (value === undefined || value === null) return null;
  const budget = requirePlainObject(value, "definition.readingBudget", errors);
  if (budget === null || typeof budget !== "object" || Array.isArray(budget)) return null;

  rejectUnknownKeys(budget, READING_BUDGET_FIELDS, "definition.readingBudget", errors);
  const pages = requireInteger(budget.pages, "definition.readingBudget.pages", { min: 1, max: 1000 }, errors);
  const characters = requireInteger(
    budget.characters,
    "definition.readingBudget.characters",
    { min: 1000, max: 5_000_000 },
    errors,
  );
  return Object.freeze({ pages, characters });
}

/**
 * Reduces a definition to what a runtime is given.
 *
 * A runtime receives instructions, the tool allow-list, and the schemas — everything it needs to
 * execute.
 *
 * @param {object} definition a definition from {@link parseAgentDefinition}
 * @returns {Readonly<object>} the dispatch payload
 */
export function toDispatchPayload(definition) {
  return Object.freeze({
    slug: definition.slug,
    version: definition.version,
    name: definition.name,
    instructions: definition.instructions,
    tools: definition.tools,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    capability: definition.capability,
    // The requirements travel because the executing process chooses its job by them.
    runtimeRequirements: definition.runtimeRequirements,
  });
}
