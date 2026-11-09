/**
 * Formatting that several features share and must word the same way. Wording that belongs to one
 * feature stays with it — the crawl's in `@/lib/crawl/format`, for instance.
 */

/** A date in the viewer's own locale. */
export function formatDate(iso, { time = true } = {}) {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, time ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" });
}

/** Shows the path, for lists where every URL shares one origin. */
export function pathOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return url;
  }
}

/** Shows the host, since the scheme and trailing slash carry nothing a reader needs. */
export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * A person as the app names them. An account holds only an address, so the name is its local
 * part up to the first separator, capitalised: jane.doe@example.com reads as "Jane". Null for an
 * address that gives no name.
 *
 * @returns {{name: string, initial: string} | null}
 */
export function personFromEmail(email) {
  const word = String(email ?? "").split("@")[0].split(/[._+-]/)[0].trim();
  if (!word) return null;
  return { name: word.charAt(0).toUpperCase() + word.slice(1), initial: word.charAt(0).toUpperCase() };
}
