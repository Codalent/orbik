import { canonicalizeEmail } from "../repositories/userRepository.js";
import { MEMBER_ROLES } from "../services/workspaceAccess.js";
import { isCanonicalObjectId, plainObject, validationError } from "./shared.js";

/** The address format `seed:user` accepts, so an invite can name only an address an account can have. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** Collects an `UNKNOWN_FIELD` for every key of a body outside `allowed`. */
function refuseUnknown(body, allowed, fields) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
  }
}

/** Reads a role a member row or an invite may hold: never `owner`. */
function readRole(value, fields) {
  if (!MEMBER_ROLES.includes(value)) {
    fields.push({ field: "role", code: "INVALID", message: `Choose one of ${MEMBER_ROLES.join(", ")}.` });
    return null;
  }
  return value;
}

/** Validates a new invite: the address it is for, canonicalised, and the role it gives. */
export function validateInviteCreation(req, _res, next) {
  const fields = [];
  const body = plainObject(req.body);
  refuseUnknown(body, ["email", "role"], fields);
  const email = typeof body.email === "string" ? canonicalizeEmail(body.email) : "";
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    fields.push({ field: "email", code: "FORMAT", message: "Enter a valid email address." });
  }
  const role = readRole(body.role, fields);
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, email, role };
  next();
}

/** Validates a role change. */
export function validateRoleChange(req, _res, next) {
  const fields = [];
  const body = plainObject(req.body);
  refuseUnknown(body, ["role"], fields);
  const role = readRole(body.role, fields);
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, role };
  next();
}

/** Refuses a member identifier that is not a canonical Mongo identifier before it reaches a query. */
export function validateMemberId(req, _res, next) {
  const { userId } = req.params;
  if (!isCanonicalObjectId(userId)) {
    return next(validationError([{ field: "userId", code: "FORMAT", message: "Member identifier is invalid." }]));
  }
  req.validated = { ...req.validated, targetUserId: userId.toLowerCase() };
  next();
}

/** The same guard for an invite identifier. */
export function validateInviteId(req, _res, next) {
  const { inviteId } = req.params;
  if (!isCanonicalObjectId(inviteId)) {
    return next(validationError([{ field: "inviteId", code: "FORMAT", message: "Invite identifier is invalid." }]));
  }
  req.validated = { ...req.validated, inviteId: inviteId.toLowerCase() };
  next();
}

/**
 * Validates what accepting an invite carries: nothing when signed in, or a password for the
 * account it creates — `seed:user`'s rule, 8 to 1024 characters, the bytes kept as sent. Whether
 * a password is *needed* depends on whether the address has an account, which the service knows.
 */
export function validateInviteAcceptance(req, _res, next) {
  const fields = [];
  const body = plainObject(req.body);
  refuseUnknown(body, ["password"], fields);
  const { password } = body;
  if (password !== undefined && (typeof password !== "string" || password.length < 8 || password.length > 1024)) {
    fields.push({ field: "password", code: "LENGTH", message: "Choose a password of 8 to 1024 characters." });
  }
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, password };
  next();
}
