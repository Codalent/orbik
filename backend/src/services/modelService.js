import { COLLECTIONS } from "@orbik/core";
import {
  DEFAULT_MODEL_PROVIDER,
  DEFAULT_MODEL_TIER,
  MODEL_CATALOG,
  modelNames,
  providerTiers,
  relativeCost,
} from "@orbik/protocol";

/** The `system_state` document the agents worker records its provider in (`recordAiAvailability`). */
const AI_STATE_ID = "ai";
const CACHE_MS = 15_000;

/**
 * What the web app is told about the models it may offer, from the model catalog
 * (`MODEL_CATALOG` in `@orbik/protocol`) and the provider the agents worker sends reasoning to.
 *
 * The API never calls a model, and the provider is chosen in the worker's environment, which this
 * process does not read: the worker records it in `system_state` (`_id: "ai"`) when it starts, and
 * this reads that record, at most every 15 seconds, like the edition's `ai`. Before a worker has
 * recorded one, or when the record cannot be read, it is the default provider, Anthropic.
 *
 * A tier is described by the model the catalog puts on it, that model's display name and what it
 * costs beside the provider's most capable model (`relativeCost`: 1 the same, 0.5 half), which the
 * web app words ("about half the cost").
 *
 * @param {object} options
 * @param {import("mongodb").Db} options.database
 * @param {() => number} [options.now]
 */
export function createModelService({ database, now = Date.now }) {
  const state = database.collection(COLLECTIONS.systemState);
  let cached = null;
  let cachedAt = 0;

  /** The provider reasoning goes to, as the worker last recorded it. */
  async function activeProvider() {
    if (cached && now() - cachedAt < CACHE_MS) return cached;
    let recorded = null;
    try {
      recorded = await state.findOne({ _id: AI_STATE_ID }, { projection: { provider: 1 } });
    } catch {
      return cached ?? DEFAULT_MODEL_PROVIDER;
    }
    cached = Object.hasOwn(MODEL_CATALOG, recorded?.provider ?? "") ? recorded.provider : DEFAULT_MODEL_PROVIDER;
    cachedAt = now();
    return cached;
  }

  /** The provider's tiers in the shape the web app draws, most capable first. */
  function describeTiers(provider, keep = () => true) {
    const tiers = providerTiers(provider);
    const top = tiers[0]?.model ?? null;
    return tiers.filter((entry) => keep(entry.tier)).map((entry) => ({
      tier: entry.tier,
      model: entry.model,
      name: entry.name,
      relativeCost: top ? relativeCost(entry.model, top) : null,
    }));
  }

  return {
    activeProvider,

    /**
     * Every tier of the active provider, for the Ask panel's picker, and the display name of every
     * model the catalog knows, for naming the model that answered (an answer may have come from a
     * model nobody can choose, such as one the provider fell back to).
     *
     * @returns {Promise<{provider: string, defaultTier: string, tiers: object[], names: Record<string, string>}>}
     */
    async catalog() {
      const provider = await activeProvider();
      return { provider, defaultTier: DEFAULT_MODEL_TIER, tiers: describeTiers(provider), names: modelNames() };
    },

    /**
     * One agent's model, for its page: the tiers it may use on the active provider, which its runs
     * use now, and whether a person can choose.
     *
     * `tier` is the stored choice when the agent allows it and the provider offers it, and the
     * default otherwise, which is what the worker does with the same choice. `settable` is false for
     * an agent whose definition allows only the default, and for one whose choice is made with each
     * request rather than stored (the Ask agents).
     *
     * @param {object} definition the agent's definition
     * @param {object} options
     * @param {string|null} [options.chosen] the tier stored on its setup
     * @param {boolean} [options.perRequest] whether its tier is chosen with each request
     */
    async forAgent(definition, { chosen = null, perRequest = false } = {}) {
      const provider = await activeProvider();
      const allowed = definition.modelTiers ?? [DEFAULT_MODEL_TIER];
      const tiers = describeTiers(provider, (tier) => allowed.includes(tier));
      return {
        provider,
        settable: allowed.length > 1 && !perRequest,
        defaultTier: DEFAULT_MODEL_TIER,
        tier: tiers.some((entry) => entry.tier === chosen) ? chosen : DEFAULT_MODEL_TIER,
        tiers,
      };
    },
  };
}
