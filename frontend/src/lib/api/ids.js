/** Rejects anything that is not a canonical MongoDB identifier before it reaches a URL. */
export function requireId(value, label) {
  if (!/^[0-9a-f]{24}$/i.test(value ?? "")) throw new Error(`${label} identifier is invalid.`);
  return value.toLowerCase();
}

/** Rejects anything that is not an agent slug before it reaches a URL. */
export function requireSlug(value) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value ?? "")) throw new Error("Agent identifier is invalid.");
  return value;
}
