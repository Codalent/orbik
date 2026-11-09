/**
 * The names work is queued and recorded under: every registered agent, and every job type each one
 * handles.
 *
 * They live in one neutral module rather than with their agents because agents do not import each
 * other. The crawler hands a site over to the Library by queueing the Library's job types, and the
 * runtime's queue and worker need to recognise the crawler's jobs; both would otherwise reach into
 * another agent's folder for a string. Every agent and the runtime may import this; it imports
 * nothing of theirs.
 *
 * The values are persisted. Jobs in `agent_jobs` and runs in `agent_runs` carry them, and a job is
 * routed to its handler by them, so changing one strands every row already written under the old
 * spelling.
 */

/** The registered agent that crawls sites: deterministic code, no model. */
export const CRAWLER_AGENT = "crawler";

/** The registered agent that executes agent definitions, with a model or with plain code. */
export const AI_AGENT = "ai";

/** The registered agent every Library stage that is plain code runs under. */
export const LIBRARY_AGENT = "library";

/** The crawler's job types, in the order a crawl passes through them. */
export const CRAWLER_JOBS = Object.freeze({
  discover: "crawler.discover",
  discoverPage: "crawler.discover-page",
  startFetch: "crawler.start-fetch",
  fetch: "crawler.fetch",
  finalize: "crawler.finalize",
});

/** The one job type of the AI agent: execute the run a job names. */
export const AI_JOBS = Object.freeze({ execute: "ai.execute" });

/**
 * The Library agent's queued stages, by the job type each is enqueued as.
 *
 * The third stage — writing the subject tree — is not here because it is not a job type of this
 * agent: it is a run of the `business-knowledge-base` definition, executed by the `ai` agent like
 * every other conversation with a model.
 *
 * The first stage was `notes.write` while it wrote a model's note per page. It copies pages now,
 * and has a name of its own rather than the old one with a new meaning: a job queued under the
 * old type by a worker that predates the change is removed on start (`db/indexes.js`).
 */
export const LIBRARY_JOBS = Object.freeze({
  mirror: "sources.mirror",
  embed: "index.embed",
  // Not a stage of its own: the one question asked between the first two stages and the first
  // write run — which top-level folders the Library should have — whose answer a person chooses
  // from. See `library/structure.js`.
  suggest: "structure.suggest",
});

/** The idempotency-key prefix of each stage, which is also what its log lines are named after. */
const KEY_PREFIX = Object.freeze({
  [LIBRARY_JOBS.mirror]: "sources",
  [LIBRARY_JOBS.embed]: "index",
  [LIBRARY_JOBS.suggest]: "structure",
});

/**
 * Describes one pass of a Library stage, ready for `queue.enqueue`.
 *
 * It lives here rather than with the Library agent because the callers are not only the agent: the
 * crawler handing a site over and the Library's scheduler noticing a change both queue these, and
 * agents do not import each other. One builder for all of them, so a pass queued by one is
 * recognisable as the same pass by the others. The default key is the workspace and the pass
 * number with no timestamp, so while a pass is in flight a second request for it adds nothing.
 *
 * @param {string} type one of {@link LIBRARY_JOBS}
 * @param {object} options
 * @param {import("mongodb").ObjectId} options.workspaceId the workspace whose Library this is
 * @param {import("mongodb").ObjectId|null} [options.siteId] the crawl site its pages come from
 * @param {number} [options.pass] which continuation of the stage this is
 * @param {string} [options.idempotencyKey] a key other than the default, for a hand-off that must
 *   be queued once per event rather than once per pass
 */
export function libraryJob(type, { workspaceId, siteId = null, pass = 0, idempotencyKey }) {
  return {
    agent: LIBRARY_AGENT,
    type,
    payload: {
      workspaceId: workspaceId.toHexString(),
      siteId: siteId ? siteId.toHexString() : null,
      pass,
    },
    workspaceId,
    siteId: siteId ?? null,
    priority: 7,
    idempotencyKey: idempotencyKey ?? `${KEY_PREFIX[type]}:${workspaceId.toHexString()}:${pass}`,
  };
}
