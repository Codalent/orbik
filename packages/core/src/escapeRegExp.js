/**
 * Escapes every character a regular expression treats as syntax, so a string can be matched
 * literally — in a `RegExp` or a MongoDB `$regex` — whatever a person or a page put in it.
 *
 * @param {string} value text to match literally
 * @returns {string}
 */
export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
