/**
 * Reading a month's crawl budget as the API reports it.
 *
 * A month is limited — `allowance` and `remaining` are numbers — or unlimited: `unlimited` is
 * true, and `allowance` and `remaining` are null. The open-source edition is always unlimited; a
 * plan sets a ceiling. `consumed` is a number either way. Every component that shows or checks the
 * budget goes through these so that "unlimited" is never read as "nothing left".
 */

/** Whether the month has no ceiling. */
export function isUnlimited(budget) {
  return Boolean(budget) && (budget.unlimited === true || budget.allowance === null);
}

/** Whether the month can pay for this many more pages. */
export function hasBudgetFor(budget, pages = 1) {
  if (!budget) return false;
  return isUnlimited(budget) || (budget.remaining ?? 0) >= pages;
}

/** "1,234 of 5,000 pages left this month", or that the month is unlimited. */
export function budgetLeftLine(budget) {
  if (isUnlimited(budget)) return "No monthly page limit";
  return `${(budget.remaining ?? 0).toLocaleString()} of ${(budget.allowance ?? 0).toLocaleString()} pages left this month`;
}

/** "1,234 of 5,000 pages used this month", or how many were used with no limit. */
export function budgetUsedLine(budget) {
  const used = (budget.consumed ?? 0).toLocaleString();
  if (isUnlimited(budget)) return `${used} pages fetched this month, no limit`;
  return `${used} of ${(budget.allowance ?? 0).toLocaleString()} pages used this month`;
}
