import { AGENT_CAPABILITIES, AGENT_EVENT_TYPES } from "@orbik/protocol";

import { AgentError } from "../../runtime/errors.js";
import { summarize } from "../progress.js";
import { accumulateUsage, emptyUsage } from "./usage.js";

/**
 * How many model round trips one run may make before it is stopped.
 *
 * An agent that keeps calling tools without concluding is the expensive failure mode of this whole
 * design: every round trip resends the conversation, so cost grows quadratically while the user
 * watches a progress list that never ends. The cap turns that into a bounded, reported failure.
 */
const MAX_TURNS = 30;

/**
 * The cap for long-context work, which is the Library's write run.
 *
 * That run reads the pages chosen for the knowledge base and rewrites the subject tree file by
 * file, and it writes as it reads, so its turns are its files: its last complete rebuild took 43 round trips, and the first
 * one made under the cap above was stopped at 30 with eighteen files rewritten and the entry map
 * not yet reached. Twice the ordinary cap finishes a rebuild and still bounds a run that has
 * stopped converging.
 */
const MAX_TURNS_LONG_CONTEXT = 60;

/**
 * Creates the runtime that executes an agent with a model.
 *
 * The loop is written out rather than delegated to an SDK helper because two of its steps are
 * Orbik's, not a provider's: every tool call goes through Orbik's registry — which is where
 * workspace scoping and input validation live — and every iteration checks whether the user has
 * asked to cancel. A helper that owned the loop would own both of those too.
 *
 * @param {object} options collaborators
 * @param {object} options.modelRouter chooses the model for a definition
 * @param {(level: string, message: string, context?: object) => void} options.logger
 */
export function createModelRuntime({ modelRouter, logger }) {
  return {
    name: "model",

    /**
     * Executes one agent request, yielding events as it goes.
     *
     * An async generator rather than a callback so that back-pressure is the caller's: the worker
     * writes each event to the run log before asking for the next, which means a run's visible
     * progress can never get ahead of what has actually been recorded.
     *
     * @param {object} request what to run
     * @param {object} request.definition resolved agent definition
     * @param {object} request.input validated agent input
     * @param {object} request.tools scoped tool registry
     * @param {AbortSignal} request.signal cancellation
     * @param {() => Promise<boolean>} [request.isCancelled] asked between turns
     * @yields {object} events matching `@orbik/protocol`'s `parseAgentEvent`
     */
    async *run({ definition, input, tools, signal, isCancelled, trace = {} }) {
      const route = modelRouter.resolve(definition);
      const usage = emptyUsage();
      const descriptions = tools.list();

      yield { type: AGENT_EVENT_TYPES.started };

      const messages = [{ role: "user", content: [{ type: "text", text: buildTask(definition, input) }] }];

      const maxTurns = definition.capability === AGENT_CAPABILITIES.longContext ? MAX_TURNS_LONG_CONTEXT : MAX_TURNS;
      // Whether the model has already been asked once to restate a reply that was not JSON.
      let reasked = false;
      for (let turn = 0; turn < maxTurns; turn += 1) {
        // Checked before the expensive call rather than after it, so a cancellation that arrives
        // while a tool is running does not pay for one more model turn before taking effect.
        if (signal?.aborted || (isCancelled && (await isCancelled()))) {
          throw new AgentError({ code: "CANCELLED", message: "The run was cancelled.", retryable: false });
        }

        const response = await route.provider.complete({
          model: route.model,
          system: definition.instructions,
          messages,
          tools: descriptions,
          maxTokens: route.maxTokens,
          effort: route.effort,
          signal,
          // Which run and which round trip this is, for the call log. A tool-use loop is a call
          // per turn, and the log records each one rather than a total the loop would have to
          // keep for it.
          trace: { ...trace, agentSlug: definition.slug, agentVersion: definition.version, turn: turn + 1 },
        });
        accumulateUsage(usage, response.usage);

        if (response.stopReason !== "tool_use") {
          let result;
          try {
            result = readResult(response.content, definition);
          } catch (error) {
            // A model that did the work and then wrote its reply as prose — which a chat agent,
            // asked to write Markdown for a person, does now and then — is asked once to restate
            // it in the shape asked for, rather than the run failing with the work done and the
            // reply in hand. One turn, with nothing to repeat: the conversation is cached.
            if (error?.code !== "AGENT_OUTPUT_INVALID" || reasked || turn + 1 >= maxTurns) throw error;
            reasked = true;
            messages.push({ role: "assistant", content: response.content });
            messages.push({
              role: "user",
              content: [{
                type: "text",
                text:
                  "That reply was not a JSON object, so it cannot be shown. Restate it, unchanged in " +
                  "substance, as a single JSON object matching the output schema — prose goes in its " +
                  "fields — with nothing before or after it. Do not call any tools.",
              }],
            });
            continue;
          }
          yield {
            type: AGENT_EVENT_TYPES.completed,
            result,
          };
          return { result, usage, model: route.model };
        }

        // The assistant turn is echoed back in full, including any thinking blocks: dropping them
        // loses the model's own record of why it called what it called, and the next turn then
        // re-derives it at full price.
        messages.push({ role: "assistant", content: response.content });

        const calls = response.content.filter((block) => block.type === "tool_use");
        const results = [];
        for (const call of calls) {
          yield { type: AGENT_EVENT_TYPES.toolStarted, tool: call.name };
          const outcome = await invokeTool(tools, call, signal, logger);
          results.push(outcome.block);
          yield {
            type: AGENT_EVENT_TYPES.toolCompleted,
            tool: call.name,
            summary: outcome.summary,
          };
        }

        // Every result goes back in a single user message. Splitting them across messages teaches
        // the model that parallel calls are not answered together, and it stops making them.
        messages.push({ role: "user", content: results });
      }

      throw new AgentError({
        code: "AGENT_DID_NOT_CONCLUDE",
        message: `The agent made ${maxTurns} rounds of tool calls without producing a result.`,
        retryable: false,
      });
    },
  };
}

/**
 * Runs one tool call and packages it as a result block.
 *
 * A tool failure is returned to the model as `is_error` rather than thrown. A model that asked for
 * a page that does not exist should be told so and given the chance to ask a better question;
 * aborting the run would throw away everything it had already established, and would make one
 * hallucinated URL fatal to a five-minute audit.
 *
 * The exception is cancellation, which is not the tool's failure and must stop the run.
 */
async function invokeTool(tools, call, signal, logger) {
  try {
    const result = await tools.invoke(call.name, call.input, signal);
    return {
      block: { type: "tool_result", tool_use_id: call.id, content: resultContent(result) },
      summary: summarize(result),
    };
  } catch (error) {
    if (error?.code === "CANCELLED" || signal?.aborted) throw error;
    logger?.("warn", "ai.tool_failed", { tool: call.name, code: error?.code ?? "UNEXPECTED_ERROR" });
    return {
      block: {
        type: "tool_result",
        tool_use_id: call.id,
        is_error: true,
        content: error?.message ?? "The tool failed.",
      },
      summary: "failed",
    };
  }
}

/**
 * What a tool's result is handed back to the model as.
 *
 * JSON text, unless the tool returned a file to look at under `inline` — the convention the MCP
 * surface already follows for `brand_asset`. An image or a PDF is then a block of its own beside
 * the facts, so the model sees the picture or reads the document rather than a megabyte of base64
 * written out as text.
 */
function resultContent(result) {
  const inline = result && typeof result === "object" ? result.inline : null;
  if ((inline?.type === "image" || inline?.type === "document") && typeof inline.data === "string") {
    const facts = Object.fromEntries(Object.entries(result).filter(([key]) => key !== "inline"));
    return [
      { type: "text", text: JSON.stringify(facts) },
      { type: inline.type, mimeType: inline.mimeType, data: inline.data, ...(inline.label ? { label: inline.label } : {}) },
    ];
  }
  return JSON.stringify(result);
}

/**
 * Builds the one user message that states the task.
 *
 * The definition's instructions are the system prompt; this is the request. They are kept apart so
 * the instructions stay byte-identical across every run of a version, which is what lets the
 * provider's prompt cache serve them and what makes two runs of v12 comparable.
 */
function buildTask(definition, input) {
  return [
    `Run the ${definition.name} agent.`,
    "",
    "Input:",
    JSON.stringify(input, null, 2),
    "",
    "Use the available tools to gather what you need, then reply with a single JSON object",
    "matching this schema and nothing else:",
    JSON.stringify(definition.outputSchema, null, 2),
  ].join("\n");
}

/**
 * Extracts the agent's result from its final message.
 *
 * A model asked for JSON sometimes wraps it in prose or a fenced block, so the text is searched
 * for the outermost object rather than parsed whole. Failing to find one is a permanent failure of
 * this run: a retry re-runs the whole audit at full cost to re-roll the same dice.
 */
function readResult(content, definition) {
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new AgentError({
      code: "AGENT_OUTPUT_INVALID",
      message: `${definition.name} did not return a JSON result.`,
      retryable: false,
    });
  }

  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch (error) {
    throw new AgentError({
      code: "AGENT_OUTPUT_INVALID",
      message: `${definition.name} returned a result that could not be parsed.`,
      retryable: false,
      cause: error,
    });
  }
}
