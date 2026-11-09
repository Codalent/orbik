import { normalizeTrackedPages, pageLimitsFor } from "@orbik/core";

import { plainObject, validationError } from "./shared.js";

/** Matches an agent slug, the same shape the protocol enforces on a definition. */
const SLUG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Validates the agent slug in a route. */
export function validateAgentScope(req, _res, next) {
  const { agentSlug } = req.params;
  if (typeof agentSlug !== "string" || !SLUG_PATTERN.test(agentSlug) || agentSlug.length > 64) {
    return next(validationError([{ field: "agentSlug", code: "FORMAT", message: "Agent identifier is invalid." }]));
  }
  req.validated = { ...req.validated, agentSlug };
  next();
}

/**
 * Validates the pages a person chose to track.
 *
 * The rule itself lives in `@orbik/core` so the store and this boundary cannot disagree; this
 * function only turns its findings into the field-level failure the interface shows. How many
 * pages is the agent's own bound — eight or none for the Design system agent — so the agent in
 * the route, validated before this runs, chooses it.
 */
export function validateSetupBody(req, _res, next) {
  const fields = [];
  const body = plainObject(req.body);
  for (const key of Object.keys(body)) {
    if (key !== "pages") fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
  }
  const { pages, errors } = normalizeTrackedPages(body.pages, pageLimitsFor(req.validated?.agentSlug));
  for (const problem of errors) fields.push({ field: problem.field, code: "INVALID", message: problem.message });
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, pages };
  next();
}

/** Validates the body that starts or pauses the agent. */
export function validateWorkingBody(req, _res, next) {
  const body = plainObject(req.body);
  const fields = [];
  for (const key of Object.keys(body)) {
    if (key !== "working") fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
  }
  if (typeof body.working !== "boolean") {
    fields.push({ field: "working", code: "INVALID", message: "Say whether the agent should be working." });
  }
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, working: body.working };
  next();
}

