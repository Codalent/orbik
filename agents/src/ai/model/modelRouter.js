import { AGENT_CAPABILITIES, DEFAULT_MODEL_TIER, MODEL_TIERS, modelForTier } from "@orbik/protocol";

import { AgentError } from "../../runtime/errors.js";

/**
 * Chooses which model runs an agent, and how hard it is allowed to think.
 *
 * Routing lives here rather than in an agent definition because it is an operational decision, not
 * a product one. A definition says "this needs careful multi-step reasoning"; what satisfies that
 * changes when a new model ships, when one gets cheaper, or when one is having a bad afternoon —
 * and none of those should require editing, re-versioning, and re-publishing every agent.
 *
 * Two things decide a call. The **capability** (the kind of work) decides how hard the model
 * thinks and how much it may write, from the route table below. The **tier** decides which model
 * does it: a key from the model catalog (`MODEL_CATALOG` in `@orbik/protocol`), chosen by a person
 * for an Ask question or on the knowledge base's page, and the default, the provider's most
 * capable model, otherwise. The catalog says which model each tier is today, so a tier stored
 * months ago follows the catalog when a model is replaced; a tier the provider lacks is served by
 * the default.
 *
 * It is also what keeps Orbik from committing to a single provider. The router returns a provider
 * *name* alongside a model, so moving work to another provider is an adapter, a route table and
 * its tiers in the catalog. Which table a deployment uses is configuration, not code:
 * `ORBIK_AI_PROVIDER` chooses Anthropic or OpenAI (`routesFor` below), and the agents' config hands
 * that table in here.
 *
 * @param {object} options router configuration
 * @param {Record<string, object>} options.providers adapters keyed by provider name
 * @param {Record<string, object>} [options.routes] capability to `{provider, effort, maxTokens,
 *   tier?}`: the table of the provider `ORBIK_AI_PROVIDER` chose (`config.routes`)
 */
export function createModelRouter({ providers, routes = DEFAULT_ROUTES }) {
  return {
    /**
     * Resolves the model and adapter for one agent definition, on one tier.
     *
     * An unroutable capability is a permanent failure, not a retryable one: it means this
     * deployment has no provider configured that can serve the agent, and every retry against
     * this deployment will reach the same conclusion.
     *
     * @param {object} definition the agent definition being run, or `{capability}`
     * @param {object} [options]
     * @param {string|null} [options.tier] the tier the run was asked to use, already held to what
     *   the agent allows; the default when not given. A capability that names its own tier (`fast`)
     *   keeps it
     * @returns {{provider: object, model: string, tier: string, effort: string, maxTokens: number}}
     * @throws {AgentError} `NO_ROUTE` when nothing configured can serve the capability
     */
    resolve(definition, { tier = null } = {}) {
      const route = routes[definition.capability];
      const provider = route ? providers[route.provider] : null;
      const chosen = route ? modelForTier(route.provider, route.tier ?? tier ?? DEFAULT_MODEL_TIER) : null;
      if (!route || !provider || !chosen) {
        throw new AgentError({
          code: "NO_ROUTE",
          message: `No AI provider is configured for ${definition.capability} work.`,
          retryable: false,
        });
      }
      return { provider, model: chosen.model, tier: chosen.tier, effort: route.effort, maxTokens: route.maxTokens };
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
 * The route table for Anthropic, chosen with `ORBIK_AI_PROVIDER=anthropic`, or by default
 * whenever `ORBIK_ANTHROPIC_API_KEY` is set.
 *
 * Every row names Anthropic, so every reasoning call Orbik makes — agent runs, the Library chat,
 * the short summaries plain-code agents ask for — is paid for with `ORBIK_ANTHROPIC_API_KEY`. The
 * embeddings are not routed here and stay on OpenAI, paid for with `ORBIK_OPENAI_API_KEY`, whichever
 * table is chosen. A row names no model: the tier does, from the catalog (Claude Opus 5.5 unless
 * somebody chose another). What sets the kinds of work apart is how hard each is asked to think.
 *
 * `effort` is the lever that matters most for cost here, and it is set per capability rather than
 * per run: `fast` work does not become better by thinking longer about it, and an audit does not
 * become cheaper by thinking less — it becomes wrong, and a wrong audit is worth nothing at any
 * price. It stays the capability's whichever tier serves the work.
 *
 * `maxTokens` is generous because hitting the ceiling truncates a report mid-sentence and forces a
 * retry that pays for the whole turn again. On these models the ceiling also covers the model's
 * own thinking, which is why it is twice what the output alone would need.
 *
 * `fast` work names its own tier, the smallest, and keeps it whatever a run asked for: a short
 * rewrite is nobody's choice, and the most capable model would only make it slower and dearer.
 */
export const ANTHROPIC_ROUTES = Object.freeze({
  [AGENT_CAPABILITIES.fast]: Object.freeze({
    provider: "anthropic",
    tier: MODEL_TIERS.small,
    effort: "low",
    maxTokens: 8_000,
  }),
  [AGENT_CAPABILITIES.reasoning]: Object.freeze({
    provider: "anthropic",
    effort: "high",
    maxTokens: 64_000,
  }),
  [AGENT_CAPABILITIES.longContext]: Object.freeze({
    provider: "anthropic",
    effort: "low",
    maxTokens: 64_000,
  }),
});

/**
 * The route table for OpenAI, chosen with `ORBIK_AI_PROVIDER=openai`, or by default when
 * `ORBIK_OPENAI_API_KEY` is the only key set. Then one key, the one the embeddings need anyway,
 * pays for everything. Its tiers in the catalog are two: `large` and `small`.
 */
export const OPENAI_ROUTES = Object.freeze({
  [AGENT_CAPABILITIES.fast]: Object.freeze({
    provider: "openai",
    tier: MODEL_TIERS.small,
    effort: "low",
    maxTokens: 8_000,
  }),
  [AGENT_CAPABILITIES.reasoning]: Object.freeze({
    provider: "openai",
    effort: "high",
    maxTokens: 64_000,
  }),
  [AGENT_CAPABILITIES.longContext]: Object.freeze({
    provider: "openai",
    effort: "low",
    maxTokens: 64_000,
  }),
});

/** The reasoning providers `ORBIK_AI_PROVIDER` may name, each with its table. */
export const ROUTES_BY_PROVIDER = Object.freeze({
  anthropic: ANTHROPIC_ROUTES,
  openai: OPENAI_ROUTES,
});

/** The table the router uses unless it is handed another: Anthropic's. */
export const DEFAULT_ROUTES = ANTHROPIC_ROUTES;

/** The route table for a provider `ORBIK_AI_PROVIDER` names. */
export function routesFor(provider) {
  return ROUTES_BY_PROVIDER[provider] ?? DEFAULT_ROUTES;
}
