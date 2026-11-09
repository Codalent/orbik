/**
 * The run lifecycle, and the only transitions through it that are legal.
 *
 * A run is what a person reasons about: "last night's page-speed run on example.com". The
 * states exist to answer one question each, and states that would answer no question are left out
 * on purpose.
 */
import { ProtocolError } from "./validate.js";

/** Run lifecycle states. */
export const RUN_STATUS = Object.freeze({
  /** Accepted and recorded, not yet handed to anything that can execute it. */
  queued: "queued",
  /** Handed to a worker, which is executing it and reporting progress. */
  running: "running",
  /** Finished and produced a result. */
  succeeded: "succeeded",
  /** Finished without a result. `error.code` says why. */
  failed: "failed",
  /** Stopped because someone asked it to stop. */
  cancelled: "cancelled",
});

/** Every run status, as an array, for enum validation. */
export const RUN_STATUS_VALUES = Object.freeze(Object.values(RUN_STATUS));

/** States a run never leaves. */
const TERMINAL_RUN_STATUSES = Object.freeze([
  RUN_STATUS.succeeded,
  RUN_STATUS.failed,
  RUN_STATUS.cancelled,
]);

/**
 * The complete allow-list of legal transitions.
 *
 * Note that `queued` may go straight to `failed`: a run that cannot be started is recorded as a
 * failure with a reason, rather than disappearing.
 */
const RUN_TRANSITIONS = Object.freeze({
  [RUN_STATUS.queued]: Object.freeze([
    RUN_STATUS.running,
    RUN_STATUS.failed,
    RUN_STATUS.cancelled,
  ]),
  [RUN_STATUS.running]: Object.freeze([
    RUN_STATUS.succeeded,
    RUN_STATUS.failed,
    RUN_STATUS.cancelled,
  ]),
  [RUN_STATUS.succeeded]: Object.freeze([]),
  [RUN_STATUS.failed]: Object.freeze([]),
  [RUN_STATUS.cancelled]: Object.freeze([]),
});

/**
 * Reports whether a run in this status will ever change again.
 *
 * @param {string} status a value from {@link RUN_STATUS}
 */
export function isTerminalRunStatus(status) {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/**
 * Reports whether one status may follow another.
 *
 * @param {string} from current status
 * @param {string} to proposed status
 */
function canTransition(from, to) {
  return RUN_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Enforces a transition, throwing when it is not one the lifecycle allows.
 *
 * Every path that moves a run — the API, the dispatcher, the worker — goes
 * through here. A run reaching a terminal state is the point at which a result becomes visible,
 * so a late or duplicated write that reopened or rewrote one would corrupt it. Refusing the transition is how a stale writer is turned into a caught error rather than a
 * silent overwrite.
 *
 * @param {string} from current status
 * @param {string} to proposed status
 * @throws {ProtocolError} `INVALID_RUN_TRANSITION` when the move is not allowed
 */
export function assertTransition(from, to) {
  if (canTransition(from, to)) return;

  const known = RUN_STATUS_VALUES.includes(from) && RUN_STATUS_VALUES.includes(to);
  throw new ProtocolError({
    code: "INVALID_RUN_TRANSITION",
    errors: [
      known
        ? `A run cannot move from ${from} to ${to}.`
        : "A run transition must name two known run statuses.",
    ],
  });
}
