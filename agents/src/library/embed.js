import { log } from "@orbik/core";
import { MAX_SOURCES_PER_PASS } from "@orbik/retrieval";

import { LIBRARY_JOBS, libraryJob } from "../jobs.js";
import { requireObjectId } from "../runtime/errors.js";
import { findSite } from "./scope.js";

/**
 * The Library agent's second stage: keeps a workspace's retrieval index in step with its documents.
 *
 * It is a handler of a registered agent, which means it gets leases, retries, backoff, heartbeats
 * and crash recovery from the queue rather than from anything written here. What it is not is an
 * agent *definition*: there are no instructions and no model, because deciding which pages changed
 * is a hash comparison and asking a model to do it would be slower, dearer and worse at it.
 *
 * It is a stage beside mirroring rather than after it. The index covers the crawled pages as well
 * as the Library's files, so a pass has work to do the moment a crawl finishes and more when the
 * subject files are written — each of those queues its own pass, and none waits on another. The
 * source layer's copy of a page adds nothing to it: a page is indexed once, as the page.
 *
 * **It is never enqueued by the API.** Like every other piece of work in this system, an index
 * pass is created by a scheduler or by the crawler that just finished writing pages — see
 * `libraryScheduler.js`. An HTTP handler that enqueued would race the worker and would
 * make accepting a request depend on the queue being reachable.
 *
 * **A pass is bounded and resumes itself.** A first index of a large site is thousands of
 * embedding calls; one job that tried to do all of it would hold a lease for an hour and lose it.
 * So a pass covers a bounded number of sources and re-queues itself while any remain, exactly as
 * the crawler's finalize step re-queues itself while fetches are outstanding.
 *
 * @param {object} options collaborators
 * @param {object|null} options.retrieval the retrieval index, or null when none is configured
 * @param {{code: string, message: string}|null} [options.reason] why there is none, for the log
 * @param {(level: string, message: string, context?: object) => void} [options.logger]
 * @returns {(job: object, context: object) => Promise<object>} the `index.embed` handler
 */
export function createEmbedHandler({ retrieval, reason = null, logger = log }) {
  return async function embed(job, { database, signal, heartbeat }) {
    const workspaceId = requireObjectId(job.payload?.workspaceId ?? job.workspaceId, "workspaceId", "An index job");
    // Which continuation of one workspace's indexing this is, so the follow-up below has a key
    // that is stable for a given pass rather than a new one every time it is computed.
    const pass = Number.isInteger(job.payload?.pass) ? job.payload.pass : 0;

    // A worker with no embedding key is a normal deployment. The job is completed rather than
    // failed and retried: nothing about it will be different in thirty seconds, and a queue
    // full of jobs dead-lettering every minute would bury the ones that matter.
    if (!retrieval) {
      logger("info", "index.skipped", { workspaceId: workspaceId.toHexString(), code: reason?.code ?? "EMBEDDING_NOT_CONFIGURED" });
      return { counters: { indexSkipped: 1 } };
    }

    const siteId = job.payload?.siteId
      ? requireObjectId(job.payload.siteId, "siteId", "An index job")
      : await findSite(database, workspaceId);

    const counters = await retrieval.indexWorkspace({
      workspaceId,
      siteId,
      limit: MAX_SOURCES_PER_PASS,
      heartbeat,
      signal,
    });

    logger(counters.error ? "warn" : "info", "index.pass_finished", {
      workspaceId: workspaceId.toHexString(),
      ...counters,
    });

    return {
      counters: {
        sourcesIndexed: counters.indexed,
        chunksEmbedded: counters.chunks,
        sourcesUnchanged: counters.unchanged,
        sourcesRemoved: counters.removed,
        sourcesFailed: counters.failed,
      },
      // More to do than one pass may carry. Re-queued rather than looped, so the lease, the
      // retry count and the shutdown grace all keep applying to each piece of it.
      enqueue: counters.remaining > 0 && !counters.error
        ? [libraryJob(LIBRARY_JOBS.embed, { workspaceId, siteId, pass: pass + 1 })]
        : [],
    };
  };
}
