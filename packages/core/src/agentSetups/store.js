import { createHash } from "node:crypto";

import { AGENT_COLLECTIONS } from "../db/collections.js";
import { toObjectId } from "../db/objectId.js";
import { BRAND_LIMITS, DESIGN_SYSTEM_AGENT_SLUG } from "../designSystem/designSystem.js";
import { KNOWLEDGE_AGENT_SLUG, LLMS_TXT_AGENT_SLUG } from "../knowledge/knowledge.js";

/**
 * Bounds on a page list a person chose for an agent, for an agent that names none of its own:
 * at least one page and at most twenty, with a ceiling on each field.
 */
const DEFAULT_PAGE_LIMITS = Object.freeze({ min: 1, max: 20, url: 2000, label: 120, pattern: 300 });

/**
 * Bounds on the pages a person may choose for the Design system agent to render.
 *
 * None is allowed, and is the ordinary case: the agent picks the home page and the busiest page
 * of each of the site's main route patterns for itself, and this list is only how a person
 * overrides that choice. The ceiling is the run's own — every page is rendered at two viewports
 * in a real browser — so a longer list would be a longer run rather than a better system.
 */
const DESIGN_PAGE_LIMITS = Object.freeze({ ...DEFAULT_PAGE_LIMITS, min: 0, max: BRAND_LIMITS.pages });

/** The page-list bounds of each agent that has its own; every other agent gets the default. */
const AGENT_PAGE_LIMITS = Object.freeze({ [DESIGN_SYSTEM_AGENT_SLUG]: DESIGN_PAGE_LIMITS });

/**
 * The bounds on the page list one agent's setup may hold.
 *
 * @param {string} [agentSlug] the agent; omitted means the default bounds
 * @returns {{min: number, max: number, url: number, label: number, pattern: number}}
 */
export function pageLimitsFor(agentSlug) {
  return AGENT_PAGE_LIMITS[agentSlug] ?? DEFAULT_PAGE_LIMITS;
}

/**
 * What "set this agent to work" means for each agent.
 *
 * Two things vary and nothing else does: what makes the agent run, and whether it is useless until
 * a person has configured something (`requiresPages`: a list of pages chosen by a person, without
 * which every run would be empty). The knowledge agents read whatever the crawler found, so they
 * have nothing to configure and the button is the whole setup.
 *
 * `cadenceHours` is how often the schedule fires, and `null` means it never does: the agent is
 * started by the work upstream of it instead. The Library is one such agent — it writes when the
 * pages it is written from have changed, which is when a crawl found something new, and a clock
 * has nothing to add to that. Nobody can start it by hand; "working" is its only switch.
 *
 * `onRequest` marks the third kind: an agent that nothing starts but a person, each time, after
 * agreeing to what the run will cost — one that fetches pages from sites the workspace does not
 * own, say. Such an agent has no cadence, no switch to set it to work, and no upstream work that
 * could start it. No agent in this release is one; the schedule loop and the API still honour
 * the mark.
 *
 * A table rather than a branch in the API, so adding an agent that runs on a schedule is a row.
 */
const AGENT_SCHEDULE_PROFILES = Object.freeze({
  [KNOWLEDGE_AGENT_SLUG]: Object.freeze({ cadenceHours: null, requiresPages: false }),
  // Weekly: a site's map does not change on a Tuesday, and the agent only rewrites what moved, so
  // a week is frequent enough to stay current and rare enough to cost almost nothing otherwise.
  [LLMS_TXT_AGENT_SLUG]: Object.freeze({ cadenceHours: 24 * 7, requiresPages: false }),
  // Weekly, and nearly free: a run first compares a fingerprint of the home page's markup and
  // stylesheets with the one the system was derived at, and ends there when they match. A
  // redesign is rare, so most weeks cost two plain requests and no browser. It needs no pages
  // chosen — it picks its own — and it is not started by a crawl: a site crawled daily would be
  // fingerprinted daily for a change that happens a few times a year.
  [DESIGN_SYSTEM_AGENT_SLUG]: Object.freeze({ cadenceHours: 24 * 7, requiresPages: false }),
});

/** The default profile, for an agent published without one: weekly, nothing to configure. */
const DEFAULT_SCHEDULE_PROFILE = Object.freeze({ cadenceHours: 24 * 7, requiresPages: false });

/**
 * How an agent is scheduled, falling back to a weekly run with no setup.
 *
 * @param {string} agentSlug the agent
 * @returns {{cadenceHours: number|null, requiresPages: boolean}}
 */
export function scheduleProfileFor(agentSlug) {
  return AGENT_SCHEDULE_PROFILES[agentSlug] ?? DEFAULT_SCHEDULE_PROFILE;
}

/**
 * The agents no clock and no person starts: the ones whose runs follow from work upstream of them.
 *
 * The schedule loop excludes these by name rather than by a missing due time, because a schedule
 * row written before an agent stopped being weekly still carries one.
 */
export const UPSTREAM_AGENT_SLUGS = Object.freeze(
  Object.entries(AGENT_SCHEDULE_PROFILES)
    .filter(([, profile]) => profile.cadenceHours === null && !profile.onRequest)
    .map(([slug]) => slug),
);

/** Whether an agent is started by upstream work rather than by a schedule or a person. */
export function isUpstreamAgent(agentSlug) {
  return UPSTREAM_AGENT_SLUGS.includes(agentSlug);
}

/**
 * The agents only a person starts, one run at a time, through a route of their own that makes
 * them confirm what the run will cost.
 *
 * The schedule loop excludes these by name, as it does the upstream agents, so a schedule row
 * that should never have been written for one still starts nothing. The API refuses to set one to
 * work, and refuses to start one through the route every other agent is started by.
 */
export const ON_REQUEST_AGENT_SLUGS = Object.freeze(
  Object.entries(AGENT_SCHEDULE_PROFILES)
    .filter(([, profile]) => profile.onRequest)
    .map(([slug]) => slug),
);

/** Whether an agent runs only when a person starts it, after confirming its cost. */
export function isOnRequestAgent(agentSlug) {
  return ON_REQUEST_AGENT_SLUGS.includes(agentSlug);
}

/**
 * The stable identity of a tracked page.
 *
 * A hash of the URL rather than the URL itself, so a report can be joined to its page across
 * runs without a two-kilobyte key, and so the same page added twice collapses into one row. The
 * URL is normalised first: a trailing slash or a stray fragment is not a different page.
 *
 * @param {string} url the page's URL
 * @returns {string} sixteen hex characters
 */
function pageKeyOf(url) {
  return createHash("sha256").update(canonicalUrl(url)).digest("hex").slice(0, 16);
}

/** Puts a URL in the one form the key is computed from. */
function canonicalUrl(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) parsed.pathname = parsed.pathname.slice(0, -1);
  return parsed.toString();
}

/**
 * Validates and canonicalises the pages a person chose.
 *
 * Shared by the API's validator and the store, so what the API accepts and what the store writes
 * are one rule. Returns the problems rather than throwing, because the API turns them into
 * field-level messages and the store treats any of them as a programming error.
 *
 * @param {unknown} input the submitted list
 * @param {ReturnType<typeof pageLimitsFor>} [limits] the agent's bounds, from {@link pageLimitsFor};
 *   the default bounds when omitted
 * @returns {{pages: object[], errors: Array<{field: string, message: string}>}}
 */
export function normalizeTrackedPages(input, limits = DEFAULT_PAGE_LIMITS) {
  const errors = [];
  if (!Array.isArray(input)) return { pages: [], errors: [{ field: "pages", message: "Choose the pages to track." }] };
  if (input.length < limits.min) errors.push({ field: "pages", message: "Choose at least one page." });
  if (input.length > limits.max) errors.push({ field: "pages", message: `Choose up to ${limits.max} pages.` });

  const pages = [];
  const seen = new Set();
  input.forEach((entry, index) => {
    const field = `pages[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push({ field, message: "Each page must be an object." });
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!["url", "label", "pattern"].includes(key)) errors.push({ field: `${field}.${key}`, message: "This field is not accepted." });
    }
    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    let parsed = null;
    try {
      parsed = url && url.length <= DEFAULT_PAGE_LIMITS.url ? new URL(url) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || !["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
      errors.push({ field: `${field}.url`, message: "Enter a full http(s) URL." });
      return;
    }
    const key = pageKeyOf(url);
    if (seen.has(key)) {
      errors.push({ field: `${field}.url`, message: "This page is already in the list." });
      return;
    }
    seen.add(key);

    const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim().slice(0, DEFAULT_PAGE_LIMITS.label) : defaultLabel(parsed);
    const pattern = typeof entry.pattern === "string" && entry.pattern.trim() ? entry.pattern.trim().slice(0, DEFAULT_PAGE_LIMITS.pattern) : null;
    pages.push({ key, url: canonicalUrl(url), label, pattern });
  });

  return { pages, errors };
}

/** A label a person would recognise the page by, when they did not give one. */
function defaultLabel(parsed) {
  const path = parsed.pathname === "/" ? "Home" : decodeURIComponent(parsed.pathname).replace(/\/$/, "");
  return path.slice(0, DEFAULT_PAGE_LIMITS.label);
}

/**
 * Persistence for what a person configured an agent to do.
 *
 * Shared by the API, which writes the list, and the agents worker, which reads it at the start
 * of every run. The worker reads the setup rather than receiving the list in the run's input so
 * that a page added the day before a scheduled run is measured by that run, and a run's input
 * stays an empty object nobody can use to point the agent at a page the person did not choose.
 *
 * @param {object} options collaborators
 * @param {import("mongodb").Db} options.database connected database
 * @param {() => Date} [options.now] clock; defaults to the system clock
 */
export function createAgentSetupStore({ database, now = () => new Date() }) {
  const setups = database.collection(AGENT_COLLECTIONS.agentSetups);

  return {
    /** Finds the one setup for an agent in a workspace, or null. */
    find({ workspaceId, agentSlug }) {
      return setups.findOne({ workspaceId: toObjectId(workspaceId), agentSlug });
    },

    /**
     * Creates or replaces the tracked pages, keeping when each was first added.
     *
     * The `addedAt` of a page that is already on the list survives a save, so the dashboard can
     * say "tracked since March" rather than "since the last time the list was edited".
     *
     * @param {object} input
     * @param {string|ObjectId} input.workspaceId owning workspace
     * @param {string} input.agentSlug which agent
     * @param {object[]} input.pages pages from {@link normalizeTrackedPages}
     * @returns {Promise<object>} the stored setup
     */
    async save({ workspaceId, agentSlug, pages }) {
      const current = now();
      const filter = { workspaceId: toObjectId(workspaceId), agentSlug };
      const existing = await setups.findOne(filter, { projection: { pages: 1 } });
      const added = new Map((existing?.pages ?? []).map((page) => [page.key, page.addedAt]));
      const stored = pages.map((page) => ({ ...page, addedAt: added.get(page.key) ?? current }));
      return setups.findOneAndUpdate(
        filter,
        {
          $set: { pages: stored, updatedAt: current },
          $setOnInsert: { ...filter, working: false, lastRunAt: null, createdAt: current },
        },
        { upsert: true, returnDocument: "after" },
      );
    },

    /**
     * Records whether the agent is set to work, mirroring the schedule's enabled flag.
     *
     * Upserts, because an agent with nothing to configure has no setup document until the moment
     * somebody starts it — and "working" is then the only thing the document holds. For an agent
     * that does have a setup, the row already exists and this only flips the flag.
     */
    async setWorking({ workspaceId, agentSlug, working }) {
      const current = now();
      const filter = { workspaceId: toObjectId(workspaceId), agentSlug };
      return setups.findOneAndUpdate(
        filter,
        {
          $set: { working: Boolean(working), updatedAt: current },
          $setOnInsert: { ...filter, pages: [], lastRunAt: null, createdAt: current },
        },
        { upsert: true, returnDocument: "after" },
      );
    },

    /** Records when the agent last measured the pages, so the next due time can be reasoned about. */
    async recordRun({ workspaceId, agentSlug, at }) {
      await setups.updateOne(
        { workspaceId: toObjectId(workspaceId), agentSlug },
        { $set: { lastRunAt: at ?? now(), updatedAt: now() } },
      );
    },
  };
}
