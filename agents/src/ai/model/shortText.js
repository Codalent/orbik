import { AGENT_CAPABILITIES } from "@orbik/protocol";

import { classifyFailure } from "../../runtime/errors.js";

/** The longest a text may be unless the caller says otherwise, in characters. */
const DEFAULT_MAX_CHARACTERS = 1200;

/**
 * The output ceiling of the one call, in tokens.
 *
 * Far more than a paragraph needs, on purpose: on a model that thinks before it answers the
 * thinking is spent from the same ceiling, and a ceiling sized for the paragraph alone would cut
 * the answer off before it began. It is still a ceiling — this call can never become a report.
 */
const MAX_OUTPUT_TOKENS = 2000;

/** How long the call may take before it is given up on. */
const TIMEOUT_MS = 60_000;

/**
 * Creates the writer plain code uses when it wants one short piece of prose from a model.
 *
 * Some agents are plain code with one sentence a model writes better: a report counted, ranked
 * and grouped by code, with only a two-line summary in prose. Such an agent must
 * still finish — and still store everything it worked out — on a deployment with no model at all,
 * when the provider is having a bad afternoon, and when the reply is empty. So this never throws.
 * It returns exactly one of three things, and the caller records whichever it got:
 *
 * - `{text, model, usage}` — the text, clipped to the caller's ceiling;
 * - `{skipped: true, reason}` — no call was made, because nothing here can serve the capability
 *   (`PROVIDER_NOT_CONFIGURED`, the code the Library scheduler gives for the same situation);
 * - `{failed: true, reason}` — a call was made, or was about to be, and produced no text.
 *
 * `reason` is `{code, message}`, safe to store and to show.
 *
 * It is one bounded call and nothing more: no tools, no conversation, a fixed output ceiling and a
 * timeout. It goes through the model router and the provider adapter like every other call, so
 * what serves `fast` work stays one operational decision, and the call is written to the AI call
 * log by the adapter with the run it belongs to. A caller that has nothing worth summarising
 * should not call it at all: the cheapest call is the one not made.
 *
 * Cancellation is reported like any other failure (`CANCELLED`), because by the time prose is
 * wanted the caller's real work is done and it is the caller's to decide whether a run that was
 * stopped at that point still stores what it has.
 *
 * @param {object} options collaborators
 * @param {ReturnType<import("./modelRouter.js").createModelRouter>} options.modelRouter chooses
 *   the model for a capability
 * @param {(level: string, message: string, context?: object) => void} [options.logger]
 * @returns {(request: object) => Promise<object>} the writer
 */
export function createShortTextWriter({ modelRouter, logger = () => {} }) {
  /**
   * Writes one short text.
   *
   * @param {object} request what to write
   * @param {string} request.system the instructions: what the text is and what it must not do
   * @param {string} request.prompt the facts to write from. Anything in them that came from a
   *   crawled site is untrusted, and the instructions should say so
   * @param {string} [request.capability] what kind of thinking it needs; `fast` unless said
   * @param {number} [request.maxCharacters] the longest text returned
   * @param {AbortSignal} [request.signal] cancellation from the worker
   * @param {object} [request.trace] what the call belongs to, for the call log: `runId`,
   *   `workspaceId`, `siteId`, `agentSlug`, `agentVersion`
   * @returns {Promise<{text: string, model: string, usage: object} | {skipped: true, reason: object}
   *   | {failed: true, reason: object}>}
   */
  return async function writeShortText({
    system,
    prompt,
    capability = AGENT_CAPABILITIES.fast,
    maxCharacters = DEFAULT_MAX_CHARACTERS,
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

    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    try {
      const response = await route.provider.complete({
        model: route.model,
        system,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        tools: [],
        maxTokens: Math.min(route.maxTokens, MAX_OUTPUT_TOKENS),
        effort: route.effort,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        trace: { ...trace, turn: 1 },
      });
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (!text) {
        return { failed: true, reason: { code: "MODEL_OUTPUT_EMPTY", message: "The model returned no text." } };
      }
      return { text: clip(text, maxCharacters), model: route.model, usage: response.usage };
    } catch (error) {
      // The adapter reports any aborted call as cancelled, and it cannot tell the worker's signal
      // from this function's own timeout. Only the first is somebody stopping the run.
      const failure = timeout.aborted && !signal?.aborted
        ? { code: "MODEL_TIMED_OUT", message: "The model did not answer in time." }
        : classifyFailure(error);
      logger("warn", "ai.short_text_failed", { code: failure.code, runId: trace.runId ? String(trace.runId) : null });
      return { failed: true, reason: { code: failure.code, message: failure.message } };
    }
  };
}

/** Keeps a text within a ceiling, marking the cut so it cannot be mistaken for the end. */
function clip(text, maxCharacters) {
  return text.length <= maxCharacters ? text : `${text.slice(0, maxCharacters - 1).trimEnd()}…`;
}
