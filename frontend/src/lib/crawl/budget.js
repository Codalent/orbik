import { formatBudgetDay } from "./format";

/**
 * Reading a month's crawl budget as the API reports it.
 *
 * A month is limited — `allowance` and `remaining` are numbers — or unlimited: `unlimited` is
 * true, and `allowance` and `remaining` are null. The open-source edition is always unlimited; a
 * plan sets a ceiling. `consumed` is a number either way. Every component that shows or checks the
 * budget goes through these so that "unlimited" is never read as "nothing left".
 *
 * `state` is the API's name for the month's situation (`BUDGET_STATE` in `@orbik/crawl-budget`):
 * `unlimited`, `available`, `spent` — the month had pages and has none left — or `not-included`,
 * an allowance of zero: the plan includes no crawling, which is not something that was spent and
 * is never worded as if it were. `resumesAt` is the day crawling comes back by itself, or null when
 * it will not; nothing here promises a date the API did not give.
 */

/** The month's situations, as the API names them. */
export const BUDGET_STATE = Object.freeze({
  unlimited: "unlimited",
  available: "available",
  spent: "spent",
  notIncluded: "not-included",
});

/** The codes the API refuses a crawl with when the budget cannot pay for a single page. */
export const BUDGET_REFUSALS = new Set(["CRAWL_NOT_INCLUDED", "CRAWL_BUDGET_SPENT"]);

/** Whether the month has no ceiling. */
export function isUnlimited(budget) {
  return Boolean(budget) && (budget.unlimited === true || budget.allowance === null);
}

/**
 * The month's situation: the API's `state`, or the same reading of its figures from an API that
 * predates the field.
 */
export function budgetStateOf(budget) {
  if (!budget) return null;
  if (budget.state) return budget.state;
  if (isUnlimited(budget)) return BUDGET_STATE.unlimited;
  if ((budget.remaining ?? 0) > 0) return BUDGET_STATE.available;
  return (budget.allowance ?? 0) > 0 ? BUDGET_STATE.spent : BUDGET_STATE.notIncluded;
}

/** Whether the month can pay for this many more pages. */
export function hasBudgetFor(budget, pages = 1) {
  if (!budget) return false;
  return isUnlimited(budget) || (budget.remaining ?? 0) >= pages;
}

/**
 * Why a crawl cannot be asked for — the sentence a disabled button carries — or null when one can.
 * The API refuses the same crawls with the same reasons (`CRAWL_NOT_INCLUDED`,
 * `CRAWL_BUDGET_SPENT`); this only says so before anybody presses.
 */
export function crawlBlockedReason(budget) {
  const state = budgetStateOf(budget);
  const resumes = budget?.resumesAt ? formatBudgetDay(budget.resumesAt) : null;
  if (state === BUDGET_STATE.notIncluded) {
    return resumes
      ? `This workspace's plan includes no crawl pages this month. Crawling can start ${resumes}.`
      : "This workspace's plan includes no crawl pages, so no page can be fetched.";
  }
  if (state === BUDGET_STATE.spent) {
    return `This month's crawl pages are spent.${resumes ? ` Crawling resumes ${resumes}.` : ""}`;
  }
  return null;
}

/** "1,234 of 5,000 pages left this month", or that the month is unlimited or includes none. */
export function budgetLeftLine(budget) {
  if (isUnlimited(budget)) return "No monthly page limit";
  if (budgetStateOf(budget) === BUDGET_STATE.notIncluded) return "No crawl pages in this plan";
  return `${(budget.remaining ?? 0).toLocaleString()} of ${(budget.allowance ?? 0).toLocaleString()} pages left this month`;
}

/** "1,234 of 5,000 pages used this month", or how many were used with no limit. */
export function budgetUsedLine(budget) {
  const used = (budget.consumed ?? 0).toLocaleString();
  if (isUnlimited(budget)) return `${used} pages fetched this month, no limit`;
  if (budgetStateOf(budget) === BUDGET_STATE.notIncluded) return "No crawl pages in this plan";
  return `${used} of ${(budget.allowance ?? 0).toLocaleString()} pages used this month`;
}
