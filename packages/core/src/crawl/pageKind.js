/**
 * What kind of thing a page says it is, in one word.
 *
 * Two processes have to give the same answer: the crawler, which stores it on each page's Markdown
 * as `contentType`, and the source layer, which prints it at the top of each page's copy in the
 * Library. Both read it from the page's own claims — the JSON-LD types it declares, then its Open
 * Graph type — and never guess.
 *
 * The JSON-LD types are a flat list in the order the page declares them, and most of them are
 * not about the page. A site's template puts its own organisation, its logo, its search box and
 * its breadcrumbs in every page's graph, usually first. Taking the first type that was not
 * generic made every page of two development sites an `ImageObject` — the logo — including 855
 * blog posts that also declared `Article`. So the types that describe a part of a page, or the
 * site around it, are never its kind, and the first type left is.
 */

/**
 * Types that are never what a page is.
 *
 * The site and who runs it, the page as a container with nothing more said, its navigation and
 * the actions the template advertises, the pieces a page is made of — a logo, an author, one
 * question of an FAQ — and the values those carry. A page about a person says `ProfilePage`, and
 * one about a video `VideoObject` alone is still not enough to say so: the Open Graph type is.
 */
const NEVER_THE_PAGE = new Set([
  "WebSite", "WebPage", "Organization", "Corporation", "Brand", "Thing",
  "BreadcrumbList", "ListItem", "SiteNavigationElement", "WPHeader", "WPFooter", "WPSideBar", "WebPageElement",
  "ReadAction", "SearchAction", "EntryPoint", "SpeakableSpecification",
  "ImageObject", "VideoObject", "AudioObject", "MediaObject", "Person",
  "Question", "Answer", "Rating", "AggregateRating", "Offer", "AggregateOffer",
  "PropertyValue", "PropertyValueSpecification", "QuantitativeValue", "MonetaryAmount", "PriceSpecification",
  "UnitPriceSpecification", "OpeningHoursSpecification", "PostalAddress", "ContactPoint", "GeoCoordinates",
]);

/**
 * The page's own claim about what it is, or null when it makes none.
 *
 * @param {object} claims
 * @param {ReadonlyArray<string>} [claims.structuredDataTypes] JSON-LD `@type` values, in the order declared
 * @param {string|null} [claims.openGraphType] the page's `og:type`
 * @returns {string|null}
 */
export function describePageKind({ structuredDataTypes = [], openGraphType = null } = {}) {
  const declared = (structuredDataTypes ?? []).find((type) => typeof type === "string" && type && !NEVER_THE_PAGE.has(type));
  if (declared) return declared;
  return typeof openGraphType === "string" && openGraphType.trim() ? openGraphType.trim() : null;
}
