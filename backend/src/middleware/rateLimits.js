import { AppError } from "../errors/appError.js";

/**
 * Creates a counter backed by MongoDB atomic counters: so many takes per key per window.
 *
 * The window is fixed and starts at a key's first take; the row carries when it ends, and the next
 * take after that starts a new one. Shared by the HTTP middleware below and by anything that has
 * to count inside a request rather than in front of it — the MCP endpoint's Library writes, which
 * are told apart from its reads only once the request has been read.
 *
 * @param {object} options
 * @param {import("mongodb").Collection} options.collection where the counters live
 * @param {string} options.keyPrefix namespaces the keys, so two counters never share one
 * @param {number} options.points takes allowed per window
 * @param {number} options.durationSeconds the window
 */
export function createRateCounter({ collection, keyPrefix, points, durationSeconds }) {
  return {
    /**
     * Counts one take against a key.
     *
     * @param {unknown} rawKey what is being counted, e.g. a credential's id
     * @returns {Promise<{allowed: boolean, retryAfterSeconds: number}>} whether this take is within
     *   the window's allowance, and how long until the window ends
     */
    async take(rawKey) {
      const key = `${keyPrefix}:${String(rawKey ?? "unknown").slice(0, 254)}`;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + durationSeconds * 1000);
      await collection.deleteOne({ _id: key, expiresAt: { $lte: now } });
      const counted = await collection.findOneAndUpdate(
        { _id: key },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
        { upsert: true, returnDocument: "after" },
      );
      const ends = counted.expiresAt ? new Date(counted.expiresAt).getTime() : expiresAt.getTime();
      return {
        allowed: counted.count <= points,
        retryAfterSeconds: Math.max(1, Math.ceil((ends - now.getTime()) / 1000)),
      };
    },
  };
}

/**
 * Creates a rate-limit middleware backed by MongoDB atomic counters.
 *
 * @param {object} options
 * @param {import("mongodb").Collection} options.collection where the counters live
 */
export function createRateLimit({
  collection,
  keyPrefix,
  points,
  durationSeconds,
  keyFromRequest = (req) => req.ip,
}) {
  const counter = createRateCounter({ collection, keyPrefix, points, durationSeconds });
  return async function rateLimit(req, res, next) {
    try {
      const { allowed } = await counter.take(keyFromRequest(req));
      if (!allowed) {
        const error = new AppError({
          status: 429,
          code: "RATE_LIMITED",
          message: "Too many requests. Try again later.",
        });
        error.retryAfterSeconds = durationSeconds;
        res.set("Retry-After", String(durationSeconds));
        throw error;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
