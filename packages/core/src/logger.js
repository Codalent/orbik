const SECRET_KEY = /password|secret|token|session|cookie|authorization/i;
const URL_KEY = /url/i;

/** Recursively redacts secrets and URL details before structured logging. */
function redactValue(value, key = "") {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (URL_KEY.test(key) && typeof value === "string") {
    try {
      const parsed = new URL(value);
      return `${parsed.origin}/[REDACTED]`;
    } catch {
      return "[REDACTED]";
    }
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
      childKey,
      redactValue(child, childKey),
    ]));
  }
  return value;
}

/** Emits one newline-delimited JSON record without accepting unredacted context. */
export function log(level, message, context = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...redactValue(context),
  };
  const target = level === "error" ? console.error : console.log;
  target(JSON.stringify(record));
}
