import { AGENT_COLLECTIONS, KNOWLEDGE_AGENT_SLUG, log } from "@orbik/core";
import { SYNTHESIS_PAGE_CEILING } from "@orbik/library";

import { CRAWLER_AGENT, LIBRARY_AGENT, LIBRARY_JOBS, libraryJob } from "../jobs.js";
import { MAX_PAGES_PER_PASS, mirrorWorkspace } from "./mirror/pass.js";
import { requireObjectId } from "../runtime/errors.js";
import { JOB_STATUS } from "../runtime/queue.js";
import { findSite } from "./scope.js";

/** How long a pass that found the workspace busy waits before it looks again, the first time. */
const PUT_OFF_MS = 30_000;

/** The longest it waits between looks, however long the crawl ahead of it runs. */
const PUT_OFF_CEILING_MS = 4 * 60_000;

/**
 * The Library agent's first stage: keeps a workspace's source layer in step with its crawled
 * pages, and chooses the pages the knowledge base is written from.
 *
 * Like the embedding stage beside it, this is a handler rather than an agent *definition*: there
 * are no instructions and nothing a person sets, because which pages moved is a hash comparison,
 * where each goes is a rule, and which of them matter is a ranking by who links to them. **No
 * model is called here at all.** A worker with no model key runs it exactly as one with a key
 * does, which is why a workspace with no model still has its site in the Library and in the index.
 *
 * Being a handler of a registered agent is what gets it leases, retries, backoff, heartbeats and
 * crash recovery from the queue instead of from anything written here.
 *
 * **It is never enqueued by the API.** A pass is created by the crawler's finalize step, which has
 * just rewritten the pages this reads, or by `libraryScheduler.js` for the changes no crawl made:
 * a page somebody asked for, a pass that failed halfway.
 *
 * **A pass is bounded and resumes itself.** A first pass over a five-thousand-page site is five
 * thousand files; one job that wrote all of them would hold a lease for the whole of it. So a pass
 * copies a bounded number of pages and re-queues itself while any remain, and an interrupted
 * first run leaves every file it had already written behind.
 *
 * **It does not start the stage after it.** Whether the chosen pages moved far enough to rewrite
 * the Library is the scheduler's question, asked of what this leaves behind (`movedAt`) once no
 * pass is in flight. A pass that queued the writing itself would do it once per batch.
 *
 * **One pass at a time per workspace, and none while its site is being crawled.** A pass decides
 * where every page goes from its own reading of which paths are taken and which URLs are
 * duplicates, so two at once each copy pages the other has placed, and one during a crawl copies
 * pages the crawl has not yet grouped. Both happened on 2026-10-12: the scheduler's pass started
 * while the crawl was still folding duplicates, the crawl's own hand-off started beside it, and the
 * site was left with pages stored twice and `http://` twins stored as pages. So a pass that finds
 * either going puts itself off and looks again, rather than starting; the queue alone could not
 * prevent it, because each of the three callers queues under its own key.
 *
 * @param {object} [options] collaborators
 * @param {(level: string, message: string, context?: object) => void} [options.logger]
 * @returns {(job: object, context: object) => Promise<object>} the `sources.mirror` handler
 */
export function createMirrorHandler({ logger = log } = {}) {
  return async function mirror(job, { database, signal, heartbeat }) {
    const workspaceId = requireObjectId(job.payload?.workspaceId ?? job.workspaceId, "workspaceId", "A mirror job");
    const pass = Number.isInteger(job.payload?.pass) ? job.payload.pass : 0;

    const siteId = job.payload?.siteId
      ? requireObjectId(job.payload.siteId, "siteId", "A mirror job")
      : await findSite(database, workspaceId);

    const busy = await busyWith({ database, job, workspaceId, siteId });
    if (busy) {
      const waits = (Number.isInteger(job.payload?.waits) ? job.payload.waits : 0) + 1;
      logger("info", "sources.pass_put_off", { workspaceId: workspaceId.toHexString(), reason: busy, pass, waits });
      return { counters: { passesPutOff: 1 }, enqueue: [putOff({ workspaceId, siteId, pass, waits })] };
    }

    const counters = await mirrorWorkspace({
      database,
      workspaceId,
      siteId,
      limit: MAX_PAGES_PER_PASS,
      ceiling: await ceilingFor(database, workspaceId),
      heartbeat,
      signal,
      logger,
    });

    logger(counters.failed ? "warn" : "info", "sources.pass_finished", {
      workspaceId: workspaceId.toHexString(),
      ...counters,
    });

    return {
      counters: {
        pagesMirrored: counters.mirrored,
        pagesUnchanged: counters.unchanged,
        pagesNotStored: counters.skipped,
        pagesChosen: counters.chosen,
        sourcesRemoved: counters.removed,
        pagesFailed: counters.failed,
        copiesSwept: counters.orphans,
        copiesMoved: counters.relocated,
      },
      // Re-queued rather than looped, so the lease, the retry count and the shutdown grace all
      // keep applying to each piece of it. A pass whose every page failed does not re-queue:
      // the failures are recorded and the scheduler's next tick, which notices them, decides
      // whether to try again.
      enqueue: counters.remaining > 0 && counters.mirrored > 0
        ? [libraryJob(LIBRARY_JOBS.mirror, { workspaceId, siteId, pass: pass + 1 })]
        : [],
    };
  };
}

/**
 * What a pass has to wait for, or null when it may start.
 *
 * The site's crawl, while any job of it is queued or running: duplicates are folded and pages
 * ranked when it finishes, and it hands the site over then. And a pass of the same workspace that
 * was claimed before this one and still holds its lease. Of two claimed at the same moment the one
 * with the lower id goes first, so they cannot both wait for each other.
 *
 * @returns {Promise<"CRAWL_IN_FLIGHT"|"MIRROR_IN_FLIGHT"|null>}
 */
async function busyWith({ database, job, workspaceId, siteId }) {
  // A pass run from a script rather than claimed from the queue has nothing to compare itself with.
  if (!job._id || !job.startedAt) return null;
  const jobs = database.collection(AGENT_COLLECTIONS.jobs);
  const [crawling, ahead] = await Promise.all([
    siteId
      ? jobs.findOne(
        { agent: CRAWLER_AGENT, siteId, status: { $in: [JOB_STATUS.pending, JOB_STATUS.running] } },
        { projection: { _id: 1 } },
      )
      : null,
    jobs.findOne(
      {
        _id: { $ne: job._id },
        agent: LIBRARY_AGENT,
        type: LIBRARY_JOBS.mirror,
        workspaceId,
        status: JOB_STATUS.running,
        leaseUntil: { $gt: new Date() },
        $or: [{ startedAt: { $lt: job.startedAt } }, { startedAt: job.startedAt, _id: { $lt: job._id } }],
      },
      { projection: { _id: 1 } },
    ),
  ]);
  if (crawling) return "CRAWL_IN_FLIGHT";
  if (ahead) return "MIRROR_IN_FLIGHT";
  return null;
}

/**
 * The same pass, queued to look again after a wait that grows each time it is put off.
 *
 * Under one of two keys, taken in turn, rather than its own: a job's own key is still in flight
 * while it queues its follow-up, and a key per wait would let every caller that asked for a pass
 * while one was running leave a waiting pass of its own. With two, any number of requests made
 * while the workspace is busy come to one pass waiting for it.
 */
function putOff({ workspaceId, siteId, pass, waits }) {
  const job = libraryJob(LIBRARY_JOBS.mirror, {
    workspaceId,
    siteId,
    pass,
    idempotencyKey: `sources:${workspaceId.toHexString()}:waiting:${waits % 2}`,
  });
  const delay = Math.min(PUT_OFF_CEILING_MS, PUT_OFF_MS * 2 ** Math.min(waits - 1, 4));
  return { ...job, payload: { ...job.payload, waits }, availableAt: new Date(Date.now() + delay) };
}

/**
 * The most pages this workspace's knowledge base is written from.
 *
 * A constant with a per-workspace override, because the right number is a trade between what a
 * write run costs and how much of a site somebody wants read, and it is not the same trade for a
 * brochure and a product with two hundred feature pages. The override lives on the knowledge
 * agent's setup document — the place a person's configuration for that agent already lives — and
 * there is no interface for it yet: this is the value a person can be given when a site needs a
 * different one, not a setting to put in front of everybody.
 */
async function ceilingFor(database, workspaceId) {
  const setup = await database
    .collection(AGENT_COLLECTIONS.agentSetups)
    .findOne({ workspaceId, agentSlug: KNOWLEDGE_AGENT_SLUG }, { projection: { synthesisPages: 1 } });
  const pages = setup?.synthesisPages;
  if (Number.isInteger(pages) && pages >= 1 && pages <= 500) return pages;
  return SYNTHESIS_PAGE_CEILING;
}
