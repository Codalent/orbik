import { AppError } from "../errors/appError.js";
import { createWorkspaceAccessCheck, hasRole } from "./workspaceAccess.js";

/**
 * The steps of a workspace's setup, in the order the Home page lists them.
 *
 * Four essentials, which decide where the workspace opens, and two recommended steps a person
 * may skip. Each names the lowest role that can do it — the same minimum the route behind its
 * action checks — so a step somebody cannot do is drawn as somebody else's rather than as theirs
 * and unfinished, and is not counted against them.
 *
 * "Library written" is done by Orbik, not by anybody; it is counted for the people who can set
 * the first two steps going (member and up), because for them it is the rest of their setup, and
 * for a read-only person it is something to watch rather than to do.
 */
export const HOME_STEPS = Object.freeze([
  { id: "website", group: "essential", requires: "member" },
  { id: "structure", group: "essential", requires: "member", waitsFor: "website" },
  { id: "library", group: "essential", requires: "member", waitsFor: "structure" },
  { id: "ai", group: "essential", requires: "read-only" },
  { id: "brand", group: "recommended", requires: "member" },
  { id: "team", group: "recommended", requires: "admin" },
]);

/** The recommended steps: the only ones a person can skip. */
export const SKIPPABLE_STEPS = Object.freeze(HOME_STEPS.filter((step) => step.group === "recommended").map((step) => step.id));

/** What a step can be, as the page draws it. */
export const STEP_STATES = Object.freeze({
  notStarted: "not_started",
  inProgress: "in_progress",
  done: "done",
  attention: "attention",
  notPermitted: "not_permitted",
  skipped: "skipped",
});

/** The agents whose work is somebody's question rather than the workspace's, left out of Home. */
const PRIVATE_AGENTS = new Set(["library-chat", "library-chat-read", "brand-chat", "brand-chat-read"]);

/** The Design system agent, whose run is what "Deriving…" on the brand step means. */
const DESIGN_SYSTEM_AGENT_SLUG = "design-system";

/** How many rows each glance list carries. */
const GLANCE_ROWS = 5;

/**
 * The Home page: where a workspace's setup stands, for the person looking, and the workspace at a
 * glance.
 *
 * A composition, not a new source of truth. Every step's state is read from what the workspace
 * already records — the crawl's runs, the structure on the knowledge agent's setup, the Library's
 * runs and overview, the person's own tokens and approved apps, the design system, the members and
 * invites — so a step done anywhere else (on Settings, by another member, by
 * an outside AI) is done here without anything having to remember to tick it. Nothing on this read
 * writes; the only thing Home stores is a person's skips and whether they hid the checklist.
 *
 * Each composed read goes through the service that owns it where one exists, so it is held to the
 * same access rule as the page it comes from; a few figures that no service exposes cheaply enough
 * to poll — the first crawl that finished, each agent's newest run — are read
 * from the repositories those services are built on.
 *
 * "Connect your AI" is the one step that is per person: it is done when *this* person has a token
 * or an approved app that covers the workspace and has been used. Nobody sees anybody else's
 * connections here, by the owner's decision (2026-10-29).
 *
 * @param {object} dependencies
 * @param {object} dependencies.workspaceRepository workspace access by owner or membership
 * @param {object} dependencies.crawlService the crawl page's overview
 * @param {object} dependencies.crawlRepository for the first crawl that finished
 * @param {object} dependencies.libraryService the Library's setup state
 * @param {object} dependencies.mcpTokenService the person's own tokens
 * @param {object} dependencies.oauthService the person's own approved apps
 * @param {object} dependencies.memberRepository the workspace's members
 * @param {object} dependencies.inviteRepository the workspace's pending invites
 * @param {object} dependencies.brandRepository the design system
 * @param {object} dependencies.runRepository agent runs
 * @param {object} dependencies.userRepository to name who did what
 * @param {object} dependencies.homePreferenceRepository skips and the hidden checklist
 */
export function createHomeService({
  workspaceRepository,
  crawlService,
  crawlRepository,
  libraryService,
  mcpTokenService,
  oauthService,
  memberRepository,
  inviteRepository,
  brandRepository,
  runRepository,
  userRepository,
  homePreferenceRepository,
}) {
  const requireWorkspaceAccess = createWorkspaceAccessCheck(workspaceRepository);

  /** The people a set of account identifiers names, by identifier. */
  async function peopleNamed(ids) {
    const users = await userRepository.listEmailsByIds(ids.filter(Boolean));
    return new Map(users.map((user) => [user._id.toHexString(), { userId: user._id.toHexString(), email: user.email }]));
  }

  return {
    /**
     * Everything the Home page draws, in one read.
     *
     * @param {{userId: import("mongodb").ObjectId, workspaceId: string}} query
     */
    async getHome({ userId, workspaceId }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      const id = workspace._id;
      const caller = { userId, workspaceId };

      const [crawl, library, tokens, grants, members, invites, brand, brandRun, latestRuns, recentRuns, preferences] = await Promise.all([
        crawlService.getOverview(caller),
        libraryService.getSetupState(caller),
        mcpTokenService.listTokens(caller),
        oauthService.listGrants(caller),
        memberRepository.listForWorkspace(id, workspace.ownerId),
        inviteRepository.listPending(id),
        brandRepository.findSystem(id),
        runRepository.findLatest({ workspaceId: id, agentSlug: DESIGN_SYSTEM_AGENT_SLUG }),
        runRepository.latestPerAgent(id),
        runRepository.list({ workspaceId: id, limit: 20 }),
        homePreferenceRepository.find(userId, id),
      ]);
      const firstCrawl = crawl.site ? await crawlRepository.findFirstSucceededRun(crawl.site.id) : null;

      // Only the credentials that still work: a revoked token or a disconnected app no longer
      // connects anything, whatever it once did.
      const credentials = [
        ...tokens.items.filter((token) => token.status === "active").map((token) => ({ id: token.id, kind: "token", name: token.name, lastUsedAt: token.lastUsedAt, createdAt: token.createdAt })),
        ...grants.items.filter((grant) => grant.status === "active").map((grant) => ({ id: grant.id, kind: "app", name: grant.clientName, lastUsedAt: grant.lastUsedAt, createdAt: grant.createdAt })),
      ].sort((left, right) => String(right.lastUsedAt ?? "").localeCompare(String(left.lastUsedAt ?? "")));

      const activity = recentRuns
        .filter((run) => !PRIVATE_AGENTS.has(run.agentSlug))
        .slice(0, GLANCE_ROWS);
      const firstMember = members[0] ?? null;
      // The oldest pending invite: `listPending` is newest first.
      const firstInvite = invites.at(-1) ?? null;
      const people = await peopleNamed([
        firstCrawl?.startedBy,
        library.structure.chosenBy,
        firstMember?.invitedBy,
        firstInvite?.invitedBy,
        ...activity.map((run) => run.startedBy),
      ]);
      const personOf = (value) => (value ? people.get(String(value)) ?? null : null);

      const facts = {
        website: websiteFacts(crawl, firstCrawl, personOf),
        structure: structureFacts(library, personOf),
        library: libraryFacts(library),
        ai: aiFacts(credentials),
        brand: brandFacts(brand, brandRun),
        team: teamFacts(members, invites, firstMember, firstInvite, personOf),
      };
      const steps = HOME_STEPS.map((step) => resolveStep(step, facts, workspace.role, preferences));

      const counted = (group) => steps.filter((step) => step.group === group && step.permitted);
      const essentials = counted("essential");
      const recommended = counted("recommended");
      const wanting = attentionRows(latestRuns);

      return {
        workspace: { id: id.toHexString(), name: workspace.name, websiteUrl: workspace.websiteUrl ?? null, role: workspace.role },
        // Where this workspace opens for this person: Home while any essential they can do is
        // unfinished, the Library once none is. A skip or a hidden checklist changes nothing here.
        landing: essentials.some((step) => step.state !== STEP_STATES.done) ? "home" : "library",
        progress: {
          essentials: { done: essentials.filter((step) => step.state === STEP_STATES.done).length, total: essentials.length },
          recommended: {
            done: recommended.filter((step) => step.state === STEP_STATES.done).length,
            total: recommended.length,
            left: recommended.filter((step) => step.state !== STEP_STATES.done && step.state !== STEP_STATES.skipped).length,
          },
        },
        // Whether anything is moving, which is how often the page reads this again.
        live: steps.some((step) => step.state === STEP_STATES.inProgress),
        preferences: { hidden: preferences.hidden, skipped: preferences.skipped.filter((step) => SKIPPABLE_STEPS.includes(step)) },
        steps,
        glance: {
          library: {
            files: library.stats.files,
            folders: library.stats.folders,
            sources: library.stats.sources,
            updatedAt: library.stats.updatedAt,
            overview: library.overview,
            writing: Boolean(library.activeRun) || library.copying,
          },
          website: {
            seedUrl: crawl.site?.seedUrl ?? crawl.defaults?.seedUrl ?? null,
            configured: Boolean(crawl.site),
            pages: crawl.urls?.pages ?? crawl.urls?.total ?? 0,
            crawling: Boolean(crawl.activeRun) || Boolean(crawl.queued),
            lastCrawl: crawl.latestRun
              ? { status: crawl.latestRun.status, startedAt: crawl.latestRun.startedAt, finishedAt: crawl.latestRun.finishedAt, error: crawl.latestRun.error }
              : null,
            nextCrawlAt: crawl.site?.nextCrawlAt ?? null,
            budget: crawl.budget,
          },
          // This person's connections only.
          ai: { credentials },
          attention: wanting.slice(0, GLANCE_ROWS),
          // Over every agent, not only the rows above, so Home's headline figure is the whole count.
          attentionTotals: attentionTotals(wanting),
          activity: activity.map((run) => ({
            id: run._id.toHexString(),
            agentSlug: run.agentSlug,
            status: run.status,
            trigger: run.trigger ?? null,
            startedAt: run.startedAt ? run.startedAt.toISOString() : null,
            finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
            startedBy: personOf(run.startedBy),
          })),
        },
      };
    },

    /**
     * Saves one change to the person's Home page: skip or bring back recommended steps, hide or
     * show the checklist. Anybody who can open the workspace may, read-only included — it is their
     * own view of it, and changes nothing anybody else sees.
     */
    async updatePreferences({ userId, workspaceId, skip = [], unskip = [], hidden }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      const unknown = [...skip, ...unskip].find((step) => !SKIPPABLE_STEPS.includes(step));
      if (unknown) {
        throw new AppError({ status: 400, code: "STEP_NOT_SKIPPABLE", message: "Only a recommended step can be skipped." });
      }
      const saved = await homePreferenceRepository.update(userId, workspace._id, { skip, unskip, hidden });
      return { preferences: { hidden: saved.hidden, skipped: saved.skipped.filter((step) => SKIPPABLE_STEPS.includes(step)) } };
    },
  };
}

/**
 * Turns a step's facts into what the page draws, for this person.
 *
 * Done and in progress are said to everybody, because they are facts about the workspace; a step
 * not done that the person's role cannot do is "not for you", whatever else is true of it, since
 * a retry they cannot press is no use to them. A recommended step the person skipped is skipped
 * until it is done, which it can still become, by somebody else.
 */
function resolveStep(step, facts, role, preferences) {
  const fact = facts[step.id];
  const permitted = hasRole(role, step.requires);
  let state = fact.state;
  if (state !== STEP_STATES.done && step.group === "recommended" && preferences.skipped.includes(step.id)) {
    state = STEP_STATES.skipped;
  } else if (!permitted && state !== STEP_STATES.done && state !== STEP_STATES.inProgress) {
    state = STEP_STATES.notPermitted;
  }
  return {
    id: step.id,
    group: step.group,
    requires: step.requires,
    permitted,
    state,
    // The step before this one, while it is not done: "Waits for the first crawl".
    waitsFor: step.waitsFor && facts[step.waitsFor].state !== STEP_STATES.done ? step.waitsFor : null,
    doneAt: fact.state === STEP_STATES.done ? fact.doneAt ?? null : null,
    doneBy: fact.state === STEP_STATES.done ? fact.doneBy ?? null : null,
    detail: fact.detail ?? {},
  };
}

/**
 * Connect your website: done once a crawl of the site has finished — the first one, whatever the
 * newest did since. Until then: crawling with live counts, failed with the reason, or not set up.
 */
function websiteFacts(crawl, firstCrawl, personOf) {
  const seedUrl = crawl.site?.seedUrl ?? crawl.defaults?.seedUrl ?? null;
  const run = crawl.activeRun;
  const detail = {
    seedUrl,
    host: hostOf(seedUrl),
    configured: Boolean(crawl.site),
    queued: Boolean(crawl.queued),
    budget: crawl.budget
      ? { unlimited: crawl.budget.unlimited, allowance: crawl.budget.allowance, remaining: crawl.budget.remaining, resetsAt: crawl.budget.resetsAt }
      : null,
    // The same two figures the activity monitor shows for a crawl: URLs found, pages fetched.
    discovered: run?.counters?.urlsDiscovered ?? 0,
    fetched: run ? (run.counters?.pagesFetched ?? 0) + (run.counters?.pagesNotModified ?? 0) : 0,
    error: null,
  };
  if (firstCrawl) {
    return {
      state: STEP_STATES.done,
      doneAt: iso(firstCrawl.finishedAt ?? firstCrawl.startedAt),
      doneBy: personOf(firstCrawl.startedBy),
      detail,
    };
  }
  if (run || crawl.queued) return { state: STEP_STATES.inProgress, detail };
  if (crawl.latestRun?.status === "failed") {
    return { state: STEP_STATES.attention, detail: { ...detail, error: crawl.latestRun.error } };
  }
  return { state: STEP_STATES.notStarted, detail };
}

/**
 * Choose how your Library is organised: done once a structure was chosen. A rebuild asked for
 * since does not undo it — setup was finished, and the Library page handles the rebuild.
 */
function structureFacts(library, personOf) {
  const { structure } = library;
  const detail = { suggestion: structure.suggestion };
  if (structure.chosen) {
    return { state: STEP_STATES.done, doneAt: structure.chosenAt, doneBy: personOf(structure.chosenBy), detail };
  }
  if (structure.suggestion === "pending") return { state: STEP_STATES.inProgress, detail };
  return { state: STEP_STATES.notStarted, detail };
}

/**
 * Library written: done once a write run has finished and the overview exists. Orbik does this
 * itself, so nobody is named.
 */
function libraryFacts(library) {
  const detail = {
    working: library.working,
    filesWritten: library.activeRun?.filesWritten ?? 0,
    copying: library.copying,
    files: library.stats.files,
    error: null,
  };
  if (library.firstWrite && library.overview) {
    return { state: STEP_STATES.done, doneAt: library.firstWrite.finishedAt, doneBy: null, detail };
  }
  if (library.activeRun || library.copying) return { state: STEP_STATES.inProgress, detail };
  if (library.latestRun?.status === "failed") return { state: STEP_STATES.attention, detail: { ...detail, error: library.latestRun.error } };
  return { state: STEP_STATES.notStarted, detail };
}

/**
 * Connect your AI: done once one of this person's working credentials for the workspace has been
 * used. One that exists but has never called is "waiting for the first call" — a token pasted
 * wrongly is the common failure, and calling it connected would hide it.
 */
function aiFacts(credentials) {
  const used = credentials.filter((credential) => credential.lastUsedAt);
  const detail = { credentials: credentials.length, used: used.length };
  if (used.length) {
    // `lastUsedAt` is overwritten on every call, so the newest one is "last called", not "first".
    return { state: STEP_STATES.done, doneAt: used[0].lastUsedAt, doneBy: null, detail: { ...detail, lastUsedAt: used[0].lastUsedAt, client: used[0].name } };
  }
  if (credentials.length) return { state: STEP_STATES.inProgress, detail };
  return { state: STEP_STATES.notStarted, detail };
}

/** Review your brand: done once a design system has been derived; deriving while its agent runs. */
function brandFacts(document, latestRun) {
  const running = latestRun && ["queued", "running"].includes(latestRun.status);
  if (document?.system) {
    return { state: STEP_STATES.done, doneAt: iso(document.derivedAt ?? document.createdAt), doneBy: null, detail: { revision: document.revision ?? 0 } };
  }
  if (running) return { state: STEP_STATES.inProgress, detail: {} };
  if (latestRun?.status === "failed") return { state: STEP_STATES.attention, detail: { error: latestRun.error ? { code: latestRun.error.code, message: latestRun.error.message } : null } };
  return { state: STEP_STATES.notStarted, detail: {} };
}

/**
 * Invite your team: done once the workspace has somebody besides its owner, or a pending invite
 * for somebody. Counted from the rows, whoever is looking: the invites themselves are listed only
 * to an admin, on Settings.
 */
function teamFacts(members, invites, firstMember, firstInvite, personOf) {
  const detail = { members: members.length, invites: invites.length };
  if (firstMember || firstInvite) {
    const first = firstMember && (!firstInvite || firstMember.createdAt <= firstInvite.createdAt) ? firstMember : firstInvite;
    return { state: STEP_STATES.done, doneAt: iso(first.createdAt), doneBy: personOf(first.invitedBy), detail };
  }
  return { state: STEP_STATES.notStarted, detail };
}

/**
 * The agents that want somebody's attention: their newest run failed. All of them, newest failure
 * first, for the caller to cut to the top few.
 */
function attentionRows(latestRuns) {
  return latestRuns
    .filter((row) => row.agentSlug && !PRIVATE_AGENTS.has(row.agentSlug) && row.status === "failed")
    .map((row) => ({ agentSlug: row.agentSlug, failedRun: { finishedAt: iso(row.finishedAt), error: row.error } }))
    .sort((left, right) => String(right.failedRun.finishedAt ?? "").localeCompare(String(left.failedRun.finishedAt ?? "")));
}

/**
 * How many agents want attention, and how many of them failed: the same count, now that a failed
 * run is the only reason one does. Both are kept so the page reads one shape.
 */
function attentionTotals(rows) {
  return {
    agents: rows.length,
    failed: rows.length,
  };
}

/** A moment as ISO text, or null. */
function iso(value) {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** The hostname of an address, or null. */
function hostOf(url) {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}
