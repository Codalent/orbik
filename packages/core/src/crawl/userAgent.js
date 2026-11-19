/** The name the crawler goes by, as a site's logs and firewall rules see it. */
export const CRAWLER_PRODUCT_NAME = "OrbikBot";

/**
 * The page the User-Agent names when the install's operator names none of their own
 * (`ORBIK_CRAWLER_CONTACT_URL`): what OrbikBot is and how to block it. It is docs/orbikbot.md as
 * the docs site publishes it. Release 0.1.0 named that file on GitHub instead, so the file keeps
 * its path for as long as those crawlers are about.
 */
export const DEFAULT_CRAWLER_CONTACT_URL = "https://orbik.io/docs/orbikbot";

/**
 * Builds the product token sent on every request for a site.
 *
 * The contact URL is not decoration: it is how a site owner who sees unexpected traffic finds out
 * who is crawling and asks them to stop, and it is what distinguishes a crawler acting in good
 * faith from one that hides. Each install is run by someone else, so an operator should point it
 * at a page of their own; the agents' config checks the value at start.
 *
 * @param {string} [contactUrl] page describing the crawler and how to contact its operator
 */
export function crawlerUserAgent(contactUrl = process.env.ORBIK_CRAWLER_CONTACT_URL?.trim() || DEFAULT_CRAWLER_CONTACT_URL) {
  return `Mozilla/5.0 (compatible; ${CRAWLER_PRODUCT_NAME}/1.0; +${contactUrl})`;
}
