/**
 * Environment primitives shared by every Orbik process.
 *
 * Each process owns different inputs: the API needs HTTP and session values, while agent
 * workers need only a database. The primitives here validate the inputs every process shares
 * and append their failures to a caller-owned error list, so each process can aggregate all
 * of its own problems into one startup error instead of failing on the first bad value.
 */

/** Runtimes the application is written for. */
const NODE_ENVIRONMENTS = new Set(["development", "production"]);

/**
 * Validates `NODE_ENV` and returns its canonical value.
 *
 * An unrecognized runtime is reported rather than thrown so the caller can collect every
 * environment failure. The returned value is still the raw input in that case; callers must
 * not use it once `errors` is non-empty.
 *
 * @param {Record<string, string | undefined>} source environment values
 * @param {string[]} errors caller-owned list that receives safe failure messages
 * @returns {string} canonical runtime name, defaulting to `development`
 */
export function parseNodeEnv(source, errors) {
  const nodeEnv = source.NODE_ENV ?? "development";
  if (!NODE_ENVIRONMENTS.has(nodeEnv)) {
    errors.push("NODE_ENV must be development or production.");
  }
  return nodeEnv;
}

/**
 * Validates `MONGODB_URI` and extracts the database name it targets.
 *
 * The database name is required because every process resolves collections through it. The URI
 * itself is never echoed in an error message.
 *
 * @param {Record<string, string | undefined>} source environment values
 * @param {string[]} errors caller-owned list that receives safe failure messages
 * @returns {{ mongodbUri: string, databaseName: string }} connection inputs
 */
export function parseMongoUri(source, errors) {
  const mongodbUri = source.MONGODB_URI ?? "";
  let databaseName = "";
  try {
    const parsed = new URL(mongodbUri);
    if (!["mongodb:", "mongodb+srv:"].includes(parsed.protocol)) {
      throw new Error("unsupported scheme");
    }
    databaseName = parsed.pathname.replace(/^\//, "");
    if (!databaseName) {
      errors.push("MONGODB_URI must include a database name.");
    }
  } catch {
    errors.push("MONGODB_URI must be a valid MongoDB URI.");
  }
  return { mongodbUri, databaseName };
}

/**
 * Parses one optional integer input, appending a safe message when it is not a whole number
 * inside the documented range.
 *
 * A blank or absent value takes the default; a present but unparseable value is an error rather
 * than a silent fallback, because silently ignoring a misspelled tuning value hides
 * misconfiguration until production behaves unexpectedly — an API quietly rate-limiting at the
 * default because somebody typo'd the ceiling would look exactly like one that was configured.
 *
 * @param {string | undefined} raw environment value
 * @param {number} fallback value used when the input is absent
 * @param {number} minimum inclusive lower bound
 * @param {number} maximum inclusive upper bound
 * @param {string} name environment variable name used in error messages
 * @param {string[]} errors caller-owned list that receives safe failure messages
 * @returns {number} the parsed value, or `fallback` when absent or rejected
 */
export function parseBoundedInteger(raw, fallback, minimum, maximum, name, errors) {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    errors.push(`${name} must be an integer from ${minimum} through ${maximum}.`);
    return fallback;
  }
  return value;
}

/**
 * Parses one optional http(s) URL input, falling back to a documented default.
 *
 * A present but unparseable value is an error rather than a silent fallback, for the same reason
 * a misspelled integer is: a worker quietly indexing into the default Qdrant because somebody
 * typo'd the host would look exactly like one that was working.
 *
 * The trailing slash is removed so a value can be concatenated with a path without producing a
 * double slash, and so two spellings of the same host cannot disagree about an identifier that is
 * compared character for character, such as the `resource` an MCP client checks.
 *
 * @param {string | undefined} raw environment value
 * @param {string} fallback value used when the input is absent
 * @param {string} name environment variable name used in error messages
 * @param {string[]} errors caller-owned list that receives safe failure messages
 * @returns {string} the canonical URL, or `fallback` when absent or rejected
 */
export function parseUrl(raw, fallback, name, errors) {
  const value = (raw ?? "").trim();
  if (!value) return fallback;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
    return url.origin + (url.pathname === "/" ? "" : url.pathname.replace(/\/$/, ""));
  } catch {
    errors.push(`${name} must be an http or https URL.`);
    return fallback;
  }
}

/**
 * Throws one aggregated startup error when any environment value was rejected.
 *
 * @param {string[]} errors collected safe failure messages
 * @throws {Error} listing every failure when `errors` is non-empty
 */
export function assertValidEnvironment(errors) {
  if (errors.length) {
    throw new Error(`Invalid environment configuration:\n- ${errors.join("\n- ")}`);
  }
}
