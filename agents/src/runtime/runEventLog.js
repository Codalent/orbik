import { toObjectId } from "@orbik/core";
import { AGENT_EVENT_TYPES, MAX_EVENTS_PER_RUN, parseAgentEvent } from "@orbik/protocol";

/**
 * Creates the append-only progress log one run writes while it works.
 *
 * This is what turns a five-minute audit from a spinner into something a person can watch. It is
 * deliberately separate from the `agent_events` outbox: that one is how agents reach each other
 * ("this page's status changed"), and its consumers track their own cursors. This one is how a run
 * reaches a human, is scoped to a single run, and is read by sequence number so an interface can
 * ask for "everything after event 41" and get exactly that.
 *
 * Ordering comes from a caller-supplied `seq` rather than from insertion order. A runtime
 * numbers its own events, so a retried job that resends events lands on the rows it already wrote
 * instead of duplicating the run's history — the unique `(runId, seq)` index makes the second
 * write a no-op rather than a second row.
 *
 * @param {object} options collaborators
 * @param {import("mongodb").Collection} options.runEvents the `agent_run_events` collection
 * @param {() => Date} [options.now] clock; defaults to the system clock
 */
export function createRunEventLog({ runEvents, now = () => new Date() }) {
  return {
    /**
     * Appends one event, ignoring a sequence number already recorded for this run.
     *
     * The cap is enforced here rather than by the caller because the caller is sometimes a user's
     * machine. An agent definition that loops emits events forever into a collection shared by
     * every run in the system; past the cap the log records one `truncated` event and stops, so a
     * bad definition costs its own run its history rather than costing everyone their database.
     *
     * @param {object} input event to record
     * @param {string|ObjectId} input.runId owning run
     * @param {number} input.seq per-run sequence number, starting at 1
     * @param {object} input.event an event matching `@orbik/protocol`'s `parseAgentEvent`
     * @returns {Promise<{recorded: boolean, truncated: boolean}>} `recorded` is false when this
     *   sequence number was already stored
     * @throws {import("@orbik/protocol").ProtocolError} when the event is malformed
     */
    async append({ runId, seq, event }) {
      const parsed = parseAgentEvent(event);
      const owner = toObjectId(runId);

      if (seq > MAX_EVENTS_PER_RUN) {
        // Recorded at the boundary only, so the marker itself cannot become the runaway.
        const marked = await insert(runEvents, {
          runId: owner,
          seq: MAX_EVENTS_PER_RUN,
          type: AGENT_EVENT_TYPES.truncated,
          data: {},
          at: now(),
        });
        return { recorded: false, truncated: marked };
      }

      const recorded = await insert(runEvents, {
        runId: owner,
        seq,
        type: parsed.type,
        data: toData(parsed),
        at: now(),
      });
      return { recorded, truncated: false };
    },

    /**
     * Reads a run's events in order, optionally continuing after one already seen.
     *
     * `after` is a sequence number rather than a timestamp because two events from the same run
     * can share a millisecond, and resuming from a timestamp would then either skip one or deliver
     * it twice — the exact failure the interface is polling to avoid.
     *
     * @param {object} options read scope
     * @param {string|ObjectId} options.runId run to read
     * @param {number} [options.after=0] highest sequence number the caller already has
     * @param {number} [options.limit=200] maximum events to return
     * @returns {Promise<object[]>} events in ascending sequence order
     */
    async read({ runId, after = 0, limit = 200 }) {
      return runEvents
        .find({ runId: toObjectId(runId), seq: { $gt: after } })
        .sort({ seq: 1 })
        .limit(limit)
        .toArray();
    },

    /**
     * Returns the highest sequence number recorded for a run, or 0 when it has none.
     *
     * A retried job asks for this so it can resume numbering where it left off rather
     * than restarting at 1 and colliding with its own earlier events.
     *
     * @param {string|ObjectId} runId run to inspect
     */
    async lastSeq(runId) {
      const latest = await runEvents
        .find({ runId: toObjectId(runId) })
        .sort({ seq: -1 })
        .limit(1)
        .project({ seq: 1 })
        .toArray();
      return latest[0]?.seq ?? 0;
    },
  };
}

/**
 * Inserts one event, treating a duplicate sequence number as success rather than as an error.
 *
 * A duplicate means the event is already recorded — a retried job resent it — and
 * the caller's intent is satisfied. Raising here would turn a normal retry into a failed run.
 *
 * @returns {Promise<boolean>} whether this call was the one that wrote the row
 */
async function insert(runEvents, document) {
  try {
    await runEvents.insertOne(document);
    return true;
  } catch (error) {
    if (error?.code === 11000) return false;
    throw error;
  }
}

/**
 * Reduces a parsed event to the fields worth storing beyond its type.
 *
 * The type is stored as a column rather than inside `data` so the log can be filtered without
 * reading every document's payload.
 */
function toData(event) {
  return Object.fromEntries(Object.entries(event).filter(([field]) => field !== "type"));
}
