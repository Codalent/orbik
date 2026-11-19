/**
 * The one case where two hostnames are one site: a name and the same name behind `www.`, when one
 * of them was seen redirecting to the other.
 *
 * A crawl covers one hostname, and a subdomain is a different site. But `example.com` and
 * `www.example.com` are routinely the same site under two spellings, one of which only redirects
 * to the other, and a person types whichever they remember. The crawler finds out which one
 * answers (`agents/src/crawler/seedHost.js`), moves the site's start address there and records the
 * spelling it left on the site as `redirectedFrom`. The API reads the same record to know that a
 * website typed on the other spelling is still this site. Both go through the functions here, so
 * the two processes cannot disagree about which pairs count.
 */

/**
 * Whether two hostnames are the bare and the `www.` form of one name.
 *
 * Nothing else pairs: not two subdomains of one name, not a name and its `m.` or `blog.` form.
 * The test is on the spelling alone and says nothing about whether either redirects; callers that
 * widen what a site covers also need to have seen the redirect.
 *
 * @param {string} first hostname, without a port
 * @param {string} second hostname, without a port
 * @returns {boolean}
 */
export function isWwwPair(first, second) {
  if (typeof first !== "string" || typeof second !== "string" || !first || !second) return false;
  const one = first.toLowerCase();
  const other = second.toLowerCase();
  return one === `www.${other}` || other === `www.${one}`;
}

/**
 * The other spelling of a site's address, when the crawler saw it redirect to the site.
 *
 * Read from the site document rather than trusted from it: the record counts only while it names
 * the `www.` twin of the hostname the site starts from today. A start address changed by hand to
 * some other host leaves the record behind, and it then means nothing.
 *
 * @param {{seedUrl?: string, redirectedFrom?: {host?: string, url?: string}|null}|null|undefined} site
 *   a `crawl_sites` document, or the parts of one that matter here
 * @returns {{host: string, protocol: string|null}|null} the hostname that is read as the site's
 *   own, with the scheme the address it was seen redirecting from had; null when there is none
 */
export function aliasOf(site) {
  const recorded = site?.redirectedFrom?.host;
  if (typeof recorded !== "string" || !recorded) return null;
  let seedHost;
  try {
    seedHost = new URL(site.seedUrl).hostname;
  } catch {
    return null;
  }
  if (!isWwwPair(recorded, seedHost)) return null;
  let protocol = null;
  try {
    protocol = new URL(site.redirectedFrom.url).protocol;
  } catch {
    protocol = null;
  }
  return { host: recorded.toLowerCase(), protocol };
}

/** The hostname alone of {@link aliasOf}, for a caller that only asks whether a host is the site's. */
export function aliasHostOf(site) {
  return aliasOf(site)?.host ?? null;
}

/**
 * Reads an address written with a site's other spelling as the same address on the site's host.
 *
 * The hostname becomes the seed's. So does the scheme, when the address has the scheme the old
 * spelling was seen redirecting from and the site answered on another: `http://example.com/a`,
 * for a site typed as `http://example.com/` that landed on `https://www.example.com/`, is
 * `https://www.example.com/a`, which is where that redirect leads, and not a third address that
 * redirects once more. The port, path and query stay as written. Any other address comes back
 * unchanged.
 *
 * One function for the crawler (`createScope().onSiteHost`) and the API (a website typed with the
 * old spelling), so an address means the same page to both.
 *
 * @param {string} href absolute address
 * @param {object} site where the site lives
 * @param {string} site.seedUrl the address its crawl starts from
 * @param {string|null} [site.aliasHost] the other spelling, from {@link aliasOf}
 * @param {string|null} [site.aliasProtocol] the scheme that spelling was seen redirecting from
 * @returns {string} the address to use
 */
export function readOntoSiteHost(href, { seedUrl, aliasHost = null, aliasProtocol = null }) {
  if (!aliasHost) return href;
  let address;
  let seed;
  try {
    address = new URL(href);
    seed = new URL(seedUrl);
  } catch {
    return href;
  }
  if (address.hostname !== aliasHost) return href;
  address.hostname = seed.hostname;
  if (aliasProtocol && address.protocol === aliasProtocol && seed.protocol !== aliasProtocol) {
    address.protocol = seed.protocol;
  }
  return address.href;
}
