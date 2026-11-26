/**
 * The model catalog: which models an install offers, what each is called, and what it costs.
 *
 * One file, so adding a model, moving a tier to a newer one or re-pricing is one reviewed edit.
 * It is read by the agents worker's model router (which model a tier is) and price table (what a
 * call cost), and by the API, which tells the web app what to offer and what each model is called.
 * The web app reads it through the API (`GET /v1/ai/models`), never by importing it.
 *
 * **A choice is a tier, never a model.** What a person picks and what is stored (on an agent's
 * setup, on a run, in a browser) is a tier key from {@link MODEL_TIERS}, which names no provider
 * and no model. Each provider lists its tiers here from most to least capable, each one model;
 * when a newer model replaces a tier's model in this file, every stored choice follows it with no
 * migration. The default is always a provider's first tier, its most capable. A provider may offer
 * fewer tiers than there are keys, and a stored tier the active provider lacks is served by the
 * default.
 *
 * A model nobody can choose may still be listed under `models`, with its name and price: one the
 * provider falls back to when a request is declined, or one older rows of the AI call log name.
 *
 * New models never appear here on their own. The provider's model list gives names and dates but
 * no prices, and a cost is worked out from this file, so a model is offered only once somebody has
 * added it with its price. The agents scheduler compares the provider's list with this file once a
 * day and says when it has fallen behind (`agents/src/ai/model/catalogCheck.js`).
 *
 * Prices are US dollars per million tokens, as published, so a change can be checked against a
 * provider's pricing page without arithmetic. `cacheWrite` and `cacheRead` are the multipliers the
 * provider applies to the input price for cached input, not prices of their own. `longPrompt` is a
 * second band some models charge for a request whose prompt (every input token, cache reads and
 * writes included) is longer than `over` tokens: its `input` and `output` replace the first band's
 * for that request, and the cache multipliers apply to its input price.
 *
 * This package has no dependencies, so the catalog is plain data and a few functions over it.
 */

/**
 * The tier keys, most capable first. Provider-neutral on purpose: a stored `medium` means "the
 * active provider's middle model", whichever provider that is and whichever model it is today.
 */
export const MODEL_TIERS = Object.freeze({ large: "large", medium: "medium", small: "small" });

/** Every tier key, most capable first. */
export const MODEL_TIER_VALUES = Object.freeze([MODEL_TIERS.large, MODEL_TIERS.medium, MODEL_TIERS.small]);

/** The tier used when nobody chose one: the most capable. */
export const DEFAULT_MODEL_TIER = MODEL_TIERS.large;

/** The provider the agents worker sends reasoning to when nothing says otherwise. */
export const DEFAULT_MODEL_PROVIDER = "anthropic";

/** Matches a dated snapshot suffix a provider may answer with, as in `claude-haiku-4-5-20251001`. */
const SNAPSHOT_SUFFIX = /-\d{8}$/;

/**
 * Each provider's tiers and the models it prices, read from the providers' pricing pages: the
 * Anthropic rows on 2026-11-26 (first-party list prices, five-minute cache writes), the OpenAI rows
 * on 2026-10-07.
 *
 * `family` says how a model's id names its family (`claude-opus-5-5` is an Opus), for the daily
 * check that looks for a newer model in a family a tier offers; a provider without one is not
 * checked.
 */
const CATALOG = {
  anthropic: {
    family: /^claude-([a-z]+)-\d/,
    tiers: [
      [MODEL_TIERS.large, "claude-opus-5-5"],
      [MODEL_TIERS.medium, "claude-sonnet-5-5"],
      [MODEL_TIERS.small, "claude-haiku-5-5"],
    ],
    models: {
      "claude-opus-5-5": { name: "Claude Opus 5.5", price: { input: 4, output: 20, cacheWrite: 1.25, cacheRead: 0.05 } },
      "claude-sonnet-5-5": { name: "Claude Sonnet 5.5", price: { input: 2, output: 10, cacheWrite: 1.25, cacheRead: 0.05 } },
      // Five times the price for a request whose prompt is longer than 100,000 tokens.
      "claude-haiku-5-5": {
        name: "Claude Haiku 5.5",
        price: { input: 0.1, output: 0.5, cacheWrite: 1.25, cacheRead: 0.1, longPrompt: { over: 100_000, input: 0.5, output: 2.5 } },
      },
      // Not offered: the models a declined Claude Opus 5.5 or Claude Sonnet 5.5 request may be
      // re-run on, and one older rows of the call log name.
      "claude-opus-5": { name: "Claude Opus 5", price: { input: 5, output: 25, cacheWrite: 1.25, cacheRead: 0.1 } },
      "claude-opus-4-8": { name: "Claude Opus 4.8", price: { input: 5, output: 25, cacheWrite: 1.25, cacheRead: 0.1 } },
      "claude-sonnet-5": { name: "Claude Sonnet 5", price: { input: 2, output: 10, cacheWrite: 1.25, cacheRead: 0.1 } },
      "claude-haiku-4-5": { name: "Claude Haiku 4.5", price: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } },
    },
  },
  openai: {
    family: null,
    tiers: [
      [MODEL_TIERS.large, "gpt-6.1-sol"],
      [MODEL_TIERS.small, "gpt-6-luna"],
    ],
    // The standard prices for a request of up to 272,000 input tokens. A longer request is charged
    // more per token, and no run here is meant to be that long; one that was would be under-priced
    // in the log.
    models: {
      "gpt-6.1-sol": { name: "GPT-6.1 Sol", price: { input: 2, output: 10, cacheWrite: 1.25, cacheRead: 0.05 } },
      "gpt-6-luna": { name: "GPT-6 Luna", price: { input: 0.1, output: 0.5, cacheWrite: 1.25, cacheRead: 0.1 } },
      "gpt-6-astra": { name: "GPT-6 Astra", price: { input: 10, output: 50, cacheWrite: 1.25, cacheRead: 0.1 } },
    },
  },
};

/**
 * The catalog by provider, checked and frozen: `{ family, tiers: [{tier, model, name}], models:
 * {[id]: {id, provider, name, price}} }`. A catalog that breaks its own rules stops every process
 * that imports it, at start, rather than routing a run to a model nobody priced.
 */
export const MODEL_CATALOG = Object.freeze(Object.fromEntries(
  Object.entries(CATALOG).map(([provider, entry]) => [provider, checkedProvider(provider, entry)]),
));

/** Every model the catalog names, by id, across providers. */
const MODELS = new Map(Object.values(MODEL_CATALOG).flatMap((entry) => Object.entries(entry.models)));

/** Checks one provider's entry and freezes it in the shape the functions below read. */
function checkedProvider(provider, entry) {
  const problems = [];
  const keys = entry.tiers.map(([tier]) => tier);
  if (keys[0] !== DEFAULT_MODEL_TIER) problems.push(`its first tier must be ${DEFAULT_MODEL_TIER}`);
  if (keys.some((tier) => !MODEL_TIER_VALUES.includes(tier))) problems.push("it names a tier that is not a tier key");
  if (keys.some((tier, index) => index > 0 && MODEL_TIER_VALUES.indexOf(tier) <= MODEL_TIER_VALUES.indexOf(keys[index - 1]))) {
    problems.push("its tiers must be listed from most to least capable, each once");
  }
  for (const [tier, model] of entry.tiers) {
    if (!entry.models[model]) problems.push(`its ${tier} tier names ${model}, which it does not price`);
  }
  for (const [id, model] of Object.entries(entry.models)) {
    const price = model.price ?? {};
    const rates = [price.input, price.output, price.cacheWrite, price.cacheRead, price.longPrompt?.input ?? 0, price.longPrompt?.output ?? 0];
    if (typeof model.name !== "string" || !model.name || rates.some((rate) => !Number.isFinite(rate) || rate < 0)) {
      problems.push(`${id} needs a name and a price`);
    }
  }
  if (problems.length) throw new Error(`The model catalog's ${provider} entry is wrong: ${problems.join("; ")}.`);

  const models = Object.fromEntries(Object.entries(entry.models).map(([id, model]) => [id, Object.freeze({
    id,
    provider,
    name: model.name,
    price: Object.freeze({ ...model.price, ...(model.price.longPrompt ? { longPrompt: Object.freeze({ ...model.price.longPrompt }) } : {}) }),
  })]));
  return Object.freeze({
    family: entry.family,
    tiers: Object.freeze(entry.tiers.map(([tier, model]) => Object.freeze({ tier, model, name: models[model].name }))),
    models: Object.freeze(models),
  });
}

/**
 * One provider's tiers, most capable first, or an empty list for a provider the catalog does not
 * know.
 *
 * @param {string} provider `anthropic` or `openai`
 * @returns {ReadonlyArray<{tier: string, model: string, name: string}>}
 */
export function providerTiers(provider) {
  return MODEL_CATALOG[provider]?.tiers ?? [];
}

/**
 * The model a tier is on one provider: the tier's own when the provider offers it, and the
 * default (its first, most capable tier) otherwise, with the tier that was used.
 *
 * @param {string} provider
 * @param {string|null|undefined} tier a tier key, or nothing for the default
 * @returns {{tier: string, model: string, name: string}|null} null for a provider with no tiers
 */
export function modelForTier(provider, tier) {
  const tiers = providerTiers(provider);
  return tiers.find((entry) => entry.tier === tier) ?? tiers[0] ?? null;
}

/**
 * One model of the catalog, offered or not, by its id; an id with a dated snapshot suffix is the
 * model it is a snapshot of.
 *
 * @param {string} id model identifier, as requested or as the provider answered
 * @returns {{id: string, provider: string, name: string, price: object}|null}
 */
export function findModel(id) {
  if (typeof id !== "string" || !id) return null;
  return MODELS.get(id) ?? MODELS.get(id.replace(SNAPSHOT_SUFFIX, "")) ?? null;
}

/** Whether a listed id is a catalog model, or a dated snapshot of it. */
export function isSameModel(id, model) {
  return id === model || (typeof id === "string" && id.replace(SNAPSHOT_SUFFIX, "") === model);
}

/**
 * Display names of every model the catalog knows, by id: what a page shows for the model that
 * answered. An id not here is shown as it is.
 *
 * @returns {Record<string, string>}
 */
export function modelNames() {
  return Object.fromEntries([...MODELS.values()].map((model) => [model.id, model.name]));
}

/**
 * What a model costs beside another, as one number: 1 is the same, 0.5 half. The mean of the two
 * ratios of their input and of their output prices, at an ordinary prompt's price (the first
 * band), since a run's cost is mostly one or the other and the catalog's tiers scale both alike.
 * Null when either model is not priced here.
 *
 * @param {string} model the model to describe
 * @param {string} reference the model it is set against, usually the provider's first tier's
 * @returns {number|null} rounded to three places
 */
export function relativeCost(model, reference) {
  const price = findModel(model)?.price;
  const base = findModel(reference)?.price;
  if (!price || !base || !base.input || !base.output) return null;
  const ratio = ((price.input / base.input) + (price.output / base.output)) / 2;
  return Math.round(ratio * 1000) / 1000;
}
