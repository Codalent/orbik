/**
 * Plan limits: what one account — a workspace's owner — may use.
 *
 * Every field is a ceiling, and `null` means there is none. The open-source edition answers
 * {@link UNLIMITED} for every account; an extension that implements plans answers something else
 * through `host.setPlanLimits`. Core reads limits only through the host, never from a stored row,
 * so where a plan is kept and how it is priced is entirely the extension's business.
 *
 * - `monthlyCrawlPages`: page fetches a calendar month (UTC). Charged by the crawl budget.
 * - `maxWorkspaces`: workspaces the account may own.
 * - `maxMembersPerWorkspace`: people besides the owner in any one of its workspaces.
 * - `agents`: the agent slugs its workspaces may run, or `null` for every agent.
 * - `aiCalls`: whether model calls may be made on its behalf at all.
 */
export const UNLIMITED = Object.freeze({
  monthlyCrawlPages: null,
  maxWorkspaces: null,
  maxMembersPerWorkspace: null,
  agents: null,
  aiCalls: true,
});

/** The code every refusal over a plan limit carries, in the API's envelope and on a failed run. */
export const PLAN_LIMIT_REACHED = "PLAN_LIMIT_REACHED";

const CEILINGS = ["monthlyCrawlPages", "maxWorkspaces", "maxMembersPerWorkspace"];

/**
 * Fills in what a resolver left out with the unlimited default and refuses what is malformed.
 *
 * A resolver that returns a negative count or a list of numbers is a bug in the extension, and it
 * is thrown rather than read as "unlimited": silently lifting a cap because a plan row is broken
 * is the one failure a paid plan must never have.
 *
 * @param {Partial<typeof UNLIMITED> | null | undefined} value what a resolver returned
 * @returns {Readonly<typeof UNLIMITED>}
 */
export function normalizeLimits(value) {
  if (value === null || value === undefined) return UNLIMITED;
  if (typeof value !== "object") throw new TypeError("Plan limits must be an object.");
  const limits = { ...UNLIMITED };
  for (const key of CEILINGS) {
    const ceiling = value[key];
    if (ceiling === undefined || ceiling === null) continue;
    if (!Number.isSafeInteger(ceiling) || ceiling < 0) {
      throw new TypeError(`Plan limit ${key} must be a non-negative integer or null.`);
    }
    limits[key] = ceiling;
  }
  if (value.agents !== undefined && value.agents !== null) {
    if (!Array.isArray(value.agents) || value.agents.some((slug) => typeof slug !== "string")) {
      throw new TypeError("Plan limit agents must be a list of agent slugs or null.");
    }
    limits.agents = Object.freeze([...value.agents]);
  }
  if (value.aiCalls !== undefined) {
    if (typeof value.aiCalls !== "boolean") throw new TypeError("Plan limit aiCalls must be true or false.");
    limits.aiCalls = value.aiCalls;
  }
  return Object.freeze(limits);
}

/** Whether an account's limits let its workspaces run the agent with this slug. */
export function agentAllowed(limits, slug) {
  return limits.agents === null || limits.agents.includes(slug);
}

/**
 * Raised when an action would go past the acting account's plan.
 *
 * The API answers it as 403 `PLAN_LIMIT_REACHED`; the worker records it on the job and the run as
 * a failure that is not retried, because the same request is refused the same way until the plan
 * changes.
 */
export class PlanLimitError extends Error {
  /**
   * @param {object} options
   * @param {keyof typeof UNLIMITED} options.limit which limit refused it
   * @param {string} options.message what the person is told, in their terms
   */
  constructor({ limit, message }) {
    super(message);
    this.name = "PlanLimitError";
    this.code = PLAN_LIMIT_REACHED;
    this.limit = limit;
    this.status = 403;
    this.retryable = false;
  }
}
