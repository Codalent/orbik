import { readWorkspaceSelection, readWriteChoice } from "./mcpTokenValidators.js";
import { plainObject, validationError } from "./shared.js";

/** Pending authorization requests are addressed by their Mongo identifier. */
const ID_PATTERN = /^[0-9a-f]{24}$/;

/** Refuses a request identifier that is not a canonical Mongo identifier before it reaches a query. */
export function validateRequestId(req, _res, next) {
  const { requestId } = req.params;
  if (!ID_PATTERN.test(requestId ?? "")) {
    return next(validationFailure("requestId", "Request identifier is invalid."));
  }
  req.validated = { ...req.validated, requestId };
  next();
}

/**
 * Validates the two decisions an approval carries: which workspaces this client may read —
 * `{"workspaces": {"mode": "all"}}` or `{"workspaces": {"mode": "selected", "ids": [...]}}` — and
 * whether it may also write to their Libraries, `"write": true`, absent meaning no. Nothing else
 * is accepted. An empty selection is refused here; ids the person cannot read are refused by the
 * service, which is where access is known.
 */
export function validateApproval(req, _res, next) {
  const body = plainObject(req.body);
  const unknown = Object.keys(body).find((key) => key !== "workspaces" && key !== "write");
  if (unknown) {
    return next(validationFailure(unknown, "This field is not accepted.", "UNKNOWN_FIELD"));
  }
  const fields = [];
  const workspaces = readWorkspaceSelection(body.workspaces, "workspaces", fields);
  const write = readWriteChoice(body.write, "write", fields);
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, workspaces, write };
  next();
}

/** The API's standard validation envelope, for one bad field. */
function validationFailure(field, message, code = "FORMAT") {
  return validationError([{ field, code, message }]);
}
