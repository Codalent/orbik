import { MAX_SELECTED_WORKSPACES } from "../mcp/credentialWorkspaces.js";
import { MCP_USAGE_WINDOWS } from "../services/mcpUsageService.js";
import { parseChoice, plainObject, validationError } from "./shared.js";

/** Mongo identifiers as they appear in a path segment. */
const ID_PATTERN = /^[0-9a-f]{24}$/;

/**
 * Validates what a new token carries: the name its owner will recognise it by, optionally the
 * workspaces it reads, and whether it may also write to the Library. Without `workspaces` it reads
 * the workspace whose page minted it; without `write` it only reads.
 */
export function validateTokenCreation(req, _res, next) {
  const fields = [];
  const body = plainObject(req.body);
  for (const key of Object.keys(body)) {
    if (key !== "name" && key !== "workspaces" && key !== "write") {
      fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
    }
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 60 || /\p{Cc}|\p{Cf}/u.test(name)) {
    fields.push({ field: "name", code: "INVALID", message: "Enter a name of 1-60 characters." });
  }

  const workspaces = body.workspaces === undefined ? null : readWorkspaceSelection(body.workspaces, "workspaces", fields);
  const write = readWriteChoice(body.write, "write", fields);

  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, name, workspaces, write };
  next();
}

/**
 * Reads whether a credential may also write to the Library: `true` or `false`, absent meaning
 * `false`. Nothing else is read as yes — writing is only ever what somebody explicitly allowed.
 * Shared by the token routes and the consent screen.
 *
 * @param {unknown} value the body field
 * @param {string} field its name, for the error envelope
 * @param {Array<object>} fields collects failures
 */
export function readWriteChoice(value, field, fields) {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    fields.push({ field, code: "INVALID", message: "Answer true or false." });
    return false;
  }
  return value;
}

/**
 * Reads the set of workspaces a credential is to cover, from a request body.
 *
 * Two shapes and nothing else: `{mode: "all"}`, or `{mode: "selected", ids: [...]}` with at least
 * one canonical identifier and no repeats. Whether the caller can read them is the service's
 * question, not a format one, and is asked there. Shared by the token routes and the consent screen, which
 * accept the same value.
 *
 * @param {unknown} value the body field
 * @param {string} field its name, for the error envelope
 * @param {Array<object>} fields collects failures
 * @returns {{mode: "all"} | {mode: "selected", ids: string[]} | null}
 */
export function readWorkspaceSelection(value, field, fields) {
  const fail = (message, code = "INVALID") => {
    fields.push({ field, code, message });
    return null;
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail('Choose {"mode": "all"} or {"mode": "selected", "ids": [...]}.');
  }
  if (value.mode === "all") {
    if (Object.keys(value).some((key) => key !== "mode")) return fail("An \"all\" choice carries nothing else.", "UNKNOWN_FIELD");
    return { mode: "all" };
  }
  if (value.mode !== "selected") return fail('mode must be "all" or "selected".');
  if (Object.keys(value).some((key) => key !== "mode" && key !== "ids")) {
    return fail("A selection carries mode and ids only.", "UNKNOWN_FIELD");
  }
  const ids = Array.isArray(value.ids) ? value.ids : [];
  if (!ids.length) return fail("Choose at least one workspace.", "REQUIRED");
  if (ids.length > MAX_SELECTED_WORKSPACES) return fail(`Choose at most ${MAX_SELECTED_WORKSPACES} workspaces.`);
  if (!ids.every((id) => typeof id === "string" && ID_PATTERN.test(id))) return fail("Workspace identifier is invalid.", "FORMAT");
  if (new Set(ids).size !== ids.length) return fail("A workspace is named twice.");
  return { mode: "selected", ids: [...ids] };
}

/** Refuses a token identifier that is not a canonical Mongo identifier before it reaches a query. */
export function validateTokenId(req, _res, next) {
  const { tokenId } = req.params;
  if (!ID_PATTERN.test(tokenId ?? "")) {
    return next(validationError([{ field: "tokenId", code: "FORMAT", message: "Token identifier is invalid." }]));
  }
  req.validated = { ...req.validated, tokenId };
  next();
}

/** The same guard for a grant identifier, which addresses an approved connection rather than a token. */
export function validateGrantId(req, _res, next) {
  const { grantId } = req.params;
  if (!ID_PATTERN.test(grantId ?? "")) {
    return next(validationError([{ field: "grantId", code: "FORMAT", message: "Connection identifier is invalid." }]));
  }
  req.validated = { ...req.validated, grantId };
  next();
}

/**
 * Reads the window the "What your AI asked" report covers: `?days=` 7, 30 or 90, 30 when absent.
 */
export function validateUsageQuery(req, _res, next) {
  const fields = [];
  const days = parseChoice(req.query?.days, { allowed: MCP_USAGE_WINDOWS, fallback: "30" }, "days", fields);
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, days: Number(days) };
  next();
}
