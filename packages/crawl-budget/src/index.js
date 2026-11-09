import { COLLECTIONS, toObjectId } from "@orbik/core";
import { activeExtensions } from "@orbik/extensions";

/**
 * The plan limits this process loaded, which is where a month's allowance comes from: the
 * `monthlyCrawlPages` of the account's limits, or none at all. The open-source edition sets none,
 * so every account is unlimited there; an extension that implements plans answers per account.
 */
const processLimits = (ownerId) => activeExtensions().limitsFor(ownerId);

/**
 * Crawl budget: the monthly page-fetch allowance, and every operation that moves it.
 *
 * Crawl budget buys page fetches, and a page fetch costs exactly one, known before it happens.
 *
 * A month is either **limited** — `allowance` and `remaining` are numbers, and a charge that would
 * take `remaining` below zero is refused — or **unlimited**: `allowance` and `remaining` are null,
 * `unlimited` is true, and every charge succeeds and is still counted in `consumed`, so what a
 * month cost is known either way. Which one a month is follows the account's plan limits when the
 * month is first touched.
 *
 * Only fetches are charged. Discovery — reading sitemaps, following links, registering URLs — is
 * free, because it is what tells a user how big their site is, and charging for it would make the
 * answer to "how much of my site can you see" depend on how much of it they had already paid to
 * look at.
 *
 * Two rules hold everywhere:
 *
 * 1. **An allowance can never be overspent.** Every charge is a single conditional update, so
 *    concurrent workers racing on the last page of a budget see exactly one succeed.
 * 2. **A month resets itself.** The period is part of the document key rather than a field some
 *    job rewrites on the first of the month, so there is no scheduled reset to miss, no window in
 *    which a balance is stale, and last month's document survives as the record of what was spent.
 *
 * @param {object} options collaborators
 * @param {import("mongodb").Db} options.database connected MongoDB database
 * @param {(ownerId: import("mongodb").ObjectId) => Promise<{monthlyCrawlPages: number|null}>} [options.limitsFor]
 *   an account's plan limits; defaults to the ones this process's extensions answer
 * @param {() => Date} [options.now] clock; defaults to the system clock
 */
export function createCrawlBudget({ database, limitsFor = processLimits, now = () => new Date() }) {
  const periods = database.collection(COLLECTIONS.crawlBudgetPeriods);
  const workspaces = database.collection(COLLECTIONS.workspaces);

  /**
   * Resolves the account a charge lands on, from either a user or the workspace being crawled.
   *
   * The crawler knows a site and a workspace; the API knows a signed-in user. Accepting both here
   * keeps the caller from having to resolve an owner itself and getting the rule subtly different.
   */
  async function ownerFor({ userId, workspaceId }) {
    if (userId) return toObjectId(userId);
    if (!workspaceId) return null;
    const workspace = await workspaces.findOne({ _id: toObjectId(workspaceId) }, { projection: { ownerId: 1 } });
    return workspace?.ownerId ?? null;
  }

  /**
   * Returns the current period's document, creating it on first use.
   *
   * The allowance is written with `$setOnInsert`, so a month's ceiling is fixed the first time it
   * is touched. A plan that changes later therefore affects new months rather than silently
   * re-opening a month a user has already been told they exhausted; an extension that wants a
   * change to apply at once rewrites the current month's document itself.
   */
  async function ensurePeriod(owner, period, current) {
    const existing = await periods.findOne({ userId: owner, period });
    if (existing) return existing;
    const { monthlyCrawlPages } = await limitsFor(owner);
    const allowance = Number.isSafeInteger(monthlyCrawlPages) && monthlyCrawlPages >= 0 ? monthlyCrawlPages : null;
    try {
      return await periods.findOneAndUpdate(
        { userId: owner, period },
        {
          $setOnInsert: {
            userId: owner,
            period,
            allowance,
            consumed: 0,
            remaining: allowance,
            unlimited: allowance === null,
            createdAt: current,
          },
          $set: { updatedAt: current },
        },
        { upsert: true, returnDocument: "after" },
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
      return periods.findOne({ userId: owner, period });
    }
  }

  return {
    /**
     * Reports what an account has left this month.
     *
     * @param {object} options account to read, by user or by workspace
     * @returns {Promise<{period: string, unlimited: boolean, allowance: number|null, consumed: number,
     *   remaining: number|null, resetsAt: string}>} `allowance` and `remaining` are null when unlimited
     */
    async statusFor({ userId, workspaceId }) {
      const current = now();
      const period = periodKeyFor(current);
      const owner = await ownerFor({ userId, workspaceId });
      if (!owner) {
        return { period, unlimited: false, allowance: 0, consumed: 0, remaining: 0, resetsAt: periodResetAt(current).toISOString() };
      }

      const document = await ensurePeriod(owner, period, current);
      const unlimited = isUnlimited(document);
      return {
        period,
        unlimited,
        allowance: unlimited ? null : document?.allowance ?? 0,
        consumed: document?.consumed ?? 0,
        remaining: unlimited ? null : document?.remaining ?? 0,
        resetsAt: periodResetAt(current).toISOString(),
      };
    },

    /**
     * Charges an account for pages about to be fetched, refusing rather than overspending.
     *
     * `remaining: { $gte: pages }` in the filter is what makes this safe: two workers charging the
     * last page of a month against the same account see exactly one match, because the loser's
     * filter no longer holds by the time it runs. Reading the balance and then decrementing it
     * would let both through.
     *
     * `remaining` is stored rather than derived from `allowance - consumed` for exactly that
     * reason — the guarantee is a plain conditional on an indexed document, not an expression the
     * caller has to trust itself to have written correctly.
     *
     * The period is recomputed on every call, so a crawl still running when the month turns over
     * simply begins spending the new month's allowance. That is the behaviour a user expects from
     * "you get so many pages a month", and it needs no handling at the call site.
     *
     * @param {object} options charge inputs
     * @param {string|ObjectId} [options.userId] account owner
     * @param {string|ObjectId} [options.workspaceId] workspace whose owner pays
     * @param {number} [options.pages=1] pages to charge for
     * @param {number} [options.reserveShare=0] the share of the month's allowance the charge must
     *   leave untouched, from 0 to 1. A crawl of anything but the workspace's own site may pass one
     *   so that the own site always has room; it is part of the same conditional update, so two
     *   charges at once cannot both slip under it
     * @returns {Promise<{ok: boolean, charged: number, remaining: number|null, allowance: number|null, period: string,
     *   unlimited?: boolean, reserved?: boolean}>} `reserved` is true when the charge was refused only
     *   because of the reserve; an unlimited month always charges, and has no reserve to keep
     */
    async consume({ userId, workspaceId, pages = 1, reserveShare = 0 }) {
      const current = now();
      const period = periodKeyFor(current);
      const wanted = Math.max(0, Math.ceil(pages ?? 0));
      const share = Math.min(1, Math.max(0, Number(reserveShare) || 0));

      const owner = await ownerFor({ userId, workspaceId });
      if (!owner) return { ok: false, charged: 0, remaining: 0, allowance: 0, period };
      const month = await ensurePeriod(owner, period, current);
      if (isUnlimited(month)) {
        if (wanted === 0) return { ok: true, charged: 0, remaining: null, allowance: null, unlimited: true, period };
        await periods.updateOne(
          { userId: owner, period },
          { $inc: { consumed: wanted }, $set: { updatedAt: current } },
        );
        return { ok: true, charged: wanted, remaining: null, allowance: null, unlimited: true, period };
      }
      if (wanted === 0) {
        return { ok: true, charged: 0, remaining: month?.remaining ?? 0, allowance: month?.allowance ?? 0, period };
      }

      const charged = await periods.findOneAndUpdate(
        {
          userId: owner,
          period,
          remaining: { $gte: wanted },
          ...(share > 0
            ? { $expr: { $gte: ["$remaining", { $add: [wanted, { $ceil: { $multiply: ["$allowance", share] } }] }] } }
            : {}),
        },
        { $inc: { remaining: -wanted, consumed: wanted }, $set: { updatedAt: current } },
        { returnDocument: "after" },
      );

      if (!charged) {
        const exhausted = await periods.findOne({ userId: owner, period });
        return {
          ok: false,
          charged: 0,
          remaining: exhausted?.remaining ?? 0,
          allowance: exhausted?.allowance ?? 0,
          period,
          reserved: share > 0 && (exhausted?.remaining ?? 0) >= wanted,
        };
      }

      return { ok: true, charged: wanted, remaining: charged.remaining, allowance: charged.allowance, period };
    },

    /**
     * Returns pages to an account that were charged but not spent.
     *
     * A fetch is charged before the request goes out, because refusing after the bytes have been
     * transferred would mean charging nothing for work already done to somebody's server. When
     * that request then fails in a way that fetched no page at all, the charge is given back here
     * rather than quietly kept.
     *
     * @param {object} options refund inputs
     * @param {number} [options.pages=1] pages to return
     * @returns {Promise<number>} pages returned
     */
    async refund({ userId, workspaceId, pages = 1, period }) {
      const current = now();
      const key = period ?? periodKeyFor(current);
      const back = Math.max(0, Math.ceil(pages ?? 0));
      if (back === 0) return 0;

      const owner = await ownerFor({ userId, workspaceId });
      if (!owner) return 0;

      // Capped at what the period has actually consumed, so a duplicated refund cannot invent
      // allowance that was never charged. An unlimited month has no balance to give back to, only
      // the count of what it spent.
      const month = await periods.findOne({ userId: owner, period: key }, { projection: { allowance: 1, unlimited: 1 } });
      if (!month) return 0;
      const result = await periods.findOneAndUpdate(
        { userId: owner, period: key, consumed: { $gte: back } },
        isUnlimited(month)
          ? { $inc: { consumed: -back }, $set: { updatedAt: current } }
          : { $inc: { remaining: back, consumed: -back }, $set: { updatedAt: current } },
        { returnDocument: "after" },
      );
      return result ? back : 0;
    },

    /**
     * Adds pages to the current month's allowance.
     *
     * There is no purchase flow yet, so this is how an account gets more than the default: an
     * operator runs the grant CLI. A grant tops up **this month only** — next month starts from
     * the standard allowance again, which is what makes "wait for next month, or buy more now" two
     * genuinely different offers rather than one that quietly becomes permanent.
     *
     * @param {object} options grant inputs
     * @param {string|ObjectId} options.userId account owner
     * @param {number} options.pages pages to add
     * @param {string} [options.reason] why, recorded on the period
     * @returns {Promise<{allowance: number|null, remaining: number|null, period: string, unlimited: boolean}>}
     *   an unlimited month is left as it is: there is nothing to add to
     */
    async grant({ userId, pages, reason = "Granted by an operator." }) {
      const current = now();
      const period = periodKeyFor(current);
      const owner = toObjectId(userId);
      const added = Math.max(0, Math.ceil(pages ?? 0));

      const month = await ensurePeriod(owner, period, current);
      if (isUnlimited(month)) return { allowance: null, remaining: null, period, unlimited: true };
      const document = await periods.findOneAndUpdate(
        { userId: owner, period },
        {
          $inc: { allowance: added, remaining: added },
          $set: { updatedAt: current },
          $push: { grants: { $each: [{ pages: added, reason, at: current }], $slice: -50 } },
        },
        { returnDocument: "after" },
      );
      return { allowance: document?.allowance ?? added, remaining: document?.remaining ?? added, period, unlimited: false };
    },

    /**
     * Lists an account's recent months, newest first, so spend over time is readable.
     *
     * @param {string|ObjectId} userId account owner
     * @param {number} [limit=12] how many periods to return
     */
    history(userId, limit = 12) {
      return periods
        .find({ userId: toObjectId(userId) })
        .sort({ period: -1 })
        .limit(Math.min(Math.max(1, limit), 60))
        .toArray();
    },
  };
}

/**
 * Whether a month's document has no ceiling. A document written before months could be unlimited
 * always carries a numeric allowance, so it reads as limited, which is what it was.
 */
function isUnlimited(document) {
  return Boolean(document) && (document.unlimited === true || document.allowance === null);
}

/**
 * Builds the key identifying one account-month, in UTC.
 *
 * UTC rather than the account's local time because the key is compared and sorted as a string by
 * two processes on machines whose timezones are not guaranteed to agree. A user near a date line
 * sees their month turn over a few hours from local midnight, which is a far smaller surprise than
 * a worker and the API disagreeing about which month a page was charged to.
 *
 * @param {Date} date instant to classify
 * @returns {string} `YYYY-MM`
 */
function periodKeyFor(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Returns the instant the given month's allowance is replaced by the next one.
 *
 * @param {Date} date instant inside the period
 * @returns {Date} first millisecond of the following UTC month
 */
function periodResetAt(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}
