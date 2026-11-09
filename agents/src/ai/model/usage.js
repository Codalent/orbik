/**
 * Pricing provider token usage at list price.
 *
 * The rates below are provider list prices, kept in one place so re-pricing is one edit and is
 * reviewable as a diff. They are what the AI call log's cost column is worked out from.
 */

/**
 * Provider list prices in US dollars per million tokens, as published.
 *
 * Kept as published so that a price change can be checked against a provider's pricing page
 * without arithmetic. `cacheWrite` and `cacheRead` are the multipliers
 * the providers apply to cached input, not separate prices.
 *
 * The OpenAI rows are the standard prices for a request of up to 272,000 input tokens, read from
 * the provider's pricing page on 2026-10-07. A longer request is charged more per token, and no
 * run here is meant to be that long; one that was would be under-priced in the log.
 *
 * The Anthropic rows are the first-party list prices for a five-minute cache write. Claude Haiku
 * 5.5's are for a prompt of up to 100,000 tokens, which a short text always is; a longer one is
 * charged five times as much and would be under-priced in the log. Claude Opus 5 and Claude Opus
 * 4.8 are here as the models a declined Claude Opus 5.5 request falls back to.
 */
const MODEL_PRICES = Object.freeze({
  "gpt-6-astra": Object.freeze({ input: 10, output: 50, cacheWrite: 1.25, cacheRead: 0.1 }),
  "gpt-6.1-sol": Object.freeze({ input: 2, output: 10, cacheWrite: 1.25, cacheRead: 0.05 }),
  "gpt-6-luna": Object.freeze({ input: 0.1, output: 0.5, cacheWrite: 1.25, cacheRead: 0.1 }),
  "claude-opus-5-5": Object.freeze({ input: 4, output: 20, cacheWrite: 1.25, cacheRead: 0.05 }),
  "claude-opus-5": Object.freeze({ input: 5, output: 25, cacheWrite: 1.25, cacheRead: 0.1 }),
  "claude-opus-4-8": Object.freeze({ input: 5, output: 25, cacheWrite: 1.25, cacheRead: 0.1 }),
  "claude-sonnet-5-5": Object.freeze({ input: 2, output: 10, cacheWrite: 1.25, cacheRead: 0.1 }),
  "claude-sonnet-5": Object.freeze({ input: 2, output: 10, cacheWrite: 1.25, cacheRead: 0.1 }),
  "claude-haiku-5-5": Object.freeze({ input: 0.1, output: 0.5, cacheWrite: 1.25, cacheRead: 0.1 }),
  "claude-haiku-4-5": Object.freeze({ input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }),
});

/** Used when a model is not in the price table, so an unknown model cannot look free. */
const FALLBACK_PRICE = Object.freeze({ input: 5, output: 25, cacheWrite: 1.25, cacheRead: 0.1 });

/**
 * Prices one call's usage in US dollars at the provider's list price.
 *
 * This is the figure the AI call log shows for a reasoning call. It is not an invoice: list
 * price, no discounts, no tiers.
 *
 * @param {object} usage token counts as the provider reported them
 * @param {string} model model identifier the usage came from
 * @returns {number} dollars, unrounded
 */
export function tokensToDollars(usage, model) {
  const price = MODEL_PRICES[model] ?? FALLBACK_PRICE;
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
 * The list price of each kind of token for one model, in US dollars per million.
 *
 * The same figures `tokensToDollars` multiplies out, with the cache multipliers already applied
 * and the same fallback for a model not in the table. The AI call log records them beside each
 * call's cost, so a person can check the arithmetic, and a re-pricing later does not change what
 * an old call's breakdown says it was priced at.
 *
 * @param {string} model model identifier
 * @returns {{input: number, output: number, cacheWrite: number, cacheRead: number}}
 */
export function ratesFor(model) {
  const price = MODEL_PRICES[model] ?? FALLBACK_PRICE;
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
