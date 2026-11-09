import { toObjectId } from "@orbik/core";
import { ObjectId } from "mongodb";

import { AgentError } from "./errors.js";

/**
 * Events one agent publishes for others to act on.
 *
 * The vocabulary is deliberately about **observed change**, not about what any consumer should do
 * with it. "The canonical tag on this page changed" is a fact the crawler can state; "re-run the
 * canonicalization audit" is a decision belonging to whichever agent cares. Encoding the second
 * into the event would make the crawler depend on agents it has never heard of.
 */
export const EVENT_TYPES = Object.freeze({
  /** A URL entered the registry for the first time. */
  pageDiscovered: "page.discovered",
  /** The HTTP status of a URL differs from its previous crawl. */
  pageStatusChanged: "page.status_changed",
  /** The readable text of a page changed. */
  pageContentChanged: "page.content_changed",
  /** The canonical target of a page changed. */
  pageCanonicalChanged: "page.canonical_changed",
  /** A page became indexable, or stopped being indexable. */
  pageIndexabilityChanged: "page.indexability_changed",
  /** A crawl run finished, with its counters. */
  crawlCompleted: "crawl.completed",
});

const TYPE_VALUES = new Set(Object.values(EVENT_TYPES));

/** Documents written per bulk insert. */
const BATCH_SIZE = 500;

/**
 * Creates the append-only outbox agents publish change events to.
 *
 * An outbox table rather than direct calls between agents, for the same reason the queue exists:
 * a consumer that is down, slow, or not yet written must not be able to fail the producer. The
 * crawler's job is finished when the event is durably recorded; who reads it, and when, is not
 * its concern.
 *
 * Events are never updated or deleted here. A consumer tracks its own position, so several agents
 * can read the same stream at different speeds without coordinating.
 *
 * @param {object} options collaborators
 * @param {import("mongodb").Collection} options.events the `agent_events` collection
 * @param {() => Date} [options.now] clock; defaults to the system clock
 */
export function createEventOutbox({ events, now = () => new Date() }) {
  return {
    /**
     * Publishes a batch of events.
     *
     * Batched because a single page fetch can legitimately produce several — a page that came
     * back 500 after being 200 has both changed status and stopped being indexable — and one
     * round trip per event would make change detection cost more than the fetch it describes.
     *
     * @param {Array<object>} records events to publish
     * @returns {Promise<number>} how many were written
     * @throws {AgentError} `INVALID_EVENT` when any record is malformed
     */
    async publish(records) {
      if (!Array.isArray(records) || !records.length) return 0;
      const documents = records.map((record) => buildEvent(record, now()));
      let written = 0;
      for (let offset = 0; offset < documents.length; offset += BATCH_SIZE) {
        const batch = documents.slice(offset, offset + BATCH_SIZE);
        await events.insertMany(batch, { ordered: false });
        written += batch.length;
      }
      return written;
    },

    /**
     * Reads events a consumer has not seen yet.
     *
     * Position is expressed as the last `_id` a consumer processed rather than a timestamp:
     * ObjectIds increase monotonically per process and are unique, so resuming from one cannot
     * skip an event that shares a timestamp with the last one read, nor deliver it twice.
     *
     * A consumer that works one stretch of the stream at a time — everything up to the event that
     * closes a crawl, say — names where the stretch ends with `until`, and pages through it with
     * `after` exactly as it would through the whole stream.
     *
     * @param {object} query what to read
     * @param {string[]} [query.types] event types to include; all types when omitted
     * @param {string|ObjectId} [query.after] last event identifier already processed
     * @param {string|ObjectId} [query.until] last event identifier to include
     * @param {string|ObjectId} [query.siteId] restrict to one site
     * @param {number} [query.limit=100] maximum events returned
     */
    read({ types, after, until, siteId, limit = 100 } = {}) {
      const filter = {};
      if (types?.length) filter.type = { $in: types };
      if (after) filter._id = { $gt: toObjectId(after) };
      if (until) filter._id = { ...filter._id, $lte: toObjectId(until) };
      if (siteId) filter.siteId = toObjectId(siteId);
      return events.find(filter).sort({ _id: 1 }).limit(limit).toArray();
    },
  };
}

/**
 * Validates and canonicalizes one event.
 *
 * Events are the contract between agents that do not import each other, so a malformed one is
 * rejected at publication rather than discovered by a consumer that cannot make sense of it.
 */
function buildEvent(record, current) {
  const errors = [];
  if (!TYPE_VALUES.has(record?.type)) {
    errors.push(`type must be one of ${[...TYPE_VALUES].join(", ")}.`);
  }

  const references = {};
  for (const field of ["siteId", "workspaceId", "runId"]) {
    if (record?.[field] === undefined || record?.[field] === null) continue;
    if (!isObjectIdLike(record[field])) {
      errors.push(`${field} must be a MongoDB ObjectId.`);
      continue;
    }
    references[field] = toObjectId(record[field]);
  }

  if (record?.urlHash !== undefined && !/^[0-9a-f]{64}$/.test(String(record.urlHash))) {
    errors.push("urlHash must be a 64-character hex digest.");
  }

  // `??` would also swallow an explicit null, turning a caller's mistake into a silently valid
  // event that a consumer then has to make sense of.
  const data = record?.data === undefined ? {} : record.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    errors.push("data must be an object.");
  }

  if (errors.length) {
    throw new AgentError({
      code: "INVALID_EVENT",
      message: `Invalid event: ${errors.join(" ")}`,
      retryable: false,
    });
  }

  return {
    type: record.type,
    ...references,
    ...(record.urlHash ? { urlHash: record.urlHash } : {}),
    ...(record.url ? { url: record.url } : {}),
    data,
    createdAt: current,
  };
}

/** Reports whether a value can be converted to an ObjectId without throwing. */
function isObjectIdLike(value) {
  return value instanceof ObjectId || (typeof value === "string" && ObjectId.isValid(value));
}
