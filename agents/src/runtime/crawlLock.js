import { AGENT_COLLECTIONS } from "@orbik/core";

import { CRAWLER_AGENT } from "../jobs.js";
import { JOB_STATUS } from "./queue.js";

/** The one lock document, which the queue creates and this module only ever borrows. */
const LOCK_ID = "crawler";

/**
 * Lets work that is not a crawl run take the deployment-wide crawl lock for a while.
 *
 * The lock is the queue's (`./queue.js`): a lease in `crawl_queue_locks` that one worker holds
 * for as long as it is running jobs of a crawl run, so that one site is crawled at a time and by
 * one process. Work that also sends paced requests to a website, from a job the queue does not
 * treat as a crawl (a read of another site, say), must never do so beside one. Rather than teach the
 * queue's claim about a second kind of job — the path every crawl of a customer's own site goes
 * through — it borrows the lease, by the rule a worker that does not hold it takes it:
 *
 * - **Taken** when no one owns it or its lease has lapsed, in one `findOneAndUpdate`. A worker
 *   that then tries to claim a crawl job finds the lease held and claims other work instead,
 *   exactly as it does while another worker is crawling.
 * - **Given straight back when a crawl is waiting.** Having the lease, the borrower looks for a
 *   crawl run with a job still pending or running. If there is one it releases at once and
 *   reports that a crawl goes first. So a crawl of a customer's own site is never held up behind
 *   a read of somebody else's. A worker keeps the lease while any crawl job of its own is
 *   running, so a read cannot start in the middle of a crawl either: the lease comes free during
 *   one only when every job left is waiting out a delay, and this look is what covers that.
 * - **Extended** while the borrower works, and **released** when it finishes. A borrower that
 *   dies simply lets the lease lapse, and the next claim takes it, as with any worker.
 *
 * The owner written here is never a bare worker id, so nothing the queue does on a worker's
 * behalf — keeping a lease it already owns, giving it back when its crawl jobs stop, extending
 * it on a heartbeat — can match a lease this module holds.
 *
 * @param {object} options collaborators
 * @param {import("mongodb").Db} options.database connected database
 * @param {() => Date} [options.now] clock; defaults to the system clock
 */
export function createCrawlLock({ database, now = () => new Date() }) {
  const locks = database.collection(AGENT_COLLECTIONS.crawlLocks);
  const jobs = database.collection(AGENT_COLLECTIONS.jobs);

  /** Gives the lease back, when this owner still holds it. */
  async function release({ owner }) {
    await locks.updateOne({ _id: LOCK_ID, owner }, { $unset: { owner: "", leaseUntil: "" } });
  }

  /**
   * Whether a crawl run has a job still pending or running. A job waiting out a retry delay or a
   * rate-limit hold is pending too: its crawl is under way, and it keeps its place.
   */
  async function crawlWaiting() {
    const waiting = await jobs.findOne(
      { agent: CRAWLER_AGENT, runId: { $ne: null }, status: { $in: [JOB_STATUS.pending, JOB_STATUS.running] } },
      { projection: { _id: 1 } },
    );
    return Boolean(waiting);
  }

  return {
    /**
     * Tries once to take the lease.
     *
     * @param {object} options
     * @param {string} options.owner who is asking; must not be a worker id
     * @param {number} options.leaseMs how long the lease is good for without {@link extend}
     * @returns {Promise<{acquired: boolean, reason: "held"|"crawl-waiting"|null}>} `held` means
     *   somebody has it: a worker running a crawl, for as long as it has a job of it in flight, a
     *   worker in the few milliseconds of a claim, or another borrower. `crawl-waiting` means the
     *   lease was free and a crawl run has work outstanding, which goes first
     */
    async acquire({ owner, leaseMs }) {
      const current = now();
      try {
        await locks.findOneAndUpdate(
          { _id: LOCK_ID, $or: [{ owner: { $exists: false } }, { leaseUntil: { $lte: current } }] },
          { $set: { owner, leaseUntil: new Date(current.getTime() + leaseMs) } },
          { upsert: true, returnDocument: "after" },
        );
      } catch (error) {
        // The lease is held: the filter matched nothing, and the upsert collided with the
        // document that is there. The same outcome the queue's own claim treats as "not now".
        if (error?.code !== 11000) throw error;
        return { acquired: false, reason: "held" };
      }

      // Asked with the lease in hand, so no worker can start a crawl job between this look and
      // the first request.
      if (await crawlWaiting()) {
        await release({ owner });
        return { acquired: false, reason: "crawl-waiting" };
      }
      return { acquired: true, reason: null };
    },

    /**
     * Pushes the lease's deadline out while the borrower is still working.
     *
     * @returns {Promise<boolean>} false when the lease was lost, which a borrower must treat as
     *   an order to stop sending requests
     */
    async extend({ owner, leaseMs }) {
      const result = await locks.updateOne(
        { _id: LOCK_ID, owner },
        { $set: { leaseUntil: new Date(now().getTime() + leaseMs) } },
      );
      return result.matchedCount === 1;
    },

    /**
     * Whether a crawl is waiting for the lease a borrower holds. A crawl run the scheduler starts
     * while a borrower has the lease queues its jobs all the same, and no worker can claim them;
     * a borrower that works for long asks this now and then, and gives the lease back when it is
     * true, so a crawl of a customer's own site waits minutes and not the length of a long read.
     */
    crawlWaiting,

    release,
  };
}
