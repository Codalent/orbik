import { parseBounded, validationError } from "./shared.js";

/**
 * Validates a request for one agent's source verdicts.
 *
 * `relevant` is tri-state on purpose: absent means both halves, which is the listing a person
 * gets when they want to see everything the agent looked at.
 */
export function validateSourcesQuery(req, _res, next) {
  const fields = [];
  const query = req.query ?? {};
  for (const key of Object.keys(query)) {
    if (!["relevant", "limit", "skip"].includes(key)) {
      fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This filter is not accepted." });
    }
  }

  let relevant;
  if (query.relevant !== undefined && query.relevant !== "") {
    if (query.relevant !== "true" && query.relevant !== "false") {
      fields.push({ field: "relevant", code: "INVALID", message: "Filter by true or false." });
    } else {
      relevant = query.relevant === "true";
    }
  }

  const limit = parseBounded(query.limit, { min: 1, max: 500, fallback: 100 }, "limit", fields);
  const skip = parseBounded(query.skip, { min: 0, max: 100_000, fallback: 0 }, "skip", fields);
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, relevant, limit, skip };
  next();
}

/**
 * Validates a request to include one source.
 *
 * The body names a source by the agent's own key — the crawler's URL hash, exactly as the listing
 * returns it — rather than by URL. A URL would have to be resolved against the crawl and could
 * name a page this agent has no verdict on at all, which is not a request anybody can act on.
 */
export function validateSourceIncludeBody(req, _res, next) {
  const fields = [];
  const body = req.body ?? {};
  for (const key of Object.keys(body)) {
    if (key !== "key") fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not accepted." });
  }
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!key || key.length > 128 || !/^[\w-]+$/.test(key)) {
    fields.push({ field: "key", code: "INVALID", message: "Name the source by the key the listing returned." });
  }
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, key };
  next();
}

/** Validates the optional `format=text` on the llms.txt route. */
export function validateLlmsQuery(req, _res, next) {
  const fields = [];
  const query = req.query ?? {};
  for (const key of Object.keys(query)) {
    if (key !== "format") fields.push({ field: key, code: "UNKNOWN_FIELD", message: "This filter is not accepted." });
  }
  const format = query.format === undefined || query.format === "" ? "json" : query.format;
  if (format !== "json" && format !== "text") {
    fields.push({ field: "format", code: "INVALID", message: "Ask for json or text." });
  }
  if (fields.length) return next(validationError(fields));
  req.validated = { ...req.validated, format };
  next();
}
