import { escapeRegExp } from "../escapeRegExp.js";

/**
 * robots.txt parsing and rule evaluation, following RFC 9309.
 *
 * This module is deliberately pure: it turns text and a status code into a decision object. The
 * fetching lives in the crawler's fetcher, so every rule here is decided from the text alone and
 * never depends on a live server.
 *
 * It lives in `@orbik/core` because more than one caller may ask it the same question about
 * different crawlers. The crawler asks, before every request, whether *Orbik's* crawler may fetch
 * a path; a report may ask whether *GPTBot*, or *ClaudeBot*, may — from the same stored text, by
 * the same rules. One parser means the two cannot read a file differently, and a verdict about
 * another company's crawler is by construction what Orbik's own crawler would have concluded
 * under that name.
 *
 * `allows` is what a crawl obeys. `explain` answers the same question and also says *which line
 * of the file decided it*, for a reader who has to be shown the rule and not only the outcome.
 */

/** Largest robots.txt honoured. Content past this point is ignored, as RFC 9309 permits. */
export const MAX_ROBOTS_BYTES = 500 * 1024;

/** How a rule set was arrived at, recorded so a blocked crawl can be explained. */
export const ROBOTS_SOURCE = Object.freeze({
  parsed: "PARSED",
  unavailable: "UNAVAILABLE_ALLOW_ALL",
  unreachable: "UNREACHABLE_DENY_ALL",
});

/**
 * Parses robots.txt into per-user-agent rule groups plus the site's sitemap declarations.
 *
 * Grouping follows RFC 9309: consecutive `User-agent` lines share the rules that follow them, and
 * a rule line closes the run of agent names. `Sitemap` is not group-scoped — it belongs to the
 * file — which is why it is collected separately rather than into the matched group.
 *
 * Unknown directives are ignored rather than treated as errors. robots.txt files in the wild
 * carry vendor extensions constantly, and refusing to parse one would block an entire crawl over
 * a line no crawler needs to understand.
 *
 * Beside the patterns a decision is made from, each group keeps its lines **as written**:
 * `opened`, the first `User-agent` line that named it, and `written`, every `Allow` and
 * `Disallow` line with its number in the file and the `User-agent` line it stands under. Nothing
 * is decided from them. They exist so a verdict can quote the file rather than paraphrase it.
 *
 * @param {string} text raw robots.txt content
 * @returns {{groups: Map<string, {allow: string[], disallow: string[], crawlDelay: number | null, written: object[], opened: object}>, sitemaps: string[]}}
 */
function parseRobotsTxt(text) {
  const groups = new Map();
  const sitemaps = [];
  let currentAgents = [];
  let expectingAgents = false;
  // The `User-agent` line that named each agent in the run of names now open, for quoting.
  let currentAgentLines = new Map();
  let lineNumber = 0;

  for (const rawLine of String(text ?? "").split(/\r\n|\r|\n/)) {
    lineNumber += 1;
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;

    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const directive = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (directive === "user-agent") {
      // A new agent name after a rule line starts a fresh group rather than extending the last.
      if (!expectingAgents) {
        currentAgents = [];
        currentAgentLines = new Map();
      }
      expectingAgents = true;
      const name = value.toLowerCase();
      if (!name) continue;
      currentAgents.push(name);
      currentAgentLines.set(name, { text: line, lineNumber });
      if (!groups.has(name)) {
        groups.set(name, { allow: [], disallow: [], crawlDelay: null, written: [], opened: { text: line, lineNumber } });
      }
      continue;
    }

    if (directive === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }

    expectingAgents = false;
    if (!currentAgents.length) continue;

    for (const name of currentAgents) {
      const group = groups.get(name);
      if (directive === "disallow") {
        // An empty Disallow is an explicit "allow everything" and must not become a rule that
        // matches every path.
        if (value) group.disallow.push(value);
        group.written.push({ directive: "disallow", pattern: value, text: line, lineNumber, agentLine: currentAgentLines.get(name) });
      } else if (directive === "allow") {
        if (value) group.allow.push(value);
        if (value) group.written.push({ directive: "allow", pattern: value, text: line, lineNumber, agentLine: currentAgentLines.get(name) });
      } else if (directive === "crawl-delay") {
        const delay = Number(value);
        if (Number.isFinite(delay) && delay >= 0 && delay <= 3600) group.crawlDelay = delay;
      }
    }
  }

  return { groups, sitemaps };
}

/**
 * Builds the rule set a crawl consults before every request.
 *
 * Status handling follows RFC 9309 §2.3.1, and the asymmetry is deliberate:
 * - **2xx** — parse and obey the file.
 * - **4xx** — the site has no robots.txt, so everything is allowed. Refusing to crawl a site
 *   with no robots.txt would make the common case uncrawlable.
 * - **5xx or a network failure** — the file exists but could not be read, so nothing is allowed.
 *   Guessing "allow" here would crawl a site whose owner may have disallowed us, using an outage
 *   as the excuse.
 *
 * `source` says which of the three happened. A caller that reports on *another* crawler's access
 * must read it before `allows`: "nothing is allowed" is the right thing for Orbik's own crawler to
 * do with a file it could not read, and the wrong thing to tell a site owner about GPTBot. An
 * unread file says nothing about anybody.
 *
 * @param {object} response robots.txt retrieval outcome
 * @param {number|null} response.status HTTP status, or null when the request failed outright
 * @param {string} [response.text] body, required for a 2xx
 * @param {string} userAgent product token to decide for, e.g. `orbikbot`
 * @returns {{allows: (target: string) => boolean, explain: (target: string) => object, crawlDelay: number | null, sitemaps: string[], source: string, matchedAgent: string | null}}
 */
export function createRobotsRules({ status, text }, userAgent) {
  if (status === null || status === undefined || status >= 500) {
    return {
      allows: () => false,
      explain: () => ({ allowed: false, source: ROBOTS_SOURCE.unreachable, matchedAgent: null, group: null, rule: null }),
      crawlDelay: null,
      sitemaps: [],
      source: ROBOTS_SOURCE.unreachable,
      matchedAgent: null,
    };
  }
  if (status >= 400) {
    return {
      allows: () => true,
      explain: () => ({ allowed: true, source: ROBOTS_SOURCE.unavailable, matchedAgent: null, group: null, rule: null }),
      crawlDelay: null,
      sitemaps: [],
      source: ROBOTS_SOURCE.unavailable,
      matchedAgent: null,
    };
  }

  const { groups, sitemaps } = parseRobotsTxt(text);
  const token = String(userAgent ?? "*").toLowerCase();
  const matchedAgent = selectGroupName(groups, token);
  const group = matchedAgent ? groups.get(matchedAgent) : null;

  if (!group) {
    return {
      allows: () => true,
      explain: () => ({ allowed: true, source: ROBOTS_SOURCE.parsed, matchedAgent: null, group: null, rule: null }),
      crawlDelay: null,
      sitemaps,
      source: ROBOTS_SOURCE.parsed,
      matchedAgent: null,
    };
  }

  const allow = group.allow.map(compileRobotsPattern);
  const disallow = group.disallow.map(compileRobotsPattern);
  // The same lines again, each with the text it was written as, for `explain`.
  const written = group.written.map((line) => ({ ...line, compiled: line.pattern ? compileRobotsPattern(line.pattern) : null }));

  /**
   * Applies the longest-match rule: the most specific matching pattern decides, and `Allow`
   * wins a tie. This is what lets `Disallow: /` with `Allow: /public/` mean "only /public".
   *
   * @param {string} target path plus query, e.g. `/products?page=2`
   */
  function allows(target) {
    const path = target || "/";
    const longestAllow = longestMatch(allow, path);
    const longestDisallow = longestMatch(disallow, path);
    if (longestDisallow === null) return true;
    if (longestAllow === null) return false;
    return longestAllow >= longestDisallow;
  }

  return {
    allows,

    /**
     * The same decision as {@link allows}, with the lines of the file that made it.
     *
     * `group` is the `User-agent` line the deciding rule stands under — or, when no rule matched
     * the path, the first one that opened this crawler's group — and `rule` is the `Allow` or
     * `Disallow` line that decided, each as written with its line number. `rule` is null when the
     * group has no rule that matches the path, which allows it; an empty `Disallow:` is quoted
     * then if the group has one, because it is the line somebody wrote to say so.
     *
     * The outcome is taken from `allows` itself, never worked out a second time, so the two
     * cannot disagree about a path. Only which line to quote is decided here: the longest
     * matching pattern of the winning directive, and the first written among equals.
     *
     * @param {string} target path plus query, e.g. `/products?page=2`
     * @returns {{allowed: boolean, source: string, matchedAgent: string, group: {text: string, lineNumber: number}, rule: {directive: string, pattern: string, text: string, lineNumber: number}|null}}
     */
    explain(target) {
      const path = target || "/";
      const allowed = allows(path);
      const deciding = longestWritten(written, allowed ? "allow" : "disallow", path)
        // Allowed with no `Allow` line matching means no `Disallow` matched either. An empty
        // `Disallow:` is then the nearest thing to a rule the file has.
        ?? (allowed ? written.find((line) => line.directive === "disallow" && !line.pattern) ?? null : null);
      const opening = deciding?.agentLine ?? group.opened;
      return {
        allowed,
        source: ROBOTS_SOURCE.parsed,
        matchedAgent,
        group: { text: opening.text, lineNumber: opening.lineNumber },
        rule: deciding
          ? { directive: deciding.directive, pattern: deciding.pattern, text: deciding.text, lineNumber: deciding.lineNumber }
          : null,
      };
    },
    crawlDelay: group.crawlDelay,
    sitemaps,
    source: ROBOTS_SOURCE.parsed,
    matchedAgent,
  };
}

/**
 * Chooses the group governing this crawler.
 *
 * An exact product-token match beats `*`, and no other partial matching is performed: RFC 9309
 * matches the token, and treating `googlebot-news` rules as ours because the string overlaps
 * would obey rules aimed at somebody else.
 */
function selectGroupName(groups, token) {
  if (groups.has(token)) return token;
  return groups.has("*") ? "*" : null;
}

/**
 * Compiles one robots path pattern.
 *
 * robots.txt supports exactly two metacharacters — `*` for any run of characters and a trailing
 * `$` for end-of-path — and matching is prefix-based otherwise. Every other character is escaped,
 * so a path containing regex syntax cannot alter the pattern's meaning.
 *
 * @returns {{regex: RegExp, length: number}} the matcher and its specificity
 */
function compileRobotsPattern(pattern) {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split("*")
    .map((literal) => escapeRegExp(literal))
    .join("[^]*");
  return { regex: new RegExp(`^${source}${anchored ? "$" : ""}`), length: pattern.length };
}

/** Returns the specificity of the longest matching pattern, or null when none match. */
function longestMatch(patterns, path) {
  let longest = null;
  for (const pattern of patterns) {
    if (pattern.regex.test(path) && (longest === null || pattern.length > longest)) {
      longest = pattern.length;
    }
  }
  return longest;
}

/** The written line of one directive whose pattern matches the path most specifically, or null. */
function longestWritten(written, directive, path) {
  let longest = null;
  for (const line of written) {
    if (line.directive !== directive || !line.compiled || !line.compiled.regex.test(path)) continue;
    if (longest === null || line.compiled.length > longest.compiled.length) longest = line;
  }
  return longest;
}
