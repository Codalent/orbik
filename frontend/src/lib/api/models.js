"use client";

import useSWR from "swr";

/**
 * The models this install offers, as the API reads them from the model catalog: the active
 * provider's tiers, most capable first, each `{tier, model, name, relativeCost}`, the default tier,
 * and the display name of every model the catalog knows (`names`). Also its cache key.
 *
 * A choice is always a tier key (`large`, `medium`, `small`), never a model: what a tier is changes
 * when the catalog moves it to a newer model, and a stored tier follows.
 */
export const MODELS_PATH = "/v1/ai/models";

/** An id's dated snapshot suffix, as a provider may answer with one. */
const SNAPSHOT_SUFFIX = /-\d{8}$/;

/**
 * Reads the models once and keeps them: they change only when the install is reconfigured.
 *
 * @returns {{models: {provider: string, defaultTier: string, tiers: Array<{tier: string, model: string, name: string, relativeCost: number|null}>, names: Record<string, string>}|undefined, error: unknown}}
 */
export function useModels() {
  const { data, error } = useSWR(MODELS_PATH, {
    revalidateOnFocus: false,
    revalidateIfStale: false,
    dedupingInterval: 60_000,
  });
  return { models: data, error };
}

/**
 * What a model is called, for the model that answered: the catalog's name for it, or the id as it
 * is when the catalog does not know it.
 *
 * @param {Record<string, string>|undefined} names `names` from {@link useModels}
 * @param {string|null|undefined} id the model's id, as the AI call log names it
 */
export function modelName(names, id) {
  if (!id) return null;
  return names?.[id] ?? names?.[id.replace(SNAPSHOT_SUFFIX, "")] ?? id;
}

/** Fractions a cost is said as, largest first. */
const FRACTIONS = Object.freeze([
  [1, "about the same cost"],
  [3 / 4, "about three quarters of the cost"],
  [2 / 3, "about two thirds of the cost"],
  [1 / 2, "about half the cost"],
  [1 / 3, "about a third of the cost"],
  [1 / 4, "about a quarter of the cost"],
  [1 / 5, "about a fifth of the cost"],
  [1 / 10, "about a tenth of the cost"],
]);

/**
 * A tier's cost beside the most capable, in plain words: "about half the cost", "a small fraction
 * of the cost". The figure is the API's, worked out from the catalog's list prices; this only says
 * it. Null for the most capable tier itself, and for a figure the API could not work out.
 *
 * @param {number|null|undefined} relative the tier's `relativeCost`: 1 the same, 0.5 half
 * @param {boolean} [top] whether this is the most capable tier
 */
export function costHint(relative, top = false) {
  if (top || !Number.isFinite(relative) || relative <= 0) return null;
  if (relative > 1.2) return `about ${Math.round(relative * 10) / 10} times the cost`;
  if (relative < 0.08) return "a small fraction of the cost";
  const [, words] = FRACTIONS.reduce((best, entry) => (
    Math.abs(Math.log(relative / entry[0])) < Math.abs(Math.log(relative / best[0])) ? entry : best
  ));
  return words;
}

/**
 * One line for a tier in a picker: its model's name and what it costs beside the most capable.
 *
 * @param {{name: string, relativeCost: number|null}} tier
 * @param {number} index its place, most capable first
 */
export function tierHint(tier, index) {
  return index === 0 ? "most capable" : costHint(tier.relativeCost);
}
