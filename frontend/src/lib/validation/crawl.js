import { z } from "zod";

import { canonicalizePublicUrl, workspaceUrlSchema } from "./workspace";

/**
 * How often one route pattern, or one page, is recrawled, as the choices a person can make.
 *
 * Fewer choices than the site's own cadence, and one more: "never" means the pages are fetched
 * when they are discovered and then only when somebody asks — the right answer for a legal page,
 * and the answer every pattern gets until the AI or a person decides otherwise. The value is
 * carried as a string because a native select cannot hold null, and `""` is the form's way of
 * saying "no choice made".
 */
export const PATTERN_FREQUENCIES = Object.freeze([
  { value: "24", intervalHours: 24, label: "Daily" },
  { value: "168", intervalHours: 168, label: "Weekly" },
  { value: "720", intervalHours: 720, label: "Monthly" },
  { value: "never", intervalHours: null, label: "Manual trigger" },
]);

/** Converts a frequency select's value back to an interval; `undefined` when nothing was chosen. */
export function frequencyToInterval(value) {
  const option = PATTERN_FREQUENCIES.find((entry) => entry.value === value);
  return option ? option.intervalHours : undefined;
}

/** Converts an interval to the select value that names it; `""` when it matches no choice. */
export function intervalToFrequency(intervalHours) {
  const option = PATTERN_FREQUENCIES.find((entry) => entry.intervalHours === intervalHours);
  return option ? option.value : "";
}

/**
 * How many sitemaps one site may be told about by hand.
 *
 * Sitemaps found in robots.txt are uncapped, because the site is describing itself. This bound is
 * on typing, and twenty pasted lines is already far past the point where the answer is to fix
 * robots.txt instead.
 */
const MAX_SITEMAP_URLS = 20;

/**
 * The sitemaps someone pasted, one per line.
 *
 * Kept as free text rather than a repeatable field because the source is almost always a clipboard,
 * and a person with four sitemap URLs should be able to paste four lines rather than press "add"
 * four times. Commas are accepted alongside newlines for the same reason: it is the other shape a
 * pasted list arrives in.
 *
 * Each line is canonicalized through the same rule the seed URL uses, so a sitemap can never name a
 * target the seed itself would have been refused for.
 */
const sitemapUrlsField = z.string().optional().transform((value, context) => {
  const lines = (value ?? "").split(/[\n,]+/).map((line) => line.trim()).filter(Boolean);
  const seen = new Set();
  const urls = [];

  for (const line of lines) {
    let canonical;
    try {
      canonical = canonicalizePublicUrl(line);
    } catch {
      context.addIssue({ code: "custom", message: `${line} is not a complete public sitemap URL.` });
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    urls.push(canonical);
  }

  if (urls.length > MAX_SITEMAP_URLS) {
    context.addIssue({ code: "custom", message: `Enter at most ${MAX_SITEMAP_URLS} sitemap URLs.` });
  }
  return urls;
});

/**
 * Rejects sitemaps that describe some other site than the one being crawled.
 *
 * A sitemap on another hostname lists another site's pages, and following it would fold a second
 * site's URLs into this workspace's totals. It is also the one place a person could point the
 * crawler's outbound requests at a host of their choosing, which is reason enough on its own.
 */
function requireSitemapsOnSeedHost(values, context) {
  let host;
  try {
    host = new URL(values.seedUrl).hostname;
  } catch {
    return;
  }
  for (const url of values.sitemapUrls ?? []) {
    if (new URL(url).hostname !== host) {
      context.addIssue({
        code: "custom",
        path: ["sitemapUrls"],
        message: `${url} is not on ${host}. A sitemap on another hostname describes another site.`,
      });
    }
  }
}

/**
 * What is asked for before a site has ever been crawled.
 *
 * Only the address, and optionally where the sitemaps are. Everything else about a crawl is either
 * decided by the crawler or measured by the first run, and asking about it here would be asking
 * someone to guess.
 */
export const crawlSetupSchema = z.object({
  seedUrl: workspaceUrlSchema,
  sitemapUrls: sitemapUrlsField,
}).strict().superRefine(requireSitemapsOnSeedHost);

/**
 * Crawl settings schema, used once a site exists and its schedule is a person's to adjust.
 *
 * The bounds mirror the API's, which mirror the crawler's. The repetition is deliberate: this copy
 * exists to tell someone their value is out of range while they are still looking at the field,
 * and neither of the other two can do that.
 *
 * The schema is deliberately narrower than what the API accepts, because three crawl limits are no
 * longer a person's to set.
 *
 * `maxDepth` asks how many link hops from the home page a site needs, which nobody has measured,
 * and its effect is invisible either way — pages beyond it are recorded with a `MAX_DEPTH` reason
 * and simply never appear. The crawler's own default stands.
 *
 * `maxPages` is gone for a different reason: how much of a site gets fetched is no longer a
 * per-site setting at all. It is the account's monthly crawl budget, spent one page at a time
 * across every site the account crawls, and a number that lives on one site could never have said
 * anything true about it.
 *
 * `subdomainPolicy` is gone because a subdomain is a separate site. It has its own content, often
 * its own owner, and its own findings, so it belongs in its own workspace rather than folded into
 * this one's totals — which also keeps a crawl's page count honest.
 */
export const crawlSettingsSchema = z.object({
  seedUrl: workspaceUrlSchema,
  sitemapUrls: sitemapUrlsField,
}).strict().superRefine(requireSitemapsOnSeedHost);
