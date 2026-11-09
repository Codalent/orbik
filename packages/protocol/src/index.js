/**
 * Public surface of `@orbik/protocol`.
 *
 * Everything exported here is a contract the API and the agent workers have to agree on.
 * Anything that belongs to only one of them — a database handle, an HTTP error shape, a provider
 * adapter — stays in that process's own package.
 *
 * This package has no dependencies.
 */
export { ProtocolError } from "./validate.js";

export {
  RUN_STATUS,
  RUN_STATUS_VALUES,
  assertTransition,
  isTerminalRunStatus,
} from "./runStatus.js";

export {
  AGENT_CAPABILITIES,
  AGENT_WRITERS,
  RUNTIME_REQUIREMENTS,
  parseAgentDefinition,
  toDispatchPayload,
} from "./agentDefinition.js";

export { AGENT_EVENT_TYPES, MAX_EVENTS_PER_RUN, parseAgentEvent } from "./agentEvent.js";

export {
  BUTTON_VARIANTS,
  COLOR_ROLES,
  FONT_ROLES,
  GRAPHICS_LANGUAGE_FORMAT,
  PINNED_SOURCE,
  RADIUS_TOKENS,
  REQUIRED_COLOR_ROLES,
  REQUIRED_TYPE_TOKENS,
  SHADOW_TOKENS,
  TYPE_TOKENS,
  VALUE_SOURCES,
  VALUE_SOURCE_VALUES,
  VISUAL_SYSTEM_FORMAT,
  parseGraphicsLanguage,
  parseVisualSystem,
  safeShadow,
} from "./designSystem.js";
