/**
 * Turning text into the numbers a vector database can compare.
 *
 * This is the one place in Orbik that asks a model for vectors, and it does nothing else: no
 * reasoning, no summarising, no rewriting ever happens here. Reasoning uses the same provider and
 * the same key through the agents worker's own adapter; the two paths are kept apart on purpose.
 *
 * Three things follow from that, and all three are structural rather than promises:
 *
 * - **The key lives in the agents worker's environment only.** It is never written to a run
 *   and never echoed into an error — the failures below carry a status
 *   code and the provider's own message, which is about the request, not the credential.
 * - **The call sits behind an interface**, `embed(texts) → vectors`, so a local model or another
 *   provider is a second implementation of eight lines rather than a change anywhere else.
 * - **The model name travels with every point.** A workspace embedded with one model must not be
 *   queried with another — the vectors would be in different spaces and the scores meaningless —
 *   so the name is stored on each point's payload and a model change is a selective re-index
 *   rather than a silent corruption of every score.
 */

/** What OpenAI's small embedding model is called, and the shape it produces. */
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

/** Dimensions of each supported model's vector, which is also the Qdrant collection's width. */
export const EMBEDDING_DIMENSIONS = Object.freeze({
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
});

/**
 * OpenAI's list price for each supported model, in US dollars per million input tokens.
 *
 * Embeddings have input only: nothing is generated, so there is no output price. The figure is
 * recorded on each call in the AI call log, which is the only place it is used.
 */
const EMBEDDING_PRICES = Object.freeze({
  "text-embedding-3-small": 0.02,
  "text-embedding-3-large": 0.13,
});

/**
 * Texts sent in one request.
 *
 * The API accepts up to 2,048 inputs, but a batch is also the unit of retry: one failed request
 * costs a hundred passages rather than two thousand, and a hundred chunks of about 1,500 tokens is
 * already a request of some size. A failure leaves the state documents untouched, so the next tick
 * re-embeds exactly what did not land.
 */
export const EMBEDDING_BATCH = 100;

/** How long one embedding request may take before it is abandoned and retried on the next tick. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * A failure of the embedding provider, distinguished from everything else that can go wrong.
 *
 * `retryable` is the interesting field: a rate limit or a 500 is a reason to leave the index state
 * alone and try again in a minute, while a rejected key is a reason to stop and say so. The
 * indexer uses it to decide which, and neither case is ever allowed to crash a worker.
 */
class EmbeddingError extends Error {
  /**
   * @param {object} options failure detail
   * @param {string} options.code stable upper-case code
   * @param {string} options.message safe description; never carries the key
   * @param {boolean} [options.retryable] whether the next tick should try again
   */
  constructor({ code, message, retryable = false }) {
    super(message);
    this.name = "EmbeddingError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Creates the OpenAI implementation of the embedding interface.
 *
 * Written against `fetch` rather than the provider's SDK because the whole surface used is one
 * POST with a JSON body: a dependency would buy nothing and would put the credential inside a
 * client object whose logging behaviour Orbik does not control.
 *
 * Every request is reported to the AI call log when one is given: the texts, how many there
 * were, the tokens they came to and what that cost. The vectors are not — they are written to the
 * index, and a log carrying thousands of floats per call would be unreadable and enormous.
 *
 * @param {object} options
 * @param {string} options.apiKey the key, read from the agents worker's environment
 * @param {string} [options.model] the embedding model
 * @param {typeof fetch} [options.fetchImpl] injectable transport
 * @param {object} [options.callLog] the AI call log every request is reported to
 * @returns {{model: string, dimensions: number,
 *   embed: (texts: string[], options?: {trace?: object}) => Promise<number[][]>}}
 */
export function createOpenAiEmbedder({ apiKey, model = DEFAULT_EMBEDDING_MODEL, fetchImpl = fetch, callLog = null }) {
  if (!apiKey) {
    throw new EmbeddingError({
      code: "EMBEDDING_NOT_CONFIGURED",
      message: "No embedding key is configured on this worker.",
    });
  }
  const dimensions = EMBEDDING_DIMENSIONS[model];
  if (!dimensions) {
    throw new EmbeddingError({
      code: "EMBEDDING_MODEL_UNKNOWN",
      message: `${model} is not an embedding model this deployment knows the shape of.`,
    });
  }

  return {
    model,
    dimensions,

    /**
     * Embeds a batch of texts, in the order they were given.
     *
     * Order is part of the contract: the caller pairs the vectors back onto its chunks by index,
     * and the API preserves it. A caller that could not rely on it would have to send one text per
     * request.
     *
     * @param {string[]} texts at most {@link EMBEDDING_BATCH} passages
     * @param {object} [options]
     * @param {object} [options.trace] what the request is for, for the call log: `workspaceId`,
     *   and `runId`, `siteId`, `agentSlug` when a run is searching
     * @returns {Promise<number[][]>}
     */
    async embed(texts, { trace = {} } = {}) {
      if (!texts.length) return [];
      if (texts.length > EMBEDDING_BATCH) {
        throw new EmbeddingError({
          code: "EMBEDDING_BATCH_TOO_LARGE",
          message: `An embedding request may carry at most ${EMBEDDING_BATCH} texts.`,
        });
      }

      const record = await beginCall(callLog, {
        backend: "openai-api",
        purpose: "embedding",
        model,
        prompt: describeBatch(texts),
        inputs: texts.length,
        trace,
      });
      const pricing = { input: EMBEDDING_PRICES[model] ?? null };
      let usage = null;

      try {
        let response;
        try {
          response = await fetchImpl("https://api.openai.com/v1/embeddings", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model, input: texts }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
        } catch (error) {
          // A network failure or a timeout: the request never reached a decision, so the next tick
          // retrying it is correct rather than wasteful.
          throw new EmbeddingError({
            code: "EMBEDDING_UNREACHABLE",
            message: `The embedding provider could not be reached: ${error.name === "TimeoutError" ? "timed out" : error.message}.`,
            retryable: true,
          });
        }

        if (!response.ok) {
          const detail = await safeMessage(response);
          throw new EmbeddingError({
            code: response.status === 401 || response.status === 403 ? "EMBEDDING_NOT_AUTHORIZED" : "EMBEDDING_FAILED",
            message: `The embedding provider refused the request (${response.status})${detail ? `: ${detail}` : ""}.`,
            // Rate limits and provider outages pass; a rejected key does not, because retrying it
            // every minute forever would hide a misconfiguration behind an endlessly pending index.
            retryable: response.status === 429 || response.status >= 500,
          });
        }

        const body = await response.json();
        usage = readUsage(body);
        const vectors = (body?.data ?? [])
          .slice()
          .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
          .map((row) => row.embedding);
        if (vectors.length !== texts.length || vectors.some((vector) => !Array.isArray(vector) || vector.length !== dimensions)) {
          throw new EmbeddingError({
            code: "EMBEDDING_FAILED",
            message: "The embedding provider returned a reply that did not match the request.",
            retryable: true,
          });
        }

        await finishCall(record, {
          status: "succeeded",
          model: typeof body?.model === "string" ? body.model : model,
          usage,
          costUsd: costOf(usage, pricing),
          pricing,
          response: `${formatCount(vectors.length)} ${vectors.length === 1 ? "vector" : "vectors"} · ${formatCount(dimensions)} dimensions`,
        });
        return vectors;
      } catch (error) {
        await finishCall(record, {
          status: "failed",
          usage,
          costUsd: costOf(usage, pricing),
          pricing,
          error: { code: error?.code ?? "EMBEDDING_FAILED", message: error?.message ?? "" },
        });
        throw error;
      }
    },
  };
}

/**
 * Starts a call log entry, or returns null when there is no log or it could not be written.
 *
 * The log promises never to throw, but this module is handed whatever log its caller built, and an
 * embedding that worked must not fail because the record of it did not. The one exception is a
 * refusal over the workspace's plan, which is the log saying the call must not be made at all.
 */
async function beginCall(callLog, call) {
  if (!callLog) return null;
  try {
    return await callLog.begin(call);
  } catch (error) {
    if (error?.code === "PLAN_LIMIT_REACHED") throw error;
    return null;
  }
}

/** Completes a call log entry, for the same reason never letting the log fail the request. */
async function finishCall(record, outcome) {
  if (!record) return;
  try {
    await record.finish(outcome);
  } catch {
    // Evidence, not a precondition: the vectors are already in hand.
  }
}

/**
 * The texts of one request, numbered, as the prompt the call log shows.
 *
 * The log clips it to its own limit and says so, so a batch of a hundred long passages is kept
 * whole as far as the limit and marked where it was cut, never silently shortened.
 */
function describeBatch(texts) {
  const header = `${formatCount(texts.length)} ${texts.length === 1 ? "input" : "inputs"}`;
  return [header, ...texts.map((text, index) => `[${index + 1}]\n${text}`)].join("\n\n");
}

/** Reads the provider's token count, in Orbik's usage vocabulary, when it sent one. */
function readUsage(body) {
  const tokens = body?.usage?.prompt_tokens ?? body?.usage?.total_tokens;
  return Number.isFinite(tokens) && tokens >= 0 ? { inputTokens: tokens } : null;
}

/** Dollars at list price, or null when either the count or the price is unknown. */
function costOf(usage, pricing) {
  if (!usage || !Number.isFinite(pricing.input)) return null;
  return (usage.inputTokens * pricing.input) / 1_000_000;
}

function formatCount(value) {
  return value.toLocaleString("en-US");
}

/**
 * Reads a failure message from a provider response without letting it throw.
 *
 * The body of an error is the provider's own description of what was wrong with the request, and
 * having it is the difference between "the embedding provider refused the request (400)" and
 * knowing which field it objected to. The key was in a header, but a rejected key is quoted back
 * masked — "Incorrect API key provided: sk-proj-****abcd" — so anything shaped like one is cut
 * out before the message reaches an error, the index state, or the call log.
 */
async function safeMessage(response) {
  try {
    const body = await response.json();
    const message = body?.error?.message;
    return typeof message === "string" ? message.replace(KEY_LIKE, "[key]").slice(0, 300) : null;
  } catch {
    return null;
  }
}

/** A provider key, or a masked quotation of one. */
const KEY_LIKE = /\bsk-[A-Za-z0-9_*-]+/g;
