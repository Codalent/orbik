/** Renders a stored website URL as the bare host an owner recognizes their site by. */
export function toDomain(websiteUrl) {
  if (typeof websiteUrl !== "string" || !websiteUrl) return "";
  try {
    return new URL(websiteUrl).host.replace(/^www\./, "");
  } catch {
    return websiteUrl.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  }
}
