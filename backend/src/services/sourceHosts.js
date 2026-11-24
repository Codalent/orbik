/**
 * Sites where a page about a company usually lives, and what such a page is.
 *
 * Two uses. **Found on your website** lists the links a workspace's own site makes to pages like
 * these — its review profile, its directory listing, its public code — as sources a person may
 * want read. And **Add a source** uses the same table to suggest what a pasted address is, so
 * "Testimonials & reviews" is already chosen for a Clutch profile.
 *
 * A profile is recognised by its address alone (`profile`): `clutch.co/profile/acme` is the
 * company's page, `clutch.co/go-to-review/…` is a redirect, and the home page of a review site is
 * nobody's. Some hosts ask every crawler to stay away in their robots.txt; those are listed as
 * unreadable, so a link to one is shown with the reason rather than offered and then refused.
 *
 * Generic on purpose: these are public sites any company may be listed on, not anybody's
 * customers or partners.
 */
const KNOWN_HOSTS = Object.freeze([
  { hosts: ["clutch.co"], label: "A review profile", purpose: "reviews", profile: /^\/profile\/[^/]+\/?$/ },
  { hosts: ["goodfirms.co"], label: "A review profile", purpose: "reviews", profile: /^\/company\/[^/]+\/?$/ },
  { hosts: ["g2.com"], label: "A review profile", purpose: "reviews", profile: /^\/products\/[^/]+(\/reviews)?\/?$/ },
  { hosts: ["capterra.com"], label: "A review profile", purpose: "reviews", profile: /^\/p\/\d+\/[^/]+\/?$/ },
  { hosts: ["trustpilot.com"], label: "A review profile", purpose: "reviews", profile: /^\/review\/[^/]+\/?$/ },
  { hosts: ["trustradius.com"], label: "A review profile", purpose: "reviews", profile: /^\/products\/[^/]+(\/reviews)?\/?$/ },
  { hosts: ["producthunt.com"], label: "A launch page", purpose: "reviews", profile: /^\/products\/[^/]+\/?$/ },
  { hosts: ["designrush.com"], label: "An agency directory listing", purpose: "reviews", profile: /^\/agency\/profile\/[^/]+\/?$/ },
  { hosts: ["sortlist.com"], label: "An agency directory listing", purpose: "reviews", profile: /^\/agency\/[^/]+\/?$/ },
  { hosts: ["github.com", "gitlab.com"], label: "Your public repositories", purpose: "product", profile: /^\/[^/]+\/?$/ },
  // Each of these asks crawlers that are not on its own list to read nothing (`Disallow: /` for
  // `*` in its robots.txt), and OrbikBot obeys robots.txt.
  { hosts: ["linkedin.com"], name: "LinkedIn", label: "A LinkedIn page", purpose: "press", profile: /^\/(company|in|school)\/[^/]+\/?$/, readable: false },
  { hosts: ["facebook.com"], name: "Facebook", label: "A Facebook page", purpose: "press", profile: /^\/[^/]+\/?$/, readable: false },
  { hosts: ["instagram.com"], name: "Instagram", label: "An Instagram profile", purpose: "press", profile: /^\/[^/]+\/?$/, readable: false },
  { hosts: ["x.com", "twitter.com"], name: "X", label: "An X profile", purpose: "press", profile: /^\/[^/]+\/?$/, readable: false },
]);

/**
 * What a known host says about one address, or null when the host is not one of these or the
 * address is not a profile on it.
 *
 * @param {URL} url
 * @returns {{label: string, purpose: string, readable: boolean, reason: string|null}|null}
 */
export function describeKnownPage(url) {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const known = KNOWN_HOSTS.find((entry) => entry.hosts.includes(host));
  if (!known || !known.profile.test(url.pathname)) return null;
  const readable = known.readable !== false;
  return {
    label: known.label,
    purpose: known.purpose,
    readable,
    reason: readable ? null : `${known.name} asks crawlers not to read its pages, so Orbik cannot add it.`,
  };
}

/** The same address with `www.` and a trailing slash taken off, for telling two links apart. */
export function comparableUrl(url) {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  return `${host}${path}${url.search}`;
}
