import Anthropic from "@anthropic-ai/sdk";
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema";
import { toolAlias } from "@orbik/tools";

import { AgentError } from "../../../runtime/errors.js";
import { ratesFor, tokensToDollars } from "../usage.js";

/** The longest part of a provider's own message kept in a failure. */
const MAX_PROVIDER_MESSAGE = 300;

/** Anything shaped like an API key. A rejected key is quoted back masked, and still is not kept. */
const KEY_LIKE = /\bsk-[A-Za-z0-9_*-]+/g;

/**
 * Models that take neither adaptive thinking nor an effort level.
 *
 * Both parameters arrived with the 4.6 generation. Claude Haiku 4.5 predates them: the Messages
 * API documents adaptive thinking as unsupported there and `output_config.effort` as an error, so
 * a request carrying either is rejected before the model sees it. For these models the two are
 * left off and the model answers without extended thinking. Leaving them off is valid for every
 * model, so a name listed here by mistake costs depth, never a failed call.
 */
const WITHOUT_ADAPTIVE_THINKING = new Set(["claude-haiku-4-5"]);

/**
 * Models whose declined requests are re-run server-side on the model Anthropic recommends.
 *
 * These models' safety classifiers can decline a request, which arrives as a normal answer with
 * `stop_reason: "refusal"` and nothing usable in it. `fallbacks: "default"` has the API re-run the
 * request on another model inside the same call instead, so an SEO audit that tripped a classifier
 * still finishes. Claude Haiku 5.5 has no server-side fallback, and a request naming one for it is
 * refused, so it is not listed.
 */
const WITH_SERVER_FALLBACK = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

/** The beta that carries `fallbacks: "default"`. The array form uses a different one. */
const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * The most parameters with a union type — a nullable field is one — that structured output will
 * compile. A schema with more is refused outright, before the model sees anything; the visual
 * system the Design system agent asks for has twenty.
 */
const MAX_UNION_PARAMETERS = 16;

/**
 * The Anthropic adapter: everything provider-specific about running an Orbik agent on Claude.
 *
 * Nothing above this file knows Anthropic exists. The adapter takes Orbik's own request shape —
 * instructions, messages, a tool list from Orbik's registry — and returns Orbik's own response
 * shape, so the runtime, the model router, and every agent definition are unchanged by a decision
 * to route work here rather than somewhere else. It serves the reasoning calls when
 * `ORBIK_AI_PROVIDER` chooses Anthropic (the default whenever its key is set), and is paid for
 * with `ORBIK_ANTHROPIC_API_KEY`;
 * the embeddings stay on OpenAI, which has an embeddings endpoint where Anthropic has none.
 *
 * A turn may carry pictures and may ask for its answer in a fixed shape, as it may on the OpenAI
 * adapter. A message part `{type: "image", mimeType, data}` — base64 bytes — is sent as an image
 * the model sees; and `format: {name, schema}` asks for a reply that is JSON matching that schema,
 * through structured output. Neither is used by the tool loop.
 *
 * Four translations happen here and nowhere else:
 *
 * - **Tool names.** An Orbik tool is `crawl.listPages`; a tool name here cannot carry a dot. Tools
 *   are declared under the alias the MCP server already uses (`crawl_listPages`) and a call is
 *   handed back to the runtime under the name the registry knows.
 * - **The conversation.** Each block this adapter returns carries the block it came from, and on
 *   the next turn that block is sent back exactly as it arrived. That matters most for the model's
 *   thinking: the current models check that a conversation they are handed back was not edited,
 *   and a thinking block that comes back changed — or a tool call renamed on its way through the
 *   registry — is dropped or refused rather than read.
 * - **Schemas.** Structured output accepts a subset of JSON Schema. The SDK's own transform moves
 *   what it cannot enforce (a minimum, a longest array) into the description, and the caller's
 *   own check of the reply still enforces it.
 * - **Failures.** The runtime's `classifyFailure` treats an unrecognized error as **permanently**
 *   failed, so a rate limit that arrived as a plain `Error` would dead-letter a run on its first
 *   retryable failure. Turning a 429 into a retryable `AgentError` with the provider's own
 *   `retry-after` is what makes the queue's backoff work at all.
 *
 * @param {object} options adapter configuration
 * @param {string} options.apiKey Orbik's own API credential, never a user's
 * @param {import("@anthropic-ai/sdk").default} [options.client] SDK client; defaults to one built
 *   from `apiKey`
 * @param {object} [options.callLog] the AI call log every turn is reported to
 * @param {string} [options.purpose] what the calls are for, in the log; `agent-run` by default
 */
export function createAnthropicProvider({ apiKey, client, callLog = null, purpose = "agent-run" }) {
  const anthropic = client ?? new Anthropic({ apiKey });

  return {
    name: "anthropic",

    /**
     * Runs one turn of a conversation and returns what the model produced.
     *
     * Streaming is used for every call rather than only long ones. An agent turn can legitimately
     * run for minutes on a hard audit, and a non-streaming request of that length is a request
     * that eventually hits an HTTP timeout and is retried — paying twice for the same work.
     *
     * @param {object} request one turn
     * @param {string} request.model model identifier
     * @param {string} request.system system instructions, from the agent definition
     * @param {Array<object>} request.messages conversation so far, in Orbik's message shape
     * @param {Array<object>} request.tools tool descriptions from the Orbik registry
     * @param {number} request.maxTokens output ceiling, which here includes the model's thinking
     * @param {string} request.effort how hard to think, from the definition's capability
     * @param {{name: string, schema: object}} [request.format] a JSON schema the reply must match
     * @param {AbortSignal} [request.signal] cancellation
     * @param {object} [request.trace] what the call belongs to, for the call log
     * @returns {Promise<{content: Array<object>, stopReason: string, usage: object}>}
     * @throws {AgentError} normalized, with `retryable` set correctly for the failure
     */
    async complete({ model, system, messages, tools, maxTokens, effort, format = null, signal, trace = {} }) {
      // The whole conversation is what the model was given this turn, so that is the prompt —
      // without the provider's own copy of each block, and without the bytes of any picture.
      const record = await callLog?.begin({
        backend: "anthropic-api",
        purpose,
        model,
        effort,
        system,
        prompt: JSON.stringify(messages, loggable, 2),
        tools: tools.map((tool) => tool.name),
        trace,
      });
      const names = new Map(tools.map((tool) => [toolAlias(tool.name), tool.name]));
      try {
        const adaptive = !WITHOUT_ADAPTIVE_THINKING.has(model);
        // A schema structured output will not compile is asked for in words instead, and the
        // reply is held to it by the caller's own check, which every caller of `format` has.
        const constrained = Boolean(format) && unionParameters(format.schema) <= MAX_UNION_PARAMETERS;
        const outputConfig = {
          ...(adaptive ? { effort } : {}),
          ...(constrained ? { format: { type: "json_schema", schema: transformJSONSchema(format.schema) } } : {}),
        };
        const params = {
          model,
          max_tokens: maxTokens,
          system: format && !constrained ? `${system}\n\n${jsonInstruction(format.schema)}` : system,
          messages: toMessages(messages),
          // Adaptive thinking rather than a token budget: `budget_tokens` is rejected outright on
          // the current models, and how hard to think is expressed through `effort` instead.
          ...(adaptive ? { thinking: { type: "adaptive" } } : {}),
          ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
          // A tool loop resends the whole conversation every turn, and only a cached prefix keeps
          // that from being paid for in full each time; the provider caches nothing unasked. A
          // one-shot call is left uncached: it would pay the cache-write premium for a prompt
          // nothing reads back.
          ...(tools.length ? { tools: tools.map(toAnthropicTool), cache_control: { type: "ephemeral" } } : {}),
        };
        const stream = WITH_SERVER_FALLBACK.has(model)
          ? anthropic.beta.messages.stream({ ...params, betas: [SERVER_FALLBACK_BETA], fallbacks: "default" }, { signal })
          : anthropic.messages.stream(params, { signal });

        const message = await stream.finalMessage();
        const content = toContent(message.content ?? [], names);
        const usage = {
          inputTokens: message.usage?.input_tokens ?? 0,
          outputTokens: message.usage?.output_tokens ?? 0,
          cacheWriteTokens: message.usage?.cache_creation_input_tokens ?? 0,
          cacheReadTokens: message.usage?.cache_read_input_tokens ?? 0,
        };
        const used = message.model ?? model;
        // Priced as the model that answered when a fallback answered, and as the model asked for
        // otherwise — the answering name may carry a snapshot suffix the price table does not.
        const priced = used.startsWith(model) ? model : used;
        const text = content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
        if (message.stop_reason === "refusal") {
          // Declined, and no fallback took it up. Not retryable: the same request is declined the
          // same way. What was declined is stated, never what the model would have said.
          const category = message.stop_details?.category ?? null;
          throw new AgentError({
            code: "PROVIDER_REFUSED",
            message: category ? `The AI model declined the request (${category}).` : "The AI model declined the request.",
            retryable: false,
          });
        }
        await record?.finish({
          status: "succeeded",
          model: used,
          usage,
          costUsd: tokensToDollars(usage, priced),
          pricing: ratesFor(priced),
          turns: 1,
          response: text,
          toolCalls: content.filter((block) => block.type === "tool_use").map((block) => ({ tool: block.name, summary: null })),
        });
        // Asked for in words, the object may come wrapped in prose or a fence; the caller is handed
        // the object alone, as structured output would have handed it over.
        const answer = format && !constrained ? [{ type: "text", text: outermostObject(text) }] : content;
        return { content: answer, stopReason: stopReasonOf(message, content), usage };
      } catch (error) {
        const failure = normalizeAnthropicError(error, signal);
        await record?.finish({ status: "failed", error: failure });
        throw failure;
      }
    },
  };
}

/**
 * Converts one Orbik tool description into Anthropic's tool shape.
 *
 * Not `strict`: strict tool use accepts a subset of JSON Schema, and Orbik's tool schemas use
 * array bounds (`maxItems`) it refuses. The registry validates every call anyway — a schema
 * cannot express "this site belongs to this workspace" — and a malformed call comes back to the
 * model as a tool result it can correct.
 */
function toAnthropicTool(tool) {
  return {
    name: toolAlias(tool.name),
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

/**
 * Counts the parameters of a schema whose type is a union: a list of types, or `anyOf`/`oneOf`.
 *
 * Every node is counted once, a definition under `$defs` included, which counts at least what the
 * provider does — erring towards asking in words, which costs the guarantee, never a call.
 */
function unionParameters(node) {
  if (!node || typeof node !== "object") return 0;
  const variants = node.anyOf ?? node.oneOf ?? [];
  let total = Array.isArray(node.type) || variants.length ? 1 : 0;
  for (const child of [...Object.values(node.properties ?? {}), ...Object.values(node.$defs ?? {}), ...variants, ...(node.allOf ?? []), node.items]) {
    total += unionParameters(child);
  }
  return total;
}

/** What a request whose schema cannot be enforced says instead, after the instructions. */
function jsonInstruction(schema) {
  return [
    "Reply with a single JSON object matching this JSON schema, and nothing else — no prose, no",
    "code fence:",
    JSON.stringify(schema),
  ].join("\n");
}

/** The outermost `{…}` in a text, or the text as it is when there is none. */
function outermostObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start !== -1 && end > start ? text.slice(start, end + 1) : text;
}

/**
 * Turns Orbik's conversation into the messages a request carries.
 *
 * An assistant block that came from this provider is sent back as the block it came from,
 * unchanged. A block without one — a conversation another provider began — is rebuilt from what
 * it says, and another provider's own items, which mean nothing here, are left out.
 */
function toMessages(messages) {
  return messages.map((message) => {
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [];
    if (message.role === "assistant") {
      const content = [];
      for (const block of blocks) {
        if (block.anthropic) content.push(block.anthropic);
        else if (block.type === "text") content.push({ type: "text", text: block.text });
        else if (block.type === "tool_use") content.push({ type: "tool_use", id: block.id, name: toolAlias(block.name), input: block.input ?? {} });
      }
      return { role: "assistant", content };
    }
    const content = [];
    for (const block of blocks) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        // `detail` and `reference` are not sent: the first has no equivalent here, and the second
        // is for the call log only.
        content.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
      } else if (block.type === "document") {
        content.push(toDocument(block));
      } else if (block.type === "tool_result") {
        content.push({
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content: toResultContent(block.content),
          ...(block.is_error ? { is_error: true } : {}),
        });
      }
    }
    return { role: "user", content };
  });
}

/** A PDF the model reads, as a document block. */
function toDocument(block) {
  return { type: "document", source: { type: "base64", media_type: block.mimeType, data: block.data }, ...(block.label ? { title: String(block.label).slice(0, 200) } : {}) };
}

/**
 * A tool result's content: text as it is, or — when a tool handed back a file to look at — text,
 * an image and a document as the blocks they are.
 */
function toResultContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content.map((part) => {
    if (part.type === "image") return { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } };
    if (part.type === "document") return toDocument(part);
    return { type: "text", text: typeof part.text === "string" ? part.text : JSON.stringify(part) };
  });
}

/**
 * What of a conversation is written to the call log.
 *
 * Everything but two things: the provider's own copy of each block, and the bytes of an image,
 * which are replaced by a line saying what was there — its kind, its size, how closely the model
 * was asked to look and, when the caller said, where it came from.
 */
function loggable(key, value) {
  if (key === "anthropic" || key === "openai") return undefined;
  if (value && typeof value === "object" && (value.type === "image" || value.type === "document") && typeof value.data === "string") {
    return {
      type: value.type,
      mimeType: value.mimeType,
      label: value.label ?? null,
      bytes: Math.floor((value.data.length * 3) / 4),
      ...(value.detail ? { detail: value.detail } : {}),
      ...(value.reference ? { reference: value.reference } : {}),
    };
  }
  return value;
}

/**
 * Turns a response's blocks into Orbik's blocks, each keeping the block it came from.
 *
 * Thinking blocks, and anything else the runtime does not read, become blocks this adapter sends
 * back. One case is cut: when a model declined partway through and a fallback continued, what the
 * declined model thought and called before the switch is not to be sent back, and a call it made
 * there was never meant to run — so everything before the last switch point but its text is
 * dropped here, before the runtime can act on it.
 */
function toContent(blocks, names) {
  let boundary = -1;
  blocks.forEach((block, index) => {
    if (block.type === "fallback") boundary = index;
  });
  const content = [];
  blocks.forEach((block, index) => {
    if (index < boundary && block.type !== "text") return;
    if (block.type === "text") {
      content.push({ type: "text", text: block.text, anthropic: block });
    } else if (block.type === "tool_use") {
      content.push({ type: "tool_use", id: block.id, name: names.get(block.name) ?? block.name, input: block.input ?? {}, anthropic: block });
    } else {
      content.push({ type: "provider_item", anthropic: block });
    }
  });
  return content;
}

/**
 * Why the turn ended, in the runtime's words.
 *
 * `tool_use` is the only value the runtime acts on. A response cut off by the output ceiling — or
 * by the end of the context window — is reported as `max_tokens`, so a run that ends on half a
 * result fails as an invalid result rather than looking like a model that chose to say nothing.
 */
function stopReasonOf(message, content) {
  if (content.some((block) => block.type === "tool_use")) return "tool_use";
  return message.stop_reason === "max_tokens" || message.stop_reason === "model_context_window_exceeded" ? "max_tokens" : "end_turn";
}

/**
 * Turns any provider failure into an `AgentError` the runtime can act on.
 *
 * The distinction that matters is retryable versus not, and it cannot be guessed from the message
 * text: a 429 and a 400 both arrive as exceptions and only one is worth trying again. Rate limits
 * and overload carry the provider's own `retry-after` when it sent one, because the provider knows
 * better than an exponential backoff curve when it will be ready.
 */
function normalizeAnthropicError(error, signal) {
  if (error instanceof AgentError) return error;
  if (signal?.aborted) {
    return new AgentError({
      code: "CANCELLED",
      message: "The run was cancelled.",
      retryable: false,
      cause: error,
    });
  }

  const status = error?.status;
  const retryAfterMs = retryAfterFrom(error);

  if (error instanceof Anthropic.RateLimitError || status === 429) {
    return new AgentError({
      code: "PROVIDER_RATE_LIMITED",
      message: "The AI provider is rate limiting Orbik. The run will be retried.",
      retryable: true,
      retryAfterMs,
      cause: error,
    });
  }

  // 529 is Anthropic's "overloaded": the request was fine, the service was not.
  if (status === 529 || status === 503) {
    return new AgentError({
      code: "PROVIDER_OVERLOADED",
      message: "The AI provider is temporarily overloaded. The run will be retried.",
      retryable: true,
      retryAfterMs,
      cause: error,
    });
  }

  if (status >= 500) {
    return new AgentError({
      code: "PROVIDER_UNAVAILABLE",
      message: "The AI provider failed to respond. The run will be retried.",
      retryable: true,
      retryAfterMs,
      cause: error,
    });
  }

  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError || status === 401 || status === 403) {
    // Orbik's own credential is wrong or revoked. Retrying cannot fix it, and the message must
    // not hint at the key's value or shape.
    return new AgentError({
      code: "PROVIDER_NOT_CONFIGURED",
      message: "Orbik's AI provider credentials were rejected.",
      retryable: false,
      cause: error,
    });
  }

  if (error instanceof Anthropic.APIConnectionError) {
    return new AgentError({
      code: "PROVIDER_UNREACHABLE",
      message: "Could not reach the AI provider. The run will be retried.",
      retryable: true,
      cause: error,
    });
  }

  // A 400 is a bug in what Orbik sent — a tool schema the provider will not take, a prompt past
  // the model's window — or an account with no credit left. Retrying sends the identical request
  // and fails identically, so it is reported rather than repeated, with the provider's own words.
  const said = error?.error?.error?.message ?? error?.message ?? "";
  const detail = String(said).replace(KEY_LIKE, "[key]").replace(/\s+/g, " ").trim().slice(0, MAX_PROVIDER_MESSAGE);
  return new AgentError({
    code: "PROVIDER_REQUEST_REJECTED",
    message: detail ? `The AI provider rejected the request: ${detail}` : "The AI provider rejected the request.",
    retryable: false,
    cause: error,
  });
}

/** Reads the provider's `retry-after` header, in milliseconds, when it sent one. */
function retryAfterFrom(error) {
  const header = error?.headers?.get?.("retry-after") ?? error?.headers?.["retry-after"];
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 300) * 1000 : undefined;
}
