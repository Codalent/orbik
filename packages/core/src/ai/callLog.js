import { AGENT_COLLECTIONS } from "../db/collections.js";
import { ObjectId } from "mongodb";

/**
 * How much of a prompt or a reply is kept, in characters.
 *
 * Whole prompts, because a log that shows the first hundred characters of a system prompt cannot
 * answer the question it exists for. The cap is there for the document, not the reader: a run's
 * task prompt carries the agent input and the output schema, and a reply can be a full report,
 * but neither should be able to grow a single document toward MongoDB's limit.
 */
const TEXT_LIMIT = 200_000;

/**
 * Creates the writer every model call reports to.
 *
 * Shared rather than owned by the worker, because a model call is recorded by whichever process
 * made it: the agents worker for agent runs and indexing, and the API for the embedding one MCP
 * `content.search` needs. The API still only *writes* calls it made itself — reading the log back
 * is a separate, deliberately read-only repository.
 *
 * One document per call, written twice: inserted when the call starts and completed when it ends.
 * The first write is what makes a call that is still running — or one that took the process down
 * with it — show up in the log at all; a single write at the end would record only the calls that
 * came back.
 *
 * Nothing here can fail a run. A model call that succeeded but could not be logged is still a
 * model call that succeeded, so every write is caught and reported to the logger rather than
 * thrown at the runtime. The log is evidence, not a ledger.
 *
 * @param {object} options collaborators
 * @param {import("mongodb").Db} options.database connected database
 * @param {(level: string, message: string, context?: object) => void} [options.logger]
 * @param {() => Date} [options.now] clock; defaults to the system clock
 * @param {{beforeBegin?: (call: object) => Promise<void>, afterFinish?: (call: object) => Promise<void>}} [options.hooks]
 *   what the process's extensions do around a call (`createAiCallHooks` in `@orbik/extensions`):
 *   `beforeBegin` may refuse it by throwing, and is the one exception to the rule above;
 *   `afterFinish` is told the completed row
 */
export function createAiCallLog({ database, logger = () => {}, now = () => new Date(), hooks = null }) {
  const calls = database.collection(AGENT_COLLECTIONS.aiCalls);

  return {
    /**
     * Records that a call is starting.
     *
     * @param {object} call what is being asked, and on whose behalf
     * @param {string} call.backend `anthropic-api` or `openai-api`
     * @param {string} call.purpose what the call is for, e.g. `agent-run`, `short-text` or `embedding`
     * @param {string} call.model the model requested
     * @param {string} [call.effort]
     * @param {string} [call.system] the system prompt
     * @param {string} call.prompt the user turn, the whole conversation for an API turn, or the
     *   texts of an embedding request
     * @param {string[]} [call.tools] Orbik tools the model may call
     * @param {number} [call.inputs] how many texts an embedding request carried
     * @param {object} [call.trace] what the call belongs to: `runId`, `workspaceId`, `siteId`,
     *   `agentSlug`, `agentVersion`, `turn`
     * @returns {Promise<{finish: (outcome: object) => Promise<void>}>} a handle to complete it
     */
    async begin({ backend, purpose, model, effort = null, system = null, prompt, tools = [], inputs = null, trace = {} }) {
      const _id = new ObjectId();
      const startedAt = now();
      const document = {
        _id,
        startedAt,
        finishedAt: null,
        durationMs: null,
        status: "running",
        backend,
        purpose,
        model: { requested: model, used: null },
        effort,
        system: clip(system),
        prompt: clip(prompt),
        tools,
        inputs: Number.isInteger(inputs) ? inputs : null,
        toolCalls: [],
        response: null,
        usage: null,
        costUsd: null,
        pricing: null,
        turns: null,
        error: null,
        ...identify(trace),
      };
      // The one thing allowed to stop a call: an extension's refusal, before anything is sent or
      // recorded. It is thrown to the caller as it is; every other failure of the log is swallowed.
      if (hooks?.beforeBegin) await hooks.beforeBegin(document);
      try {
        await calls.insertOne(document);
      } catch (error) {
        logger("warn", "ai.call_log_failed", { stage: "begin", message: error?.message ?? "unknown" });
      }

      return {
        id: _id,

        /**
         * Completes the record with what came back.
         *
         * @param {object} outcome
         * @param {"succeeded" | "failed"} outcome.status
         * @param {string} [outcome.model] the model that actually answered, when reported
         * @param {object} [outcome.usage] token counts
         * @param {number} [outcome.costUsd]
         * @param {object} [outcome.pricing] list price in dollars per million tokens of each kind —
         *   `input`, `output`, `cacheWrite`, `cacheRead` — so the log can show its arithmetic. For
         *   the Claude login it is Orbik's table, and the SDK's own cost figure may not agree.
         * @param {number} [outcome.turns]
         * @param {string} [outcome.response] the model's final text
         * @param {Array<{tool: string, summary?: string | null}>} [outcome.toolCalls]
         * @param {{code: string, message: string}} [outcome.error]
         */
        async finish({ status, model: used = null, usage = null, costUsd = null, pricing = null, turns = null, response = null, toolCalls = [], error = null }) {
          const finishedAt = now();
          let completed = null;
          try {
            completed = {
              finishedAt,
              durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
              status,
              "model.used": used,
              usage: usage
                ? {
                  inputTokens: usage.inputTokens ?? 0,
                  outputTokens: usage.outputTokens ?? 0,
                  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
                  cacheReadTokens: usage.cacheReadTokens ?? 0,
                }
                : null,
              costUsd,
              pricing: pricing
                ? {
                  input: rate(pricing.input),
                  output: rate(pricing.output),
                  cacheWrite: rate(pricing.cacheWrite),
                  cacheRead: rate(pricing.cacheRead),
                }
                : null,
              turns,
              response: clip(response),
              toolCalls,
              error: error ? { code: error.code ?? "UNEXPECTED_ERROR", message: error.message ?? "" } : null,
            };
            await calls.updateOne({ _id }, { $set: completed });
          } catch (failure) {
            logger("warn", "ai.call_log_failed", { stage: "finish", message: failure?.message ?? "unknown" });
          }
          // Told after the row is written, with the row as written, so whatever an extension
          // meters from it agrees with what the AI call log shows. Never allowed to fail the call.
          if (hooks?.afterFinish && completed) {
            const { "model.used": answered, ...rest } = completed;
            try {
              await hooks.afterFinish({ ...document, ...rest, model: { requested: document.model.requested, used: answered } });
            } catch (failure) {
              logger("warn", "ai.call_hook_failed", { stage: "finish", message: failure?.message ?? "unknown" });
            }
          }
        },
      };
    },
  };
}

/**
 * Keeps a text within {@link TEXT_LIMIT}, saying so when it had to cut.
 *
 * The marker is in the text itself rather than in a separate flag so that whoever reads the
 * document — a person in the log window, a script — cannot mistake the cut for the end.
 */
function clip(text) {
  if (text === null || text === undefined) return null;
  const value = typeof text === "string" ? text : JSON.stringify(text);
  if (value.length <= TEXT_LIMIT) return value;
  return `${value.slice(0, TEXT_LIMIT)}\n… [truncated: ${value.length - TEXT_LIMIT} more characters]`;
}

/** A price that is a number, or null for a kind of token the model does not bill. */
function rate(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Normalizes what a call belongs to into stored identifiers.
 *
 * Ids are stored as ObjectIds so the API can filter on the same type it uses everywhere else; a
 * value that is not one is kept as null rather than as a string that would never match.
 */
function identify(trace) {
  return {
    runId: toObjectIdOrNull(trace.runId),
    workspaceId: toObjectIdOrNull(trace.workspaceId),
    siteId: toObjectIdOrNull(trace.siteId),
    agentSlug: trace.agentSlug ?? null,
    agentVersion: Number.isInteger(trace.agentVersion) ? trace.agentVersion : null,
    turn: Number.isInteger(trace.turn) ? trace.turn : null,
  };
}

/** An ObjectId for an ObjectId or a valid hex string, and null for anything else. */
function toObjectIdOrNull(value) {
  if (value instanceof ObjectId) return value;
  if (typeof value === "string" && ObjectId.isValid(value)) return new ObjectId(value);
  return null;
}
