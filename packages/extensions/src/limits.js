/**
 * Plan limits: what one workspace may use, and, for the one question that is not a workspace's,
 * what its owner's account may.
 *
 * Every field is a ceiling, and `null` means there is none. The open-source edition answers
 * {@link UNLIMITED} for everything; an extension that implements plans answers something else
 * through `host.setPlanLimits`, which is asked with a workspace's `ownerId` and `workspaceId`, or
 * with `workspaceId: null` for an account's own question. Core reads limits only through the host,
 * never from a stored row, so where a plan is kept, whether it belongs to a workspace or to an
 * account, and how it is priced are entirely the extension's business.
 *
 * - `monthlyCrawlPages`: the workspace's page fetches a calendar month (UTC). Charged by the crawl
 *   budget, which keeps one month per workspace.
 * - `maxWorkspaces`: workspaces the account may own. Asked with `workspaceId: null`.
 * - `maxMembersPerWorkspace`: people besides the owner in the workspace.
 * - `agents`: the agent slugs the workspace may run, or `null` for every agent.
 * - `aiCalls`: whether model calls may be made for the workspace at all, embeddings included.
 * - `reasoningCalls`: whether calls other than embeddings may be made: agent runs, chats, short
 *   texts. `false` with `aiCalls: true` keeps a workspace's pages indexed and searchable while
 *   nothing reasons for it, which is what a deployment wants when an allowance of model usage is
 *   spent. `aiCalls: false` refuses everything, whatever this says.
 */
export const UNLIMITED = Object.freeze({
  monthlyCrawlPages: null,
  maxWorkspaces: null,
  maxMembersPerWorkspace: null,
  agents: null,
  aiCalls: true,
  reasoningCalls: true,
});

/** The code every refusal over a plan limit carries, in the API's envelope and on a failed run. */
export const PLAN_LIMIT_REACHED = "PLAN_LIMIT_REACHED";

const CEILINGS = ["monthlyCrawlPages", "maxWorkspaces", "maxMembersPerWorkspace"];
const SWITCHES = ["aiCalls", "reasoningCalls"];

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
  for (const key of SWITCHES) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "boolean") throw new TypeError(`Plan limit ${key} must be true or false.`);
    limits[key] = value[key];
  }
  return Object.freeze(limits);
}

/** Whether a workspace's limits let it run the agent with this slug. */
export function agentAllowed(limits, slug) {
  return limits.agents === null || limits.agents.includes(slug);
}

/**
 * Raised when an action would go past the plan of the workspace it is for (or, for creating a
 * workspace, of the account).
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
