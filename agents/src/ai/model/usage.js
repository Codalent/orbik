import { findModel } from "@orbik/protocol";

/**
 * Pricing provider token usage at list price.
 *
 * The rates are the model catalog's (`MODEL_CATALOG` in `@orbik/protocol`), the one place a
 * model's list price is kept, so re-pricing is one edit reviewable as a diff. They are what the AI
 * call log's cost column is worked out from.
 */

/** Used when a model is not in the catalog, so an unknown model cannot look free. */
const FALLBACK_PRICE = Object.freeze({ input: 5, output: 25, cacheWrite: 1.25, cacheRead: 0.1 });

/**
 * The price one request is charged at: the model's, in the band its prompt falls in.
 *
 * A model with a second band (`longPrompt`, Claude Haiku 5.5's above 100,000 tokens) charges a
 * request by the length of its own prompt, every input token counted, cache reads and writes
 * included. So a price is always worked out for one call's usage and never for a sum of several,
 * which could cross a band none of them did.
 */
function priceFor(model, usage) {
  const price = findModel(model)?.price ?? FALLBACK_PRICE;
  const prompt = nonNegative(usage?.inputTokens) + nonNegative(usage?.cacheWriteTokens) + nonNegative(usage?.cacheReadTokens);
  const band = price.longPrompt && prompt > price.longPrompt.over ? price.longPrompt : price;
  return { input: band.input, output: band.output, cacheWrite: price.cacheWrite, cacheRead: price.cacheRead };
}

/**
 * Prices one call's usage in US dollars at the provider's list price.
 *
 * This is the figure the AI call log shows for a reasoning call. It is not an invoice: list
 * price, no discounts.
 *
 * @param {object} usage one call's token counts as the provider reported them
 * @param {string} model model identifier the usage came from
 * @returns {number} dollars, unrounded
 */
export function tokensToDollars(usage, model) {
  const price = priceFor(model, usage);
  const input = nonNegative(usage?.inputTokens);
  const output = nonNegative(usage?.outputTokens);
  const cacheWrite = nonNegative(usage?.cacheWriteTokens);
  const cacheRead = nonNegative(usage?.cacheReadTokens);
  return (
    ((input * price.input) +
      (output * price.output) +
      (cacheWrite * price.input * price.cacheWrite) +
      (cacheRead * price.input * price.cacheRead)) /
    1_000_000
  );
}

/**
 * The list price of each kind of token for one call, in US dollars per million.
 *
 * The same figures `tokensToDollars` multiplies out, with the cache multipliers already applied,
 * the band the call's prompt fell in, and the same fallback for a model not in the catalog. The AI
 * call log records them beside each call's cost, so a person can check the arithmetic, and a
 * re-pricing later does not change what an old call's breakdown says it was priced at.
 *
 * @param {string} model model identifier
 * @param {object} [usage] the call's token counts, which choose the band; an ordinary prompt's
 *   price without them
 * @returns {{input: number, output: number, cacheWrite: number, cacheRead: number}}
 */
export function ratesFor(model, usage = null) {
  const price = priceFor(model, usage);
  return {
    input: price.input,
    output: price.output,
    cacheWrite: price.input * price.cacheWrite,
    cacheRead: price.input * price.cacheRead,
  };
}

/**
 * Adds one call's usage into a running total for a run.
 *
 * An agent makes many provider calls in one run — a tool-use loop is a call per round trip — and
 * the run records the sum.
 *
 * @param {object} total accumulated usage, mutated in place
 * @param {object} usage one call's usage
 * @returns {object} the same accumulator, for chaining
 */
export function accumulateUsage(total, usage) {
  total.inputTokens = nonNegative(total.inputTokens) + nonNegative(usage?.inputTokens);
  total.outputTokens = nonNegative(total.outputTokens) + nonNegative(usage?.outputTokens);
  total.cacheWriteTokens = nonNegative(total.cacheWriteTokens) + nonNegative(usage?.cacheWriteTokens);
  total.cacheReadTokens = nonNegative(total.cacheReadTokens) + nonNegative(usage?.cacheReadTokens);
  total.calls = nonNegative(total.calls) + 1;
  return total;
}

/** An empty usage accumulator. */
export function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, calls: 0 };
}

/**
 * Treats a missing, negative, or non-numeric count as zero.
 *
 * Usage arrives from a provider response, so it is external input: a field a provider stops
 * sending must not turn into `NaN` and poison every total it is added to.
 */
function nonNegative(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
