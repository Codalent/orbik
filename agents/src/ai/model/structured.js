import { AGENT_CAPABILITIES } from "@orbik/protocol";

import { classifyFailure } from "../../runtime/errors.js";

/**
 * The output ceiling of the one call, in tokens, unless the caller says otherwise.
 *
 * Generous, as the short-text writer's is and for the same reason: on a model that thinks before
 * it answers the thinking is spent from the same ceiling, and an object cut off before its closing
 * brace is not an object at all. It is still a ceiling — this is one answer, never a conversation.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

/** How long the call may take before it is given up on, unless the caller says otherwise. */
const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Creates the writer plain code uses when it wants one structured answer from a model.
 *
 * The sibling of the short-text writer (`./shortText.js`), for the plain-code agent whose question
 * is not "say this in two sentences" but "here is what was measured, and here is a picture of it:
 * which of these greys is the border colour?". Two things differ, and nothing else does:
 *
 * - **The reply is JSON matching a schema**, asked for through the provider's structured output,
 *   so the caller gets an object or a stated failure — never prose to dig an object out of.
 * - **The question may carry pictures**, as base64 bytes beside the text.
 *
 * Like that writer it never throws, because a plain-code agent must still finish and still store
 * everything it worked out on a deployment with no model, on a bad afternoon at the provider, and
 * when the reply is not what was asked for. It returns exactly one of three things:
 *
 * - `{value, model, usage}` — the parsed object, after the caller's own check accepted it;
 * - `{skipped: true, reason}` — no call was made, because nothing here can serve the capability
 *   (`PROVIDER_NOT_CONFIGURED`);
 * - `{failed: true, reason}` — a call was made and produced nothing usable.
 *
 * `reason` is `{code, message}`, safe to store and to show.
 *
 * It is one bounded call: no tools, no conversation, an output ceiling and a timeout. It goes
 * through the model router and the provider adapter like every other call, so what serves a
 * capability stays one operational decision, and the adapter writes it to the AI call log with
 * the run it belongs to.
 *
 * @param {object} options collaborators
 * @param {ReturnType<import("./modelRouter.js").createModelRouter>} options.modelRouter chooses
 *   the model for a capability
 * @param {(level: string, message: string, context?: object) => void} [options.logger]
 * @returns {(request: object) => Promise<object>} the writer
 */
export function createStructuredWriter({ modelRouter, logger = () => {} }) {
  /**
   * Asks one question and returns one object.
   *
   * @param {object} request what to ask
   * @param {string} request.system the instructions: what the object is and what it must not claim
   * @param {string} request.prompt the facts to answer from. Anything in them that came from a
   *   crawled site is untrusted, and the instructions should say so
   * @param {Array<{mimeType: string, data: string, label?: string, detail?: string, reference?: object}>} [request.images]
   *   pictures to show, base64-encoded, each introduced by its label. `detail` is how closely the
   *   provider is asked to look (`low`, `high`; its own choice when omitted). `reference` says
   *   where a picture came from — an address, a hash — for the AI call log, which keeps it in
   *   place of the bytes; it is not sent to the model
   * @param {{name: string, schema: object}} request.format the JSON schema the reply must match
   * @param {(value: object) => object} [request.parse] the caller's own check of the reply; it
   *   returns the value to keep, or throws to refuse it
   * @param {string} [request.capability] what kind of thinking it needs; `reasoning` unless said
   * @param {number} [request.maxTokens] the output ceiling
   * @param {number} [request.timeoutMs] how long the call may take
   * @param {AbortSignal} [request.signal] cancellation from the worker
   * @param {object} [request.trace] what the call belongs to, for the call log
   * @returns {Promise<{value: object, model: string, usage: object} | {skipped: true, reason: object}
   *   | {failed: true, reason: object}>}
   */
  return async function writeStructured({
    system,
    prompt,
    images = [],
    format,
    parse = (value) => value,
    capability = AGENT_CAPABILITIES.reasoning,
    maxTokens = DEFAULT_MAX_OUTPUT_TOKENS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    trace = {},
  }) {
    let route;
    try {
      route = modelRouter.resolve({ capability });
    } catch (error) {
      // Nothing configured can serve this, and every later attempt on this deployment would find
      // the same. Not a failure of the caller's run: the deployment simply has no model.
      return { skipped: true, reason: { code: "PROVIDER_NOT_CONFIGURED", message: classifyFailure(error).message } };
    }

    // The text first, then each picture after the line that says what it is.
    const content = [{ type: "text", text: prompt }];
    for (const image of images) {
      if (image.label) content.push({ type: "text", text: image.label });
      content.push({
        type: "image",
        mimeType: image.mimeType,
        data: image.data,
        label: image.label ?? null,
        // How closely the provider looks, when the caller has a reason to say; and where the
        // picture came from, which is for the call log and is never sent.
        ...(image.detail ? { detail: image.detail } : {}),
        ...(image.reference ? { reference: image.reference } : {}),
      });
    }

    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const response = await route.provider.complete({
        model: route.model,
        system,
        messages: [{ role: "user", content }],
        tools: [],
        maxTokens: Math.min(route.maxTokens, maxTokens),
        effort: route.effort,
        format,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        trace: { ...trace, turn: 1 },
      });
      if (response.stopReason === "max_tokens") {
        return { failed: true, reason: { code: "MODEL_OUTPUT_TRUNCATED", message: "The model's answer was cut off before it was complete." } };
      }
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
      if (!text) {
        return { failed: true, reason: { code: "MODEL_OUTPUT_EMPTY", message: "The model returned no answer." } };
      }
      let value;
      try {
        value = parse(JSON.parse(text));
      } catch (error) {
        // The provider promised the schema's shape; the caller's check is about what a schema
        // cannot say. Either way the answer is not one to store.
        logger("warn", "ai.structured_invalid", { runId: trace.runId ? String(trace.runId) : null, message: String(error?.message ?? "").slice(0, 200) });
        return { failed: true, reason: { code: "MODEL_OUTPUT_INVALID", message: "The model's answer was not in the shape that was asked for." } };
      }
      return { value, model: route.model, usage: response.usage };
    } catch (error) {
      // The adapter reports any aborted call as cancelled, and it cannot tell the worker's signal
      // from this function's own timeout. Only the first is somebody stopping the run.
      const failure = timeout.aborted && !signal?.aborted
        ? { code: "MODEL_TIMED_OUT", message: "The model did not answer in time." }
        : classifyFailure(error);
      logger("warn", "ai.structured_failed", { code: failure.code, runId: trace.runId ? String(trace.runId) : null });
      return { failed: true, reason: { code: failure.code, message: failure.message } };
    }
  };
}
