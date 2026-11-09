import { AgentError } from "./errors.js";

const NAME_PATTERN = /^[a-z][a-z0-9]*(?:[.\-_][a-z0-9]+)*$/;

/**
 * Defines one agent: a name, a version, and the handlers it can execute.
 *
 * Agents never call each other. They communicate by writing shared collections and enqueueing
 * jobs, which is what allows any agent to be restarted, retried, or replaced without the others
 * knowing. A handler therefore receives everything it needs through its context rather than
 * importing another agent.
 *
 * @param {object} definition agent definition
 * @param {string} definition.name unique lowercase identifier, e.g. `crawler`
 * @param {number} definition.version integer bumped when stored output changes shape
 * @param {Record<string, (job: object, context: object) => Promise<object|void>>} definition.handlers
 *   job type to handler. A handler may return `{counters, enqueue}` to report progress and queue
 *   follow-up work; the runtime applies both only after the handler resolves.
 * @returns {Readonly<object>} the validated definition
 * @throws {AgentError} `INVALID_AGENT` when the definition is malformed
 */
export function defineAgent({ name, version, handlers }) {
  const errors = [];
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    errors.push("name must be a lowercase dotted identifier.");
  }
  if (!Number.isInteger(version) || version < 1) {
    errors.push("version must be a positive integer.");
  }
  if (!handlers || typeof handlers !== "object" || !Object.keys(handlers).length) {
    errors.push("handlers must contain at least one job type.");
  } else {
    for (const [type, handler] of Object.entries(handlers)) {
      if (!NAME_PATTERN.test(type)) errors.push(`handler type ${type} must be a lowercase dotted identifier.`);
      if (typeof handler !== "function") errors.push(`handler ${type} must be a function.`);
    }
  }
  if (errors.length) {
    throw new AgentError({
      code: "INVALID_AGENT",
      message: `Invalid agent definition: ${errors.join(" ")}`,
      retryable: false,
    });
  }
  return Object.freeze({ name, version, handlers: Object.freeze({ ...handlers }) });
}

/**
 * Holds the agents one worker process can execute.
 *
 * Registration is explicit rather than filesystem-scanned so that which agents a process runs is
 * a deployment decision visible in code — a crawler-only worker and a mixed worker differ by one
 * line, not by what happens to be on disk.
 */
export function createAgentRegistry(definitions = []) {
  const agents = new Map();
  for (const definition of definitions) {
    if (agents.has(definition.name)) {
      throw new AgentError({
        code: "INVALID_AGENT",
        message: `Invalid agent definition: ${definition.name} is registered twice.`,
        retryable: false,
      });
    }
    agents.set(definition.name, definition);
  }

  return {
    /** Names of every registered agent, used to scope queue claims. */
    names() {
      return [...agents.keys()];
    },

    /** Returns one agent definition, or null when it is not registered here. */
    find(name) {
      return agents.get(name) ?? null;
    },

    /**
     * Resolves the handler for a claimed job.
     *
     * An unknown agent or type is a permanent failure rather than a retryable one: it means the
     * job outlived the code that could execute it — usually a rollback — and no number of
     * retries against this deployment will change that.
     *
     * @throws {AgentError} `UNKNOWN_HANDLER` when nothing can execute the job
     */
    resolve(agentName, type) {
      const agent = agents.get(agentName);
      const handler = agent?.handlers?.[type];
      if (!handler) {
        throw new AgentError({
          code: "UNKNOWN_HANDLER",
          message: `No handler registered for ${agentName}.${type}.`,
          retryable: false,
        });
      }
      return { agent, handler };
    },
  };
}
