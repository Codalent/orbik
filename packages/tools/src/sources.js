import { AGENT_COLLECTIONS } from "@orbik/core";
import { LIBRARY_SOURCE_KINDS, createCrawlSourceProvider } from "@orbik/library";

/**
 * The ledger behind "what has this agent already accounted for".
 *
 * One row per source per agent, holding the verdict and the content hash the verdict was reached
 * against. Recording the hash rather than a timestamp is the whole point: a crawl that re-fetches
 * an unchanged page must not make the next run believe the business changed, and a page edited
 * between two runs must not slip past because the runs are a week apart and the edit happened in
 * the middle.
 *
 * Written by the tools an agent calls while it works, so the ledger advances with the output
 * rather than in a separate bookkeeping step the agent could forget or a crash could skip: a
 * source cited by something written is reviewed by that act, and a source a run decided against is
 * reviewed when the run says so.
 *
 * The key is `(workspaceId, agentSlug, sourceKind, sourceKey)`. It used to be a site and a URL
 * hash, which quietly made "a page of the crawled site" the only thing an agent could ever have
 * an opinion about. Two things needed more than that: a verdict on a whole *route* — one decision
 * that stands for every blog post published after it, rather than a fresh verdict per post forever
 * — and, later, a verdict on a source with no URL at all.
 */

/**
 * Records a verdict on sources, at the content they have right now.
 *
 * @param {object} options
 * @param {import("mongodb").Db} options.database connected database
 * @param {object} options.scope the run's scope: workspaceId, siteId, agentSlug, runId
 * @param {ReadonlyArray<{kind: string, key: string, url?: string|null, title?: string|null, hash?: string|null}>} options.sources
 *   resolved source references
 * @param {boolean} options.relevant whether these belong in this agent's output
 * @param {string|null} [options.reason] why, in the agent's own words
 * @param {string|null} [options.by] who decided — an agent slug, or `user` for a person. Null when
 *   the agent named in the scope decided it itself, which is the ordinary case for a tool call.
 * @param {Date} [options.now] clock
 * @returns {Promise<{recorded: number}>}
 */
export async function reviewSources({ database, scope, sources, relevant, reason = null, by = null, now = new Date() }) {
  if (!sources.length) return { recorded: 0 };

  await database.collection(AGENT_COLLECTIONS.knowledgeSources).bulkWrite(
    sources.map((source) => ({
      updateOne: {
        filter: {
          workspaceId: scope.workspaceId,
          agentSlug: scope.agentSlug,
          sourceKind: source.kind,
          sourceKey: source.key,
        },
        update: {
          $set: {
            siteId: scope.siteId ?? null,
            // Kept beside the new key because a crawled page's key *is* the crawler's URL hash,
            // and the crawl listings still join on it.
            urlHash: source.kind === LIBRARY_SOURCE_KINDS.page ? source.key : null,
            url: source.url ?? null,
            title: source.title ?? null,
            relevant,
            reason,
            // Who reached this verdict, when it was not the agent whose ledger this is.
            //
            // A row keyed on an agent used to imply that agent decided it, and that stopped being
            // true when the source layer began writing page rows into the knowledge agent's ledger on
            // its behalf. Without this the job reads its own bookkeeping back as somebody's
            // judgement on the next pass and never reconsiders it — a rule change would leave
            // every page it had previously set aside set aside forever.
            reviewedBy: by,
            // The hash as it is at this moment. Anything written to the source after this call is
            // a change the next run will see, which is the correct answer: the agent reviewed what
            // it read, not what the page became afterwards.
            reviewedHash: source.hash ?? null,
            reviewedAt: now,
            reviewedByRunId: scope.runId ?? null,
          },
          $setOnInsert: {
            workspaceId: scope.workspaceId,
            agentSlug: scope.agentSlug,
            sourceKind: source.kind,
            sourceKey: source.key,
            createdAt: now,
          },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  return { recorded: sources.length };
}

/**
 * Records, on an agent's ledger, which sources code chose for it and which it left out.
 *
 * Narrower than {@link reviewSources} in the one way that matters: it never says a source was
 * *read*. A review stamps the content hash the verdict was reached against, and "chosen" is not a
 * reading — the page has been picked, and nothing has been written from it yet. So a row this
 * creates carries no hash, which is what lets a listing tell a page that is waiting to be written
 * from apart from one that was written from and has changed since.
 *
 * A row that already has a hash keeps it when `keepHash` says so: a page the agent has already
 * written from is still accounted for at that content, whoever restates that it belongs.
 *
 * @param {object} options
 * @param {import("mongodb").Db} options.database connected database
 * @param {object} options.scope `workspaceId`, `siteId`, and the `agentSlug` whose ledger this is
 * @param {ReadonlyArray<{key: string, url?: string|null, title?: string|null, relevant: boolean,
 *   reason: string, keepHash?: boolean}>} options.entries one per page
 * @param {string} options.by who decided: the name the rows are stamped with
 * @param {Date} [options.now] clock
 * @returns {Promise<{recorded: number}>}
 */
export async function recordSelection({ database, scope, entries, by, now = new Date() }) {
  if (!entries.length) return { recorded: 0 };

  await database.collection(AGENT_COLLECTIONS.knowledgeSources).bulkWrite(
    entries.map((entry) => ({
      updateOne: {
        filter: {
          workspaceId: scope.workspaceId,
          agentSlug: scope.agentSlug,
          sourceKind: LIBRARY_SOURCE_KINDS.page,
          sourceKey: entry.key,
        },
        update: {
          $set: {
            siteId: scope.siteId ?? null,
            urlHash: entry.key,
            url: entry.url ?? null,
            title: entry.title ?? null,
            relevant: entry.relevant,
            reason: entry.reason,
            reviewedBy: by,
            reviewedAt: now,
            ...(entry.keepHash ? {} : { reviewedHash: null, reviewedByRunId: null }),
          },
          $setOnInsert: {
            workspaceId: scope.workspaceId,
            agentSlug: scope.agentSlug,
            sourceKind: LIBRARY_SOURCE_KINDS.page,
            sourceKey: entry.key,
            createdAt: now,
            ...(entry.keepHash ? { reviewedHash: null, reviewedByRunId: null } : {}),
          },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  return { recorded: entries.length };
}

/** What `reviewedBy` says when the verdict was a person's rather than an agent's. */
const PERSON_REVIEWER = "user";

/**
 * Records a person's verdict on one source an agent's ledger already holds — today, that the
 * knowledge base should be written from a page that was left out of it.
 *
 * Deliberately narrower than {@link reviewSources}, because a person's verdict is not a review.
 * It sets what was decided, why, and that a person decided it, and leaves `reviewedHash` and
 * `reviewedByRunId` exactly as the last review left them. Stamping the hash the source has now
 * would claim it was read at that content, which is the one thing a person pulling a page back in
 * has not done: the write run still reads it, and writing from it is what records the hash. It never
 * creates a row either — a person disagrees with a verdict the ledger already holds, so a key it
 * does not hold is recorded as nothing.
 *
 * @param {object} options
 * @param {import("mongodb").Db} options.database connected database
 * @param {import("mongodb").ObjectId} options.workspaceId the workspace whose ledger this is
 * @param {string} options.agentSlug the agent whose ledger this is
 * @param {{kind: string, key: string}} options.source the source the verdict is about
 * @param {boolean} options.relevant whether it belongs in this agent's output
 * @param {string} options.reason why, in words the ledger shows back to the person
 * @param {Date} [options.now] clock
 * @returns {Promise<{recorded: number}>} 1 when the ledger held the row, 0 when it did not
 */
export async function recordPersonVerdict({ database, workspaceId, agentSlug, source, relevant, reason, now = new Date() }) {
  const result = await database.collection(AGENT_COLLECTIONS.knowledgeSources).updateOne(
    { workspaceId, agentSlug, sourceKind: source.kind, sourceKey: source.key },
    { $set: { relevant, reason, reviewedBy: PERSON_REVIEWER, reviewedAt: now } },
  );
  return { recorded: result.matchedCount };
}

/**
 * Records a verdict on pages named by URL, which is what the content tools have in hand.
 *
 * Resolving through the crawl provider rather than querying the Markdown collection directly is
 * what keeps "what counts as a source" in one place: the day a second provider exists, this
 * function does not learn about it, and neither do its callers.
 *
 * Unknown URLs are reported rather than ignored. An agent citing a page that does not exist is
 * either hallucinating or working from a stale list, and both are worth saying out loud.
 *
 * @param {object} options
 * @param {import("mongodb").Db} options.database connected database
 * @param {object} options.scope the run's scope
 * @param {readonly string[]} options.urls exact page URLs
 * @param {boolean} options.relevant whether these pages belong in this agent's output
 * @param {string|null} [options.reason] why, in the agent's own words
 * @returns {Promise<{reviewed: Array<{url: string|null, key: string}>, unknown: string[]}>}
 */
export async function reviewSourceUrls({ database, scope, urls, relevant, reason = null }) {
  if (!urls.length) return { reviewed: [], unknown: [] };
  const provider = createCrawlSourceProvider(database);
  const { resolved, unknown } = await provider.resolve(scope, urls);
  if (resolved.length) {
    await reviewSources({ database, scope, sources: resolved, relevant, reason });
  }
  return { reviewed: resolved.map((source) => ({ url: source.url, key: source.key })), unknown };
}

/**
 * Records a verdict on whole route patterns.
 *
 * A route is a shape of page — `/blog/[slug]` — and a verdict on it is the one thing that makes
 * selection scale past a few dozen pages. Excluding this week's posts one URL at a time does
 * nothing about next week's; excluding the route decides the question once, and every post
 * published afterwards arrives already accounted for.
 *
 * Routes carry no content hash: a route pattern has no content, and a verdict about a shape of
 * page is not something a page's edit should reopen.
 *
 * @param {object} options
 * @param {import("mongodb").Db} options.database connected database
 * @param {object} options.scope the run's scope
 * @param {readonly string[]} options.routes route patterns as the crawler wrote them
 * @param {boolean} options.relevant whether pages of this shape belong in this agent's output
 * @param {string|null} [options.reason] why, in the agent's own words
 */
export async function reviewRoutes({ database, scope, routes, relevant, reason = null }) {
  if (!routes.length) return { reviewed: [], unknown: [] };

  // Grouped rather than `distinct`, which is not part of MongoDB's Stable API v1 — the API every
  // Orbik process connects under. A `distinct` here failed at runtime with APIStrictError on the
  // first real run that excluded a route, which is exactly the kind of thing a strict API is for.
  const rows = await database
    .collection(AGENT_COLLECTIONS.urls)
    .aggregate([
      { $match: { siteId: scope.siteId, routePattern: { $in: [...routes] } } },
      { $group: { _id: "$routePattern" } },
    ])
    .toArray();
  const known = rows.map((row) => row._id);
  const unknown = routes.filter((route) => !known.includes(route));

  if (known.length) {
    await reviewSources({
      database,
      scope,
      sources: known.map((route) => ({
        kind: LIBRARY_SOURCE_KINDS.route,
        key: route,
        url: null,
        title: route,
        hash: null,
      })),
      relevant,
      reason,
    });
  }
  return { reviewed: known, unknown };
}

/**
 * The route patterns this agent has excluded, as a set.
 *
 * Read on every content listing, which is why it is one small query rather than a lookup per page.
 */
export async function excludedRoutes({ database, scope }) {
  const rows = await database
    .collection(AGENT_COLLECTIONS.knowledgeSources)
    .find({
      workspaceId: scope.workspaceId,
      agentSlug: scope.agentSlug,
      sourceKind: LIBRARY_SOURCE_KINDS.route,
      relevant: false,
    })
    .project({ sourceKey: 1 })
    .toArray();
  return rows.map((row) => row.sourceKey);
}
