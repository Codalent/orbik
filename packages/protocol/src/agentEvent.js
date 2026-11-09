/**
 * The progress a runtime reports while it works.
 *
 * A page-speed run takes minutes. Without events, the only honest thing an interface can show
 * for those minutes is a spinner, which tells a user nothing about whether the run is progressing,
 * stuck, or about to fail. With them it can show what actually happened:
 *
 *     ✓ Crawled 1,284 pages
 *     ✓ Checked robots.txt
 *     ● Analyzing canonical issues...
 *
 * Every runtime emits the same events, which is what lets the interface be written once.
 */
import {
  TOOL_NAME_PATTERN,
  assertValid,
  defaulted,
  rejectUnknownKeys,
  requireEnum,
  requirePlainObject,
  requireString,
} from "./validate.js";

/** Event types a runtime may emit. */
export const AGENT_EVENT_TYPES = Object.freeze({
  started: "started",
  progress: "progress",
  toolStarted: "tool-started",
  toolCompleted: "tool-completed",
  completed: "completed",
  failed: "failed",
  /** Emitted once, in place of the event that exceeded {@link MAX_EVENTS_PER_RUN}. */
  truncated: "truncated",
});

/** Every event type, as an array, for enum validation. */
const AGENT_EVENT_TYPE_VALUES = Object.freeze(Object.values(AGENT_EVENT_TYPES));

/**
 * How many events one run may record.
 *
 * An agent that loops emits events forever, and the collection is shared by every run in the
 * system. The cap turns "one bad agent definition" into a truncated event log rather than a full
 * disk, and the `truncated` event exists so the interface can say the log was cut off instead of
 * implying the run went quiet.
 */
export const MAX_EVENTS_PER_RUN = 2000;

/** Longest progress message accepted. Messages are for a sidebar line, not a transcript. */
const MAX_EVENT_MESSAGE_LENGTH = 300;

/** Longest error message carried on a `failed` event. */
const MAX_EVENT_ERROR_LENGTH = 1000;

/**
 * Matches a pipeline step name, as in `baseline-audit`.
 *
 * A step is what lets an interface draw a run as a diagram rather than a list: the runtime names
 * which stage a progress line belongs to, and the diagram lights that stage up. It is optional
 * because most agents have no stages worth drawing.
 */
const STEP_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Fields each event type declares, beyond `type`. */
const EVENT_FIELDS = Object.freeze({
  [AGENT_EVENT_TYPES.started]: Object.freeze([]),
  [AGENT_EVENT_TYPES.progress]: Object.freeze(["message", "step"]),
  [AGENT_EVENT_TYPES.toolStarted]: Object.freeze(["tool"]),
  [AGENT_EVENT_TYPES.toolCompleted]: Object.freeze(["tool", "summary"]),
  [AGENT_EVENT_TYPES.completed]: Object.freeze(["result"]),
  [AGENT_EVENT_TYPES.failed]: Object.freeze(["code", "message"]),
  [AGENT_EVENT_TYPES.truncated]: Object.freeze([]),
});

/**
 * Validates one agent event and returns it canonicalized.
 *
 * Events are rendered in a browser, so they are validated before they are stored like any other
 * input.
 *
 * @param {unknown} input an event object with a `type` from {@link AGENT_EVENT_TYPES}
 * @returns {Readonly<object>} the canonical event
 * @throws {import("./validate.js").ProtocolError} `INVALID_AGENT_EVENT` listing every rejected
 *   field
 */
export function parseAgentEvent(input) {
  const errors = [];
  const source = requirePlainObject(input, "event", errors);
  assertValid("INVALID_AGENT_EVENT", errors);

  const type = requireEnum(source.type, "event.type", AGENT_EVENT_TYPE_VALUES, errors);
  assertValid("INVALID_AGENT_EVENT", errors);

  rejectUnknownKeys(source, ["type", ...EVENT_FIELDS[type]], `event ${type}`, errors);

  const event = { type };
  switch (type) {
    case AGENT_EVENT_TYPES.progress:
      event.message = requireString(
        source.message,
        "event.message",
        { max: MAX_EVENT_MESSAGE_LENGTH },
        errors,
      );
      // Present only when the runtime named one, so an agent without stages emits the same
      // two-field event it always did.
      if (defaulted(source.step, null) !== null) {
        event.step = requireString(
          source.step,
          "event.step",
          { max: 40, pattern: STEP_PATTERN, patternDescription: "a step name such as baseline-audit" },
          errors,
        );
      }
      break;

    case AGENT_EVENT_TYPES.toolStarted:
      event.tool = requireToolName(source.tool, errors);
      break;

    case AGENT_EVENT_TYPES.toolCompleted:
      event.tool = requireToolName(source.tool, errors);
      // A tool summary is optional: "read robots.txt" needs no number, "crawled 1,284 pages" does.
      event.summary = defaulted(source.summary, null);
      if (event.summary !== null) {
        event.summary = requireString(
          event.summary,
          "event.summary",
          { max: MAX_EVENT_MESSAGE_LENGTH },
          errors,
        );
      }
      break;

    case AGENT_EVENT_TYPES.completed:
      // The result is shaped by the agent definition's own outputSchema, which only the caller
      // holding that definition can check. Here it is required to be an object and nothing more.
      event.result = requirePlainObject(source.result, "event.result", errors);
      break;

    case AGENT_EVENT_TYPES.failed:
      event.code = requireString(
        source.code,
        "event.code",
        { max: 64, pattern: /^[A-Z][A-Z0-9_]*$/, patternDescription: "an upper-case underscore code" },
        errors,
      );
      event.message = requireString(
        source.message,
        "event.message",
        { max: MAX_EVENT_ERROR_LENGTH },
        errors,
      );
      break;

    default:
      // `started` and `truncated` carry nothing; their meaning is entirely in their type.
      break;
  }

  assertValid("INVALID_AGENT_EVENT", errors);
  return Object.freeze(event);
}

/** Validates a tool name, which is a namespaced identifier such as `crawl.listPages`. */
function requireToolName(value, errors) {
  return requireString(
    value,
    "event.tool",
    { max: 64, pattern: TOOL_NAME_PATTERN, patternDescription: "a namespaced tool name such as crawl.listPages" },
    errors,
  );
}
