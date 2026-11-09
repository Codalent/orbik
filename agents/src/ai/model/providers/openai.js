import { toolAlias } from "@orbik/tools";

import { AgentError } from "../../../runtime/errors.js";
import { ratesFor, tokensToDollars } from "../usage.js";

/** Where a turn is sent: OpenAI's Responses API. */
const RESPONSES_URL = "https://api.openai.com/v1/responses";

/** The longest part of a provider's own message kept in a failure. */
const MAX_PROVIDER_MESSAGE = 300;

/** Anything shaped like an API key. A rejected key is quoted back masked, and still is not kept. */
const KEY_LIKE = /\bsk-[A-Za-z0-9_*-]+/g;

/**
 * The OpenAI adapter: everything provider-specific about running an Orbik agent on an OpenAI model.
 *
 * Nothing above this file knows OpenAI exists. The adapter takes Orbik's own request shape —
 * instructions, messages, a tool list from Orbik's registry — and returns Orbik's own response
 * shape, so the runtime, the model router, and every agent definition are unchanged by a decision
 * to route work here rather than somewhere else. It is paid for with the same key the embeddings
 * use, `ORBIK_OPENAI_API_KEY`, which is the one credential every model call in Orbik is made with.
 *
 * A turn may carry pictures and may ask for its answer in a fixed shape. A message part
 * `{type: "image", mimeType, data}` — base64 bytes — is sent as an image the model sees, which is
 * how the Design system agent shows it a screenshot; and `format: {name, schema}` asks for a reply
 * that is JSON matching that schema, which the provider then guarantees rather than merely
 * attempts. Neither is used by the tool loop, which is unchanged.
 *
 * Three translations happen here and nowhere else:
 *
 * - **Tool names.** An Orbik tool is `crawl.listPages`; a function name here cannot carry a dot.
 *   Tools are declared under the alias the MCP server already uses (`crawl_listPages`) and a call
 *   is handed back to the runtime under the name the registry knows.
 * - **The conversation.** Orbik keeps a turn as blocks — text, a tool call, a tool result. The
 *   Responses API keeps it as items. Each block this adapter returns carries the item it came
 *   from, and on the next turn that item is sent back exactly as it arrived. That matters most
 *   for the model's own reasoning: a reasoning model that is handed its earlier reasoning back
 *   does not pay to re-derive it, and one that is not, does. Nothing is stored at the provider
 *   (`store: false`), so the reasoning travels as the encrypted content the API returns for it.
 * - **Failures.** The runtime's `classifyFailure` treats an unrecognized error as **permanently**
 *   failed, so a rate limit that arrived as a plain `Error` would dead-letter a run on its first
 *   retryable failure. Turning a 429 into a retryable `AgentError` with the provider's own
 *   `retry-after` is what makes the queue's backoff work at all.
 *
 * The request is made with `fetch` rather than an SDK, as the embedding call beside it is: it is
 * one endpoint, and a second client library would be a second place for the key to live.
 *
 * @param {object} options adapter configuration
 * @param {string} options.apiKey Orbik's own API credential, never a user's
 * @param {typeof fetch} [options.fetchImpl] the request function; defaults to the platform's
 * @param {object} [options.callLog] the AI call log every turn is reported to
 * @param {string} [options.purpose] what the calls are for, in the log; `agent-run` by default
 */
export function createOpenAiProvider({ apiKey, fetchImpl = fetch, callLog = null, purpose = "agent-run" }) {
  return {
    name: "openai",

    /**
     * Runs one turn of a conversation and returns what the model produced.
     *
     * Streamed for every call rather than only long ones. A turn of a hard audit can think for
     * minutes before it writes anything, and a request that sits silent that long is one an HTTP
     * client gives up on and the queue then retries — paying twice for the same work. Nothing is
     * shown as it streams; the stream exists to keep the connection alive, and only its last
     * event, which carries the whole response, is read.
     *
     * @param {object} request one turn
     * @param {string} request.model model identifier
     * @param {string} request.system system instructions, from the agent definition
     * @param {Array<object>} request.messages conversation so far, in Orbik's message shape
     * @param {Array<object>} request.tools tool descriptions from the Orbik registry
     * @param {number} request.maxTokens output ceiling, which here includes the model's reasoning
     * @param {string} request.effort how hard to think, from the definition's capability
     * @param {{name: string, schema: object}} [request.format] a JSON schema the reply must match
     * @param {AbortSignal} [request.signal] cancellation
     * @param {object} [request.trace] what the call belongs to, for the call log
     * @returns {Promise<{content: Array<object>, stopReason: string, usage: object}>}
     * @throws {AgentError} normalized, with `retryable` set correctly for the failure
     */
    async complete({ model, system, messages, tools, maxTokens, effort, format = null, signal, trace = {} }) {
      // The whole conversation is what the model was given this turn, so that is the prompt —
      // without the provider's own copy of each item, which is opaque and would only bury it, and
      // without the bytes of any picture: a megabyte of base64 says nothing a reader can use, so
      // the log keeps what kind of image it was and how large.
      const record = await callLog?.begin({
        backend: "openai-api",
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
        const response = await request(fetchImpl, apiKey, signal, {
          model,
          instructions: system,
          input: toInput(messages),
          ...(tools.length ? { tools: tools.map(toOpenAiTool) } : {}),
          max_output_tokens: maxTokens,
          reasoning: { effort },
          // Strict, so the reply is the schema's shape or the call fails: a caller that asked for
          // JSON is not left parsing prose that merely resembles it.
          ...(format ? { text: { format: { type: "json_schema", name: format.name, schema: format.schema, strict: true } } } : {}),
          // The model's reasoning, in the only form that survives a turn when nothing is stored.
          include: ["reasoning.encrypted_content"],
          store: false,
          stream: true,
        });

        const content = toContent(response, names);
        const usage = toUsage(response.usage);
        const used = response.model ?? model;
        await record?.finish({
          status: "succeeded",
          model: used,
          usage,
          costUsd: tokensToDollars(usage, model),
          pricing: ratesFor(model),
          turns: 1,
          response: content.filter((block) => block.type === "text").map((block) => block.text).join("\n"),
          toolCalls: content.filter((block) => block.type === "tool_use").map((block) => ({ tool: block.name, summary: null })),
        });
        return { content, stopReason: stopReasonOf(response, content), usage };
      } catch (error) {
        const failure = normalizeOpenAiError(error, signal);
        await record?.finish({ status: "failed", error: failure });
        throw failure;
      }
    },
  };
}

/**
 * Sends one request and returns the finished response object.
 *
 * @throws {ProviderFailure|Error} what went wrong, for {@link normalizeOpenAiError} to classify
 */
async function request(fetchImpl, apiKey, signal, body) {
  const response = await fetchImpl(RESPONSES_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new ProviderFailure({
      status: response.status,
      code: detail?.error?.code ?? detail?.error?.type ?? null,
      message: detail?.error?.message ?? null,
      retryAfter: response.headers.get("retry-after"),
    });
  }
  return readStream(response.body);
}

/**
 * Reads a response stream to its end and returns the response its last event carries.
 *
 * Server-sent events: blocks separated by a blank line, each with a `data:` line of JSON. Every
 * event but three is ignored — the one that completes the response, the one that ends it early
 * (the output ceiling was reached), and the two ways a stream says it failed.
 */
async function readStream(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = null;
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let boundary = /\r?\n\r?\n/.exec(buffer); boundary; boundary = /\r?\n\r?\n/.exec(buffer)) {
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        // A partial or malformed event cannot be acted on; the terminal event is what counts.
        continue;
      }
      if (event.type === "response.completed" || event.type === "response.incomplete") finished = event.response;
      if (event.type === "response.failed") {
        throw new ProviderFailure({ status: null, code: event.response?.error?.code ?? null, message: event.response?.error?.message ?? null });
      }
      if (event.type === "error") {
        throw new ProviderFailure({ status: null, code: event.code ?? event.error?.code ?? null, message: event.message ?? event.error?.message ?? null });
      }
    }
  }
  if (!finished) {
    // The connection closed before the response was complete: the request may have been fine.
    throw new ProviderFailure({ status: null, code: "stream_ended", message: "The response stream ended before it was complete." });
  }
  return finished;
}

/** A failure the provider reported, before it is classified. Never thrown past this file. */
class ProviderFailure extends Error {
  constructor({ status, code, message, retryAfter = null }) {
    super(message ?? code ?? "The AI provider failed.");
    this.name = "ProviderFailure";
    this.status = status;
    this.providerCode = code;
    this.retryAfter = retryAfter;
  }
}

/**
 * Converts one Orbik tool description into a function the model can call.
 *
 * Not `strict`: strict mode requires every property to be listed as required, and Orbik's tools
 * have optional arguments by design. The registry validates every call anyway — a schema cannot
 * express "this site belongs to this workspace" — and a malformed call comes back to the model as
 * a tool result it can correct.
 */
function toOpenAiTool(tool) {
  return {
    type: "function",
    name: toolAlias(tool.name),
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  };
}

/**
 * Turns Orbik's conversation into the items a request carries.
 *
 * An assistant block that came from this provider is sent back as the item it came from,
 * unchanged, so the model's reasoning and its own record of what it called survive the turn. A
 * block without one — a conversation another provider began — is rebuilt from what it says.
 */
function toInput(messages) {
  const input = [];
  for (const message of messages) {
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [];
    if (message.role === "assistant") {
      for (const block of blocks) {
        if (block.openai) input.push(block.openai);
        else if (block.type === "text") input.push({ role: "assistant", content: [{ type: "output_text", text: block.text }] });
        else if (block.type === "tool_use") {
          input.push({ type: "function_call", call_id: block.id, name: toolAlias(block.name), arguments: JSON.stringify(block.input ?? {}) });
        }
      }
      continue;
    }
    // A user turn is text, pictures, or tool results. Text and pictures that sit together stay one
    // message, in the order they were given: "this is the home page" belongs beside the picture
    // it describes.
    let text = [];
    const flush = () => {
      if (text.length) input.push({ role: "user", content: text });
      text = [];
    };
    for (const block of blocks) {
      if (block.type === "text") {
        text.push({ type: "input_text", text: block.text });
      } else if (block.type === "image") {
        text.push({ type: "input_image", image_url: `data:${block.mimeType};base64,${block.data}`, detail: block.detail ?? "auto" });
      } else if (block.type === "tool_result") {
        flush();
        // There is no error flag on a function's output, so a failed call says so in words.
        // A file a tool handed back to look at cannot travel in a function's output here; its
        // facts do, and the model is told the file itself was not shown.
        const output = typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((part) => (part.type === "text" ? part.text : `[A ${part.type} was returned that this model cannot be shown.]`)).join("\n")
            : JSON.stringify(block.content ?? "");
        input.push({ type: "function_call_output", call_id: block.tool_use_id, output: block.is_error ? `Error: ${output}` : output });
      }
    }
    flush();
  }
  return input;
}

/**
 * What of a conversation is written to the call log.
 *
 * Everything but two things: the provider's own copy of each item, and the bytes of an image,
 * which are replaced by a line saying what was there — its kind, its size, how closely the model
 * was asked to look and, when the caller said, where it came from. An agent that shows a model
 * one image after another would otherwise write megabytes of base64 into a log nobody can read.
 */
function loggable(key, value) {
  if (key === "openai") return undefined;
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
 * Turns a response's items into Orbik's blocks, each keeping the item it came from.
 *
 * Reasoning items become blocks the runtime does not read and this adapter sends back. A call's
 * arguments arrive as text: text that is not JSON is passed on as it is, so the registry refuses
 * it in words the model can act on rather than this adapter guessing what was meant.
 */
function toContent(response, names) {
  const content = [];
  for (const item of response.output ?? []) {
    if (item.type === "message") {
      const text = (item.content ?? [])
        .map((part) => (part.type === "output_text" ? part.text : part.type === "refusal" ? part.refusal : ""))
        .join("");
      content.push({ type: "text", text, openai: item });
    } else if (item.type === "function_call") {
      content.push({ type: "tool_use", id: item.call_id, name: names.get(item.name) ?? item.name, input: parseArguments(item.arguments), openai: item });
    } else {
      content.push({ type: "provider_item", openai: item });
    }
  }
  return content;
}

/** A call's arguments as an object, or as the text they arrived as when that is not JSON. */
function parseArguments(text) {
  if (typeof text !== "string" || !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Why the turn ended, in the runtime's words.
 *
 * `tool_use` is the only value the runtime acts on. A response cut off by the output ceiling is
 * reported as such, so a run that ends on half a result fails as an invalid result rather than
 * looking like a model that chose to say nothing.
 */
function stopReasonOf(response, content) {
  if (content.some((block) => block.type === "tool_use")) return "tool_use";
  return response.status === "incomplete" ? "max_tokens" : "end_turn";
}

/**
 * The provider's usage in Orbik's four counts.
 *
 * Here cached and cache-written tokens are counted *inside* the input figure, where Orbik's
 * counts keep the three apart, so they are taken out of it: each kind is priced once.
 */
function toUsage(usage) {
  const cached = count(usage?.input_tokens_details?.cached_tokens);
  const written = count(usage?.input_tokens_details?.cache_write_tokens);
  return {
    inputTokens: Math.max(0, count(usage?.input_tokens) - cached - written),
    outputTokens: count(usage?.output_tokens),
    cacheWriteTokens: written,
    cacheReadTokens: cached,
  };
}

/** A token count from a provider response, or zero when it is absent or not a number. */
function count(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Turns any provider failure into an `AgentError` the runtime can act on.
 *
 * The distinction that matters is retryable versus not, and it cannot be guessed from the message
 * text: a 429 for a burst of requests and a 429 for an account with no credit left both arrive as
 * the same status, and only the first is worth trying again. Rate limits and overload carry the
 * provider's own `retry-after` when it sent one, because the provider knows better than an
 * exponential backoff curve when it will be ready.
 */
function normalizeOpenAiError(error, signal) {
  if (error instanceof AgentError) return error;
  if (signal?.aborted || error?.name === "AbortError") {
    return new AgentError({ code: "CANCELLED", message: "The run was cancelled.", retryable: false, cause: error });
  }
  if (!(error instanceof ProviderFailure)) {
    // `fetch` rejects when the request never got an answer: DNS, a reset connection, a timeout.
    return new AgentError({
      code: "PROVIDER_UNREACHABLE",
      message: "Could not reach the AI provider. The run will be retried.",
      retryable: true,
      cause: error,
    });
  }

  const { status, providerCode } = error;
  const retryAfterMs = retryAfterFrom(error.retryAfter);

  if (providerCode === "insufficient_quota") {
    // The account has run out of credit. Waiting does not refill it, so this is not a rate limit.
    return new AgentError({
      code: "PROVIDER_QUOTA_EXHAUSTED",
      message: "Orbik's AI provider account has no quota left.",
      retryable: false,
      cause: error,
    });
  }
  if (status === 429 || providerCode === "rate_limit_exceeded") {
    return new AgentError({
      code: "PROVIDER_RATE_LIMITED",
      message: "The AI provider is rate limiting Orbik. The run will be retried.",
      retryable: true,
      retryAfterMs,
      cause: error,
    });
  }
  if (status === 503 || providerCode === "server_is_overloaded") {
    return new AgentError({
      code: "PROVIDER_OVERLOADED",
      message: "The AI provider is temporarily overloaded. The run will be retried.",
      retryable: true,
      retryAfterMs,
      cause: error,
    });
  }
  if (status >= 500 || providerCode === "server_error" || providerCode === "stream_ended") {
    return new AgentError({
      code: "PROVIDER_UNAVAILABLE",
      message: "The AI provider failed to respond. The run will be retried.",
      retryable: true,
      retryAfterMs,
      cause: error,
    });
  }
  if (status === 401 || status === 403) {
    // Orbik's own credential is wrong or revoked. Retrying cannot fix it, and the message must
    // not hint at the key's value or shape — which the provider's own message does.
    return new AgentError({
      code: "PROVIDER_NOT_CONFIGURED",
      message: "Orbik's AI provider credentials were rejected.",
      retryable: false,
      cause: error,
    });
  }

  // A 400 is a bug in what Orbik sent — a tool schema the provider will not take, a prompt past
  // the model's window. Retrying sends the identical request and fails identically, so it is
  // reported rather than repeated, with the provider's own words about the request.
  const detail = String(error.message ?? "").replace(KEY_LIKE, "[key]").replace(/\s+/g, " ").trim().slice(0, MAX_PROVIDER_MESSAGE);
  return new AgentError({
    code: "PROVIDER_REQUEST_REJECTED",
    message: detail ? `The AI provider rejected the request: ${detail}` : "The AI provider rejected the request.",
    retryable: false,
    cause: error,
  });
}

/** Reads the provider's `retry-after` header, in milliseconds, when it sent one. */
function retryAfterFrom(header) {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 300) * 1000 : undefined;
}
