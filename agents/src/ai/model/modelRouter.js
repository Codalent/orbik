import { AGENT_CAPABILITIES } from "@orbik/protocol";

import { AgentError } from "../../runtime/errors.js";

/**
 * Chooses which model runs an agent, and how hard it is allowed to think.
 *
 * Routing lives here rather than in an agent definition because it is an operational decision, not
 * a product one. A definition says "this needs careful multi-step reasoning"; what satisfies that
 * changes when a new model ships, when one gets cheaper, or when one is having a bad afternoon —
 * and none of those should require editing, re-versioning, and re-publishing every agent.
 *
 * It is also what keeps Orbik from committing to a single provider. The router returns a provider
 * *name* alongside a model, so moving work to another provider is an adapter plus a row in a
 * table — which is how every capability came to be served by OpenAI, and then by Anthropic: the
 * adapter was there, and `DEFAULT_ROUTES` below was pointed at its table.
 *
 * @param {object} options router configuration
 * @param {Record<string, object>} options.providers adapters keyed by provider name
 * @param {Record<string, object>} [options.routes] capability to `{provider, model, effort,
 *   maxTokens}`, overridable so an operator can re-route without a code change
 */
export function createModelRouter({ providers, routes = DEFAULT_ROUTES }) {
  return {
    /**
     * Resolves the model and adapter for one agent definition.
     *
     * An unroutable capability is a permanent failure, not a retryable one: it means this
     * deployment has no provider configured that can serve the agent, and every retry against
     * this deployment will reach the same conclusion.
     *
     * @param {object} definition the agent definition being run
     * @returns {{provider: object, model: string, effort: string, maxTokens: number}}
     * @throws {AgentError} `NO_ROUTE` when nothing configured can serve the capability
     */
    resolve(definition) {
      const route = routes[definition.capability];
      const provider = route ? providers[route.provider] : null;
      if (!route || !provider) {
        throw new AgentError({
          code: "NO_ROUTE",
          message: `No AI provider is configured for ${definition.capability} work.`,
          retryable: false,
        });
      }
      return { provider, model: route.model, effort: route.effort, maxTokens: route.maxTokens };
    },

    /** Reports which capabilities this deployment can currently serve. */
    routable() {
      return Object.entries(routes)
        .filter(([, route]) => Boolean(providers[route.provider]))
        .map(([capability]) => capability);
    },
  };
}

/**
 * The capability-to-model table for Anthropic, which serves every model call but the embeddings.
 *
 * Every row names Anthropic, so every reasoning call Orbik makes — agent runs, the Library chat,
 * the short summaries plain-code agents ask for — is paid for with `ORBIK_ANTHROPIC_API_KEY`. The
 * embeddings are not routed here and stay on OpenAI, paid for with `ORBIK_OPENAI_API_KEY`. Careful
 * work and long-context work go to the same model. What sets them apart is how hard each is asked
 * to think.
 *
 * `effort` is the lever that matters most for cost here, and it is set per capability rather than
 * per run: `fast` work does not become better by thinking longer about it, and an audit does not
 * become cheaper by thinking less — it becomes wrong, and a wrong audit is worth nothing at any
 * price.
 *
 * `maxTokens` is generous because hitting the ceiling truncates a report mid-sentence and forces a
 * retry that pays for the whole turn again. On these models the ceiling also covers the model's
 * own thinking, which is why it is twice what the output alone would need.
 */
export const ANTHROPIC_ROUTES = Object.freeze({
  [AGENT_CAPABILITIES.fast]: Object.freeze({
    provider: "anthropic",
    model: "claude-haiku-5-5",
    effort: "low",
    maxTokens: 8_000,
  }),
  [AGENT_CAPABILITIES.reasoning]: Object.freeze({
    provider: "anthropic",
    model: "claude-opus-5-5",
    effort: "high",
    maxTokens: 64_000,
  }),
  [AGENT_CAPABILITIES.longContext]: Object.freeze({
    provider: "anthropic",
    model: "claude-opus-5-5",
    effort: "low",
    maxTokens: 64_000,
  }),
});

/**
 * The capability-to-model table for OpenAI, which served every call until Anthropic took over.
 *
 * Kept so that going back is pointing `DEFAULT_ROUTES` at it: the adapter is still registered
 * whenever `ORBIK_OPENAI_API_KEY` is set, which it is for the embeddings anyway.
 */
export const OPENAI_ROUTES = Object.freeze({
  [AGENT_CAPABILITIES.fast]: Object.freeze({
    provider: "openai",
    model: "gpt-6-luna",
    effort: "low",
    maxTokens: 8_000,
  }),
  [AGENT_CAPABILITIES.reasoning]: Object.freeze({
    provider: "openai",
    model: "gpt-6.1-sol",
    effort: "high",
    maxTokens: 64_000,
  }),
  [AGENT_CAPABILITIES.longContext]: Object.freeze({
    provider: "openai",
    model: "gpt-6.1-sol",
    effort: "low",
    maxTokens: 64_000,
  }),
});

/** The table the router uses unless it is handed another: Anthropic, for now. */
export const DEFAULT_ROUTES = ANTHROPIC_ROUTES;
