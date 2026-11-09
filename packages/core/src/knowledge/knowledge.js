/**
 * The vocabulary of the two agents that read a site's Markdown and write something durable from
 * it: the business knowledge base, and the llms.txt file.
 *
 * It lives in `@orbik/core` because three processes need to agree on it. The tools in
 * `@orbik/tools` write these documents, the API reads them, and the web app routes to them by
 * slug. A slug that disagreed across those three would be a page nobody could open.
 */

/** The agent that builds and maintains the knowledge base. */
export const KNOWLEDGE_AGENT_SLUG = "business-knowledge-base";

/** The agent that maintains the llms.txt file. */
export const LLMS_TXT_AGENT_SLUG = "llms-txt";

/** Bounds on the llms.txt file. */
export const LLMS_LIMITS = Object.freeze({
  /** The file is meant to be read into a model's context whole; 64 KB is already generous. */
  content: 64_000,
  sections: 30,
  links: 400,
});

/**
 * How a source page stands in relation to an agent's output.
 *
 * The whole point of the second run is that these are computed from stored content hashes rather
 * than believed from a timestamp: `changed` means the Markdown is genuinely different from what
 * was folded in, not that a crawl happened to touch the page.
 */
export const SOURCE_STATUS = Object.freeze({
  /** Never reviewed by this agent. */
  new: "new",
  /** Reviewed and used, and the page has changed since. */
  changed: "changed",
  /** Reviewed and used, and unchanged since. */
  current: "current",
  /** Reviewed and judged not to belong. Stays excluded even when the page changes. */
  excluded: "excluded",
  /**
   * Hidden because the route it belongs to was excluded, not because anyone judged this page.
   *
   * This is what makes selection scale. Excluding a URL does nothing about next week's blog post;
   * excluding `/blog/[slug]` decides the whole shape of page once, and every post published
   * afterwards arrives already accounted for. A per-page verdict still wins over its route, so a
   * pillar guide under an excluded route can be pulled back in by name.
   */
  excludedByRoute: "excluded-by-route",
});

/** Every source status, as an array. */
export const SOURCE_STATUS_VALUES = Object.freeze(Object.values(SOURCE_STATUS));
