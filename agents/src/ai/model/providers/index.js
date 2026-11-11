import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAiProvider } from "./openai.js";

/**
 * The provider adapters this process can reach, keyed by the name a route uses.
 *
 * Decided once, from configuration, and the same way for everything that makes a model call — an
 * agent run, a short summary, a structured answer — so that "which providers does this deployment have"
 * has one answer. A provider is here when its credential is configured, and only then: a worker
 * with none still starts, and says what it cannot do on the first call rather than at start-up.
 *
 * Being here does not mean being used. The route table in `../modelRouter.js` that
 * `ORBIK_AI_PROVIDER` chose decides which provider serves each kind of work: all of it goes to
 * Anthropic or all of it to OpenAI. Both adapters are registered whenever their keys are set.
 *
 * @param {object} options
 * @param {object} options.config validated agent environment
 * @param {object} [options.callLog] the AI call log every call is reported to
 * @param {string} [options.purpose] what the calls are for, in the log; `agent-run` by default
 * @returns {Record<string, object>} adapters by provider name
 */
export function createProviders({ config, callLog = null, purpose = "agent-run" }) {
  const providers = {};
  if (config.openaiApiKey) {
    providers.openai = createOpenAiProvider({ apiKey: config.openaiApiKey, callLog, purpose });
  }
  if (config.anthropicApiKey) {
    providers.anthropic = createAnthropicProvider({ apiKey: config.anthropicApiKey, callLog, purpose });
  }
  return providers;
}
