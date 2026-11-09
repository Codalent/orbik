/**
 * Describes a tool result in the few words a progress line has room for.
 *
 * Deliberately shallow: this is the "✓ Crawled 1,284 pages" text, not a summary of the data. It
 * reads the shapes Orbik's own tools return, and says nothing rather than guessing at others.
 *
 * Shared by every runtime in this worker so a run reads the same whichever executed it.
 *
 * @param {unknown} result what a tool returned
 * @returns {string | null}
 */
export function summarize(result) {
  if (!result || typeof result !== "object") return null;
  // A change to a brand says what it set, for the run's progress and for the chat's record.
  if (typeof result.changed === "string") return result.changed.slice(0, 200);
  // A Library write or move says what it did to which path, because those are the only lines in a
  // Library run that report progress rather than reading.
  if (typeof result.path === "string" && typeof result.action === "string") return `${result.action} ${result.path}`;
  if (typeof result.path === "string" && typeof result.deleted === "boolean") {
    return result.deleted ? `deleted ${result.path}` : `${result.path} was not there`;
  }
  // Both ends of a move, because "moved 3 to /b" does not say what used to be where; a rename in
  // place moves nothing and says so.
  if (typeof result.to === "string" && Number.isInteger(result.moved)) {
    if (typeof result.from === "string" && result.from === result.to) return `renamed ${result.to}`;
    return typeof result.from === "string"
      ? `moved ${result.from} to ${result.to}`
      : `moved ${result.moved.toLocaleString()} to ${result.to}`;
  }
  // The Library agent's map of the site, its arrangement of the top level, and one copied page
  // opened to be read. Read before the generic shapes below, which `site` and `path` would match.
  if (result.site && Array.isArray(result.chosen) && Array.isArray(result.listings)) {
    return `${result.site.stored.toLocaleString()} pages, ${result.chosen.length.toLocaleString()} chosen`;
  }
  if (Array.isArray(result.sections) && Array.isArray(result.unplaced)) {
    return `${result.sections.length.toLocaleString()} ${result.sections.length === 1 ? "section" : "sections"}`;
  }
  if (typeof result.provenance === "string" && typeof result.path === "string") return "1 page read";
  // The Title and meta description agent's three tools: what was counted, what there is to write,
  // and what was stored. Read before the generic shapes below, which the same fields would match.
  if (result.site && Number.isInteger(result.site.checked) && result.counts) {
    const flagged = result.counts.pagesWithProblems ?? 0;
    return `${result.site.checked.toLocaleString()} pages checked, ${flagged.toLocaleString()} with a problem`;
  }
  if (Array.isArray(result.pages) && Array.isArray(result.templates)) {
    const parts = [
      result.pages.length ? `${result.pages.length.toLocaleString()} ${result.pages.length === 1 ? "page" : "pages"}` : null,
      result.templates.length ? `${result.templates.length.toLocaleString()} ${result.templates.length === 1 ? "template" : "templates"}` : null,
    ].filter(Boolean);
    return parts.length ? `${parts.join(" and ")} to write for` : "nothing to write";
  }
  if (Number.isInteger(result.stored) && Array.isArray(result.refused)) {
    return result.refused.length
      ? `${result.stored.toLocaleString()} stored, ${result.refused.length.toLocaleString()} refused`
      : `${result.stored.toLocaleString()} stored`;
  }
  if (Array.isArray(result.routes)) {
    return `${result.routes.length.toLocaleString()} ${result.routes.length === 1 ? "route" : "routes"}`;
  }
  if (Number.isInteger(result.recordedPages) || Number.isInteger(result.recordedRoutes)) {
    const parts = [
      result.recordedPages ? `${result.recordedPages.toLocaleString()} pages` : null,
      result.recordedRoutes ? `${result.recordedRoutes.toLocaleString()} routes` : null,
    ].filter(Boolean);
    return parts.length ? `${parts.join(" and ")} reviewed` : "nothing to review";
  }
  if (Array.isArray(result.matches)) {
    return `${result.matches.length.toLocaleString()} ${result.matches.length === 1 ? "match" : "matches"}`;
  }
  if (result.stats && Number.isInteger(result.stats.nodes)) {
    return `${result.stats.nodes.toLocaleString()} ${result.stats.nodes === 1 ? "node" : "nodes"}`;
  }
  if (typeof result.action === "string" && Number.isInteger(result.links)) {
    return `${result.action}, ${result.links.toLocaleString()} links`;
  }
  if (Number.isInteger(result.recorded)) return `${result.recorded.toLocaleString()} pages reviewed`;
  if (typeof result.homeSlug === "string") {
    return `${result.total.toLocaleString()} knowledge ${result.total === 1 ? "page" : "pages"}`;
  }
  if (Array.isArray(result.pages) && result.counts) {
    const counts = [
      result.counts.new ? `${result.counts.new} new` : null,
      result.counts.changed ? `${result.counts.changed} changed` : null,
    ].filter(Boolean);
    return counts.length ? `${result.total.toLocaleString()} pages, ${counts.join(", ")}` : `${result.total.toLocaleString()} pages`;
  }
  if (Array.isArray(result.pages) && Array.isArray(result.skipped)) {
    return `${result.pages.length.toLocaleString()} ${result.pages.length === 1 ? "page" : "pages"} read`;
  }
  if (Number.isInteger(result.total)) return `${result.total.toLocaleString()} results`;
  if (Number.isInteger(result.pages)) return `${result.pages.toLocaleString()} pages`;
  if (Number.isInteger(result.inboundCount)) return `${result.inboundCount.toLocaleString()} inbound links`;
  return null;
}
