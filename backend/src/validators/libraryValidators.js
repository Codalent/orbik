import {
  LIBRARY_LIMITS,
  LIBRARY_NODE_KINDS,
  LIBRARY_NODE_KIND_VALUES,
  LIBRARY_ROOT_PATH,
  LIBRARY_SOURCE_KINDS,
  LIBRARY_SOURCE_KIND_VALUES,
  LibraryError,
  normalizeLibraryPath,
} from "@orbik/library";

import { parseBounded, validationError } from "./shared.js";

/**
 * Validating what a person sends to the Library.
 *
 * The bounds and the path rules are not written here: they come from `@orbik/library`, which is the
 * same module the agent tools validate against. That is the whole reason those rules live in a
 * shared package — a person saving `/clients/deeplearning-ai` and an agent writing the same file
 * must agree about what a path is, how deep a tree may go, and how long a file may be, or the
 * Library becomes a place where one writer can create something the other cannot open.
 *
 * What is written here is the HTTP shape: which fields a body may carry, and the field-level
 * messages a form can display beside the input that was wrong.
 */

/**
 * Reads the node path out of the route's wildcard.
 *
 * Express hands `/library/nodes/services/ai-development` back as the segments `["services",
 * "ai-development"]`, which is exactly the Library's own path model — so the path is rebuilt and
 * then canonicalized by the same function the tools use, rather than trusted as typed.
 */
export function validateLibraryNodePath(req, _res, next) {
  const segments = req.params.path;
  const raw = Array.isArray(segments) ? segments.join("/") : String(segments ?? "");
  try {
    req.validated = { ...req.validated, path: normalizeLibraryPath(decodeURIComponent(raw)) };
    next();
  } catch (error) {
    if (error instanceof LibraryError) {
      return next(validationError([{ field: "path", code: "FORMAT", message: error.message }]));
    }
    next(error);
  }
}

/** Validates the optional `path` and `depth` of a tree request. */
export function validateLibraryTreeQuery(req, _res, next) {
  const fields = [];
  const query = req.query ?? {};
  for (const key of Object.keys(query)) {
    if (!["path", "depth"].includes(key)) {
      fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This filter is not accepted." });
    }
  }
  const path = parsePath(query.path, "path", fields, { allowRoot: true }) ?? LIBRARY_ROOT_PATH;
  const depth = parseBounded(query.depth, { min: 1, max: LIBRARY_LIMITS.depth, fallback: 3 }, "depth", fields);
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, path, depth };
  next();
}

/** Validates a search request. */
export function validateLibrarySearchQuery(req, _res, next) {
  const fields = [];
  const query = req.query ?? {};
  for (const key of Object.keys(query)) {
    if (!["q", "path", "limit"].includes(key)) {
      fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This filter is not accepted." });
    }
  }
  const term = typeof query.q === "string" ? query.q.trim() : "";
  if (!term) fields.push({ field: "q", code: "REQUIRED", message: "Type something to search for." });
  if (term.length > 200) fields.push({ field: "q", code: "LENGTH", message: "Search for at most 200 characters." });
  const path = parsePath(query.path, "path", fields, { allowRoot: true }) ?? LIBRARY_ROOT_PATH;
  const limit = parseBounded(query.limit, { min: 1, max: 50, fallback: 20 }, "limit", fields);
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, query: term, path, limit };
  next();
}

/**
 * Validates a search by meaning: a question, which halves of the Library to search, and how many
 * passages to return.
 *
 * `kinds` is a comma-separated list rather than repeated parameters so the URL stays in the small
 * grammar the web app's client accepts. `page` is the site's own pages and `library` what has been
 * written up; leaving it out searches both.
 */
export function validateLibraryPassagesQuery(req, _res, next) {
  const fields = [];
  const query = req.query ?? {};
  for (const key of Object.keys(query)) {
    if (!["q", "kinds", "limit"].includes(key)) {
      fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This filter is not accepted." });
    }
  }
  const term = typeof query.q === "string" ? query.q.trim() : "";
  if (!term) fields.push({ field: "q", code: "REQUIRED", message: "Type something to search for." });
  if (term.length > 500) fields.push({ field: "q", code: "LENGTH", message: "Search for at most 500 characters." });
  const kinds = typeof query.kinds === "string" && query.kinds.trim()
    ? [...new Set(query.kinds.split(",").map((kind) => kind.trim()).filter(Boolean))]
    : [];
  if (kinds.some((kind) => !PASSAGE_KINDS.includes(kind))) {
    fields.push({ field: "kinds", code: "FORMAT", message: `Search only ${PASSAGE_KINDS.join(" or ")}.` });
  }
  const limit = parseBounded(query.limit, { min: 1, max: 20, fallback: 8 }, "limit", fields);
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, query: term, kinds, limit };
  next();
}

/** Validates a request for where the copy of one page of the site is: its address, and nothing else. */
export function validateLibraryLocateQuery(req, _res, next) {
  const fields = [];
  const query = req.query ?? {};
  for (const key of Object.keys(query)) {
    if (key !== "url") fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This filter is not accepted." });
  }
  const url = typeof query.url === "string" ? query.url.trim() : "";
  if (!/^https?:\/\/\S+$/i.test(url) || url.length > 2048) {
    fields.push({ field: "url", code: "FORMAT", message: "Give the page's full address." });
  }
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, url };
  next();
}

/** What a search by meaning may be narrowed to: the site's pages, or the Library's own files. */
const PASSAGE_KINDS = Object.freeze(["page", "library"]);

/**
 * Validates a saved folder or file.
 *
 * `kind` is required rather than inferred from whether `markdown` is present, because the two are
 * different things and a typo should not silently turn a folder into an empty file.
 */
export function validateLibraryNodeBody(req, _res, next) {
  const fields = [];
  const body = req.body ?? {};
  const allowed = ["kind", "title", "summary", "markdown", "tags", "sources"];
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
    }
  }

  const kind = body.kind;
  if (!LIBRARY_NODE_KIND_VALUES.includes(kind)) {
    fields.push({ field: "kind", code: "INVALID", message: "A node is a folder or a file." });
  }
  const title = parseText(body.title, "title", { max: LIBRARY_LIMITS.title, required: true }, fields);
  const summary = parseText(body.summary, "summary", { max: LIBRARY_LIMITS.summary, required: true }, fields);

  let markdown = null;
  let tags = [];
  let sources = [];
  if (kind === LIBRARY_NODE_KINDS.file) {
    // The longer of the two ceilings: a file under /sources is a copy of a page and may be as
    // long as one, and which ceiling applies to this path is the store's rule to enforce.
    markdown = parseText(body.markdown, "markdown", { max: LIBRARY_LIMITS.sourceMarkdown, required: false }, fields) ?? "";
    tags = parseTags(body.tags, fields);
    sources = parseSources(body.sources, fields);
  } else if (body.markdown !== undefined || body.tags !== undefined || body.sources !== undefined) {
    fields.push({ field: "kind", code: "INVALID", message: "A folder has no text, tags or sources." });
  }

  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, node: { kind, title, summary, markdown, tags, sources } };
  next();
}

/**
 * Validates where a node is being moved to, and the new name it takes when it is renamed.
 *
 * A rename is a move whose path follows the new title: `02 Offer` renamed `Offer` is `/offer`.
 */
export function validateLibraryMoveBody(req, _res, next) {
  const fields = [];
  const body = req.body ?? {};
  for (const key of Object.keys(body)) {
    if (!["to", "title"].includes(key)) fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
  }
  const to = parsePath(body.to, "to", fields);
  if (!to) fields.push({ field: "to", code: "REQUIRED", message: "Say where it should go." });
  const title = parseText(body.title, "title", { max: LIBRARY_LIMITS.title, required: false }, fields) || null;
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, to, title };
  next();
}

/**
 * Validates a chosen structure's shape. What makes a structure acceptable — names, paths, one
 * start folder — is `normalizeLibraryStructure` in `@orbik/library`, applied by the service.
 */
export function validateLibraryStructureBody(req, _res, next) {
  const fields = [];
  const body = req.body ?? {};
  for (const key of Object.keys(body)) {
    if (key !== "groups") fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
  }
  const groups = Array.isArray(body.groups) ? body.groups : null;
  if (!groups || !groups.length || groups.length > LIBRARY_LIMITS.groups) {
    fields.push({ field: "groups", code: "INVALID", message: `Choose between 1 and ${LIBRARY_LIMITS.groups} folders.` });
  } else {
    for (const [index, group] of groups.entries()) {
      if (group === null || typeof group !== "object" || Array.isArray(group)) {
        fields.push({ field: `groups[${index}]`, code: "INVALID", message: "Each folder is {title, summary?, subjects?, start?}." });
        continue;
      }
      for (const key of Object.keys(group)) {
        if (!["title", "summary", "subjects", "start", "path"].includes(key)) {
          fields.push({ field: `groups[${index}].${key}`, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
        }
      }
      if (typeof group.title !== "string" || !group.title.trim() || group.title.length > LIBRARY_LIMITS.groupTitle) {
        fields.push({ field: `groups[${index}].title`, code: "INVALID", message: `A folder's name is 1 to ${LIBRARY_LIMITS.groupTitle} characters.` });
      }
      if (group.summary !== undefined && (typeof group.summary !== "string" || group.summary.length > LIBRARY_LIMITS.summary)) {
        fields.push({ field: `groups[${index}].summary`, code: "INVALID", message: `A summary is at most ${LIBRARY_LIMITS.summary} characters.` });
      }
      if (group.subjects !== undefined && (!Array.isArray(group.subjects) || group.subjects.some((subject) => typeof subject !== "string" || subject.length > LIBRARY_LIMITS.segment))) {
        fields.push({ field: `groups[${index}].subjects`, code: "INVALID", message: "Subjects are a list of names." });
      }
    }
  }
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, groups };
  next();
}

/** Validates a node's place among its siblings; `null` puts it back in the default order. */
export function validateLibraryReorderBody(req, _res, next) {
  const fields = [];
  const body = req.body ?? {};
  for (const key of Object.keys(body)) {
    if (key !== "order") fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
  }
  let order = null;
  if (body.order !== null && body.order !== undefined) {
    if (!Number.isInteger(body.order) || body.order < 0 || body.order > 10_000) {
      fields.push({ field: "order", code: "RANGE", message: "Enter a whole number from 0 to 10,000, or clear it." });
    } else {
      order = body.order;
    }
  }
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, order };
  next();
}

/** Validates which kept version to restore. */
export function validateLibraryRestoreBody(req, _res, next) {
  const fields = [];
  const body = req.body ?? {};
  for (const key of Object.keys(body)) {
    if (key !== "revision") fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
  }
  if (!Number.isInteger(body.revision) || body.revision < 1) {
    fields.push({ field: "revision", code: "INVALID", message: "Name the version to restore." });
  }
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, revision: body.revision };
  next();
}

/** Canonicalizes a Library path from a query or a body, collecting the failure rather than throwing. */
function parsePath(value, field, fields, { allowRoot = false } = {}) {
  if (value === undefined || value === "") return null;
  try {
    return normalizeLibraryPath(value, { allowRoot });
  } catch (error) {
    fields.push({ field, code: "FORMAT", message: error instanceof LibraryError ? error.message : "That path is invalid." });
    return null;
  }
}

/** Validates one text field, trimming it. */
function parseText(value, field, { max, required }, fields) {
  if (value === undefined || value === null || value === "") {
    if (required) fields.push({ field, code: "REQUIRED", message: "This is required." });
    return required ? "" : null;
  }
  if (typeof value !== "string") {
    fields.push({ field, code: "INVALID", message: "This must be text." });
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed && required) {
    fields.push({ field, code: "REQUIRED", message: "This is required." });
    return "";
  }
  if (trimmed.length > max) {
    fields.push({ field, code: "LENGTH", message: `Keep this to ${max.toLocaleString("en-US")} characters.` });
    return trimmed.slice(0, max);
  }
  return trimmed;
}

/** Validates free labels. */
function parseTags(value, fields) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    fields.push({ field: "tags", code: "INVALID", message: "Tags must be a list." });
    return [];
  }
  if (value.length > LIBRARY_LIMITS.tags) {
    fields.push({ field: "tags", code: "LENGTH", message: `At most ${LIBRARY_LIMITS.tags} tags.` });
    return [];
  }
  const tags = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim() || entry.length > LIBRARY_LIMITS.tag) {
      fields.push({ field: "tags", code: "INVALID", message: `Each tag is 1 to ${LIBRARY_LIMITS.tag} characters.` });
      return [];
    }
    tags.push(entry.trim());
  }
  return [...new Set(tags)];
}

/**
 * Validates what a person says their file is written from.
 *
 * Optional, and usually empty. The Library's provenance rule binds agents, whose statements come
 * from pages they read; a person writing what they know about a customer is the source, and
 * demanding a citation would make the one kind of content nothing else can supply the hardest to
 * add.
 */
function parseSources(value, fields) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    fields.push({ field: "sources", code: "INVALID", message: "Sources must be a list." });
    return [];
  }
  if (value.length > LIBRARY_LIMITS.sources) {
    fields.push({ field: "sources", code: "LENGTH", message: `At most ${LIBRARY_LIMITS.sources} sources.` });
    return [];
  }
  const sources = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || typeof entry.ref !== "string") {
      fields.push({ field: "sources", code: "INVALID", message: 'Each source is {"kind": "page", "ref": "https://…"}.' });
      return [];
    }
    const kind = entry.kind ?? LIBRARY_SOURCE_KINDS.page;
    if (!LIBRARY_SOURCE_KIND_VALUES.includes(kind)) {
      fields.push({ field: "sources", code: "INVALID", message: `A source kind is one of ${LIBRARY_SOURCE_KIND_VALUES.join(", ")}.` });
      return [];
    }
    sources.push({ kind, ref: entry.ref });
  }
  return sources;
}
