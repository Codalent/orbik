import { findAgentDefinition } from "@orbik/agent-definitions";
import { AGENT_COLLECTIONS, COLLECTIONS, KNOWLEDGE_AGENT_SLUG, log } from "@orbik/core";
import { LIBRARY_NODE_KINDS, SOURCE_LAYER_WRITER_SLUG, SOURCE_ROOT_PATH, libraryStructureState } from "@orbik/library";
import { RUN_STATUS } from "@orbik/protocol";

import { AI_AGENT, CRAWLER_AGENT, LIBRARY_AGENT, LIBRARY_JOBS, libraryJob } from "../jobs.js";
import { createLoop } from "../runtime/loop.js";
import { JOB_STATUS } from "../runtime/queue.js";

/** How many workspaces one pass may consider, so a backlog cannot flood the queue at once. */
const MAX_WORKSPACES_PER_PASS = 50;

/** Job states in which work is still owed. */
const IN_FLIGHT = [JOB_STATUS.pending, JOB_STATUS.running];

/**
 * How long a structure suggestion may stay `pending` before it is asked for again.
 *
 * The job is one model call; one still pending after this was lost with its worker, and the person
 * waiting on the Library page would otherwise wait for good.
 */
const SUGGESTION_STALE_MS = 30 * 60 * 1000;

/**
 * Creates the loop that keeps every workspace's Library agent moving.
 *
 * The Library agent is three stages — copy each page into the source layer, embed what changed,
 * rewrite the Library from the pages chosen for it — and nobody starts any of them by hand. The
 * crawler starts the first two when it finishes a crawl. This loop is the rest: it notices the
 * reasons to work that no crawl produced, and it starts the third stage when the first has settled.
 *
 * It is one of the short periodic passes this process runs, and it is one for the same reason the
 * others are: **the API never enqueues**. A person saving a Library file or asking for a page by
 * name must not depend on the queue being reachable for the request to be accepted — so the write
 * happens, and this notices.
 *
 * What it notices with is deliberately the cheap question rather than the exact one. "Has anything
 * in this workspace been written since the last time anything was indexed" is two indexed maxima;
 * "which sources are stale" is a hash comparison over every document, and it is the *job's* work,
 * not the scheduler's. The consequence is that this can be wrong in one direction only: it can
 * queue a pass that turns out to have nothing to do, which costs a handful of queries and neither
 * an embedding nor a model call. It cannot miss a change, because every write moves `updatedAt`.
 *
 * The stages keep their own pace inside the one loop. Embedding is considered every
 * `indexIntervalMs` and the other two every `sourceIntervalMs`. Only the third stage costs a
 * model call, and what bounds that is not the interval but what starts it: a page the knowledge
 * base is written from has to have moved.
 *
 * @param {object} options collaborators
 * @param {import("mongodb").Db} options.database connected database
 * @param {ReturnType<import("../runtime/queue.js").createJobQueue>} options.queue job queue
 * @param {ReturnType<import("../runtime/runLedger.js").createRunLedger>} options.ledger run ledger
 * @param {object} options.config validated agent environment
 * @param {(level: string, message: string, context?: object) => void} [options.logger]
 * @param {() => Date} [options.now] clock; defaults to the system clock
 */
export function createLibraryScheduler({ database, queue, ledger, config, logger = log, now = () => new Date() }) {
  const workspaces = database.collection(COLLECTIONS.workspaces);
  const sites = database.collection(AGENT_COLLECTIONS.sites);
  const markdown = database.collection(AGENT_COLLECTIONS.markdown);
  const nodes = database.collection(AGENT_COLLECTIONS.libraryNodes);
  const indexState = database.collection(AGENT_COLLECTIONS.indexState);
  const sourceState = database.collection(AGENT_COLLECTIONS.sourceNotes);
  const jobs = database.collection(AGENT_COLLECTIONS.jobs);
  const runs = database.collection(AGENT_COLLECTIONS.runs);
  const schedules = database.collection(AGENT_COLLECTIONS.schedules);
  const agentSetups = database.collection(AGENT_COLLECTIONS.agentSetups);

  // Each stage is due on its own interval, and the loop sleeps until the sooner of the two. Both
  // are due on the first pass after every start.
  let due = null;
  // One bad workspace must not stop the loop: the next pass reconsiders every one, so a failure
  // delays that workspace's Library rather than every workspace's.
  const loop = createLoop({
    name: "library_scheduler",
    startedContext: {
      embedIntervalMs: config.indexIntervalMs,
      sourceIntervalMs: config.sourceIntervalMs,
      embedEnabled: config.retrievalEnabled,
      synthesisEnabled: config.synthesisEnabled,
    },
    tick: () => {
      const at = Date.now();
      due ??= { embed: 0, sources: 0 };
      const stages = { embed: at >= due.embed, sources: at >= due.sources };
      if (stages.embed) due.embed = at + config.indexIntervalMs;
      if (stages.sources) due.sources = at + config.sourceIntervalMs;
      return scheduler.tick(stages);
    },
    intervalMs: () => Math.max(1, Math.min(due.embed, due.sources) - Date.now()),
    logger,
  });

  /** The newest value of one date field among the rows a filter matches, or null. */
  async function latest(collection, filter, field) {
    const row = await collection.find(filter).project({ [field]: 1 }).sort({ [field]: -1 }).limit(1).next();
    return row?.[field] ?? null;
  }

  /** The most recent moment any of this site's pages was rendered. */
  function latestPageChange(siteId) {
    return siteId ? latest(markdown, { siteId }, "updatedAt") : null;
  }

  // ----------------------------------------------------------------------------------------------
  // Stage two: embed. Considered first because it waits on nothing.

  /**
   * Whether the index is behind this workspace's documents, and why.
   *
   * A failure is a reason to queue again on its own. The rows a failed pass touched kept the hash
   * they had, so the work is still outstanding — and without this a workspace whose Qdrant was
   * down for a minute would stay unindexed until somebody happened to edit a page.
   *
   * The one case this does not catch is a *deletion* with no accompanying write — a page the
   * crawler stopped rendering, and nothing else touched. Those are swept by the next pass that
   * runs for any other reason, and by the pass the crawler queues when it finishes. Queuing a
   * workspace every minute to look for deletions that almost never happen would be the wrong
   * trade.
   */
  async function embedPosition(workspaceId, siteId) {
    const [page, file, indexedAt, failed] = await Promise.all([
      latestPageChange(siteId),
      // The source layer's copy of a page that is still on the site is not indexed — the page
      // is — so its being written is not a reason to index. Counting it would make the question
      // true for good after every mirror pass: nothing the index does ever catches up with a
      // file it leaves out. What a person wrote in a copy, and a copy whose page has gone, are
      // indexed, so those still count.
      latest(
        nodes,
        {
          workspaceId,
          kind: LIBRARY_NODE_KINDS.file,
          $or: [
            { path: { $not: new RegExp(`^${SOURCE_ROOT_PATH}(/|$)`) } },
            { "authors.agent": { $ne: SOURCE_LAYER_WRITER_SLUG } },
            { removed: true },
            { hasUserContent: true },
          ],
        },
        "updatedAt",
      ),
      latest(indexState, { workspaceId }, "indexedAt"),
      indexState.countDocuments({ workspaceId, error: { $exists: true } }, { limit: 1 }),
    ]);
    const changedAt = newest(page, file);
    return {
      changedAt,
      indexedAt,
      failed: failed > 0,
      stale: failed > 0 || Boolean(changedAt && (!indexedAt || changedAt > indexedAt)),
    };
  }

  // ----------------------------------------------------------------------------------------------
  // Stage one: mirror.

  /**
   * What the source layer knows: when it last changed, and whether anything is outstanding.
   *
   * Three separate reasons to queue, and each one is a reason on its own. A **failure** left a page
   * at the hash it had, so the work is still there and nothing else will notice it. An **include**
   * is a person asking for a page by name and expecting it shortly, not after the next crawl. And
   * a workspace whose pages were rendered after anything last looked at them has pages waiting —
   * which is also how a source layer that still holds notes from before pages were copied is
   * found: nothing has been copied, so everything is newer than the last copy.
   *
   * A page that was rendered since the last copy is only a reason once. Some pages that change
   * are ones that are not stored — a duplicate — and a pass that reads one of those copies
   * nothing, so `mirroredAt` never catches up with it and the comparison would stay true for
   * good: a pass every minute, each finding nothing. So the pages are compared with the later of
   * the last copy and the last pass that looked. The job history is where that second moment
   * already is; a history too short to hold it costs one pass that finds nothing, which is the
   * direction this is allowed to be wrong in.
   *
   * `movedAt` is the answer the third stage wants from the same rows: the last time a page the
   * knowledge base is written from was copied afresh, was chosen, or went away. The other pages
   * of the site are deliberately not part of it. A blog that publishes daily changes the source
   * layer daily, and the knowledge base is not rewritten for a post it was never written from.
   */
  async function sourcePosition(workspaceId, siteId) {
    const [changedAt, writtenAt, mirroredAt, movedAt, failed, requested, sweptAt] = await Promise.all([
      latestPageChange(siteId),
      // The knowledge base's own files. Which pages they cite is part of the choice — a page
      // some file cites stays chosen — so a file written since the last pass is a reason to look
      // again. It is how a page a run reached through search, and cited, is on the ledger as
      // chosen a minute later rather than at the next crawl.
      latest(nodes, { workspaceId, kind: LIBRARY_NODE_KINDS.file, path: { $not: new RegExp(`^${SOURCE_ROOT_PATH}(/|$)`) } }, "updatedAt"),
      latest(sourceState, { workspaceId, mirroredAt: { $exists: true } }, "mirroredAt"),
      latest(sourceState, { workspaceId, movedAt: { $exists: true } }, "movedAt"),
      sourceState.countDocuments({ workspaceId, error: { $exists: true } }, { limit: 1 }),
      // Asked for and not yet chosen. The pass that honours it marks the page chosen; one that
      // cannot — the page is a duplicate — withdraws the request, so neither stays outstanding.
      sourceState.countDocuments({ workspaceId, include: true, chosen: { $ne: true } }, { limit: 1 }),
      latest(
        jobs,
        { agent: LIBRARY_AGENT, status: JOB_STATUS.succeeded, type: LIBRARY_JOBS.mirror, workspaceId },
        "createdAt",
      ),
    ]);
    const readThrough = newest(mirroredAt, sweptAt);
    const behind = (moment) => Boolean(moment && (!readThrough || moment > readThrough));
    return {
      changedAt,
      mirroredAt,
      sweptAt,
      movedAt,
      failed: failed > 0,
      requested: requested > 0,
      // A file written with nothing mirrored yet is not a reason: there is no choice to revisit.
      stale: failed > 0 || requested > 0 || behind(changedAt) || Boolean(readThrough && behind(writtenAt)),
    };
  }

  // ----------------------------------------------------------------------------------------------
  // Stage three: write.

  /**
   * Whether work that the source layer depends on is still going on for this workspace.
   *
   * Two things have to be quiet before the Library is rewritten: the crawl, which is still
   * changing the pages, and the mirror, which is still copying them. Both are asked of the queue
   * rather than of a run's status, because a job that is lost gets its lease reclaimed and a run
   * row that is stuck does not — and a stage that waited on a stuck row would wait forever.
   *
   * A crawl hands over to the mirror before its last job completes, and a mirror pass queues its
   * continuation the same way, so from the first fetch to the last copy there is no moment at
   * which neither is in flight.
   */
  async function upstreamBusy(workspaceId, siteId) {
    const [mirroring, crawling] = await Promise.all([
      jobs.countDocuments(
        { agent: LIBRARY_AGENT, status: { $in: IN_FLIGHT }, type: LIBRARY_JOBS.mirror, workspaceId },
        { limit: 1 },
      ),
      siteId
        ? jobs.countDocuments({ agent: CRAWLER_AGENT, status: { $in: IN_FLIGHT }, siteId }, { limit: 1 })
        : 0,
    ]);
    if (crawling) return "CRAWL_IN_FLIGHT";
    if (mirroring) return "MIRROR_IN_FLIGHT";
    return null;
  }

  /**
   * Makes sure there are structures for a person to choose from, while the Library waits on one.
   *
   * The first write run — and a rebuild's — files into top-level folders the person chose, so it
   * cannot start until they have. What they choose from is two or three variants a model proposes
   * from the site (`structure.suggest`); this queues that question once, when the site is copied
   * and nothing is pending, and again only when the step was reopened since the last answer, a
   * pending one was lost, or a failed one has a changed site to try on.
   */
  async function considerSuggestion({ workspaceId, siteId, state, position }) {
    const suggestion = state.suggestion;
    const askedAt = suggestion?.generatedAt ?? suggestion?.queuedAt ?? null;
    const current = now();
    const due = !suggestion
      || (state.openedAt && (!askedAt || new Date(askedAt) < state.openedAt))
      || (suggestion.status === "pending" && (!suggestion.queuedAt || current - new Date(suggestion.queuedAt) > SUGGESTION_STALE_MS))
      || (["failed", "skipped"].includes(suggestion.status) && position.movedAt && askedAt && position.movedAt > new Date(askedAt));
    if (!due) return false;
    await agentSetups.updateOne(
      { workspaceId, agentSlug: KNOWLEDGE_AGENT_SLUG },
      {
        $set: { "structure.suggestion": { status: "pending", queuedAt: current, variants: [] }, updatedAt: current },
        $setOnInsert: { createdAt: current },
      },
      { upsert: true },
    );
    await queue.enqueue({
      ...libraryJob(LIBRARY_JOBS.suggest, { workspaceId, siteId, idempotencyKey: `structure:${workspaceId.toHexString()}:${current.getTime()}` }),
      maxAttempts: config.maxAttempts,
    });
    logger("info", "library_scheduler.structure_queued", { workspaceId: workspaceId.toHexString(), reason: state.reason });
    return true;
  }

  /**
   * Decides whether the Library should be rewritten now, and starts the run when it should.
   *
   * A run is due when the pages the knowledge base is written from say something the last run did
   * not see: one of them was copied afresh, was newly chosen or went away after that run started,
   * or there has never been a run. The comparison is against the newest run whatever became of
   * it, so a run that failed is not started again every few minutes — it is tried again when the
   * site next changes, or when somebody switches the agent off and on, which is the one thing a
   * person can do about a failure and so is what `workingSince` records.
   *
   * The switch is the schedule row's `enabled`, and only that: this agent has no due time. A
   * workspace that never set the agent to work still gets its source layer and its index, and
   * gets no runs. So does a deployment with no model key: a run there could only fail, so none is
   * started and the reason is the one this returns.
   *
   * The claim is a write on the schedule row for the same reason every other scheduler here
   * claims atomically — two of these processes must not both start the run. What is claimed is
   * the moment that justified it, so a second process finds that moment already taken.
   *
   * @returns {Promise<{runId?: object, reason?: string}>} the run it started, or why it did not
   */
  async function considerWrite({ workspaceId, siteId, position }) {
    const schedule = await schedules.findOne({ workspaceId, agentSlug: KNOWLEDGE_AGENT_SLUG });
    if (!schedule?.enabled) return { reason: "NOT_WORKING" };
    if (!config.synthesisEnabled) return { reason: "PROVIDER_NOT_CONFIGURED" };
    if (!position.movedAt) return { reason: "NOTHING_CHOSEN" };
    // A page somebody asked for by name is about to be chosen. Writing now would be writing
    // without it, and then writing again a minute later with it.
    if (position.requested) return { reason: "PAGE_REQUESTED" };

    const busy = await upstreamBusy(workspaceId, siteId);
    if (busy) return { reason: busy };

    // The top level is the person's. Until they have chosen it — or chosen it again, after asking
    // for a rebuild — there is nothing to file into, and a run would cost money writing into a
    // shape nobody agreed to. The Library page shows the choice; this waits for it.
    const structure = libraryStructureState(
      await agentSetups.findOne({ workspaceId, agentSlug: KNOWLEDGE_AGENT_SLUG }, { projection: { structure: 1 } }),
    );
    if (structure.needsChoice) {
      await considerSuggestion({ workspaceId, siteId, state: structure, position });
      return { reason: "STRUCTURE_NOT_CHOSEN" };
    }

    const [last] = await runs
      .find({ workspaceId, agentSlug: KNOWLEDGE_AGENT_SLUG })
      .project({ status: 1, startedAt: 1 })
      .sort({ startedAt: -1 })
      .limit(1)
      .toArray();
    if (last && !isTerminal(last.status)) return { reason: "ALREADY_RUNNING" };

    const moved = !last || position.movedAt > last.startedAt;
    // A structure chosen since the last run is a reason of its own: the run that files into it is
    // the one the person has just been waiting for, whether or not the site moved.
    const chosen = Boolean(structure.chosenAt && (!last || structure.chosenAt > last.startedAt));
    const resumed = Boolean(last && last.status !== RUN_STATUS.succeeded
      && schedule.workingSince && schedule.workingSince > last.startedAt);
    if (!moved && !chosen && !resumed) return { reason: "UP_TO_DATE" };

    const definition = findAgentDefinition(KNOWLEDGE_AGENT_SLUG);
    if (!definition) return { reason: "AGENT_NOT_AVAILABLE" };

    const current = now();
    const claimedFor = newest(
      resumed ? newest(position.movedAt, schedule.workingSince) : position.movedAt,
      chosen ? structure.chosenAt : null,
    );
    const claim = await schedules.findOneAndUpdate(
      {
        _id: schedule._id,
        enabled: true,
        $or: [{ claimedFor: { $exists: false } }, { claimedFor: null }, { claimedFor: { $lt: claimedFor } }],
      },
      { $set: { claimedFor, lastScheduledAt: current } },
      { returnDocument: "after" },
    );
    // A run was already started for this moment and has since ended without a later one: the
    // newest run above is that run, and it failed or was stopped. Nothing new justifies another.
    if (!claim) return { reason: "ALREADY_CLAIMED" };

    try {
      const run = await ledger.start({
        agent: AI_AGENT,
        version: 1,
        agentSlug: definition.slug,
        agentVersion: definition.version,
        trigger: "event",
        status: RUN_STATUS.queued,
        // The first run after a choice files into it: the structure is in its input, and it is a
        // rebuild when the Library was written before — in the old shape or an earlier choice.
        input: chosen
          ? { structure: structure.chosen.groups.map(toRunGroup), ...(last ? { rebuild: true } : {}) }
          : {},
        workspaceId,
        siteId,
        scheduleId: schedule._id,
        scheduledFor: current,
        config: {
          after: chosen ? "structure" : resumed && !moved ? "resume" : "sources",
          sourcesMovedAt: position.movedAt,
          ...(chosen ? { structureChosenAt: structure.chosenAt } : {}),
        },
      });
      return { runId: run._id, version: definition.version };
    } catch (error) {
      // The claim is given back, so the run that was never created is not mistaken for one that
      // ran: the next pass finds the same moment unclaimed and tries again.
      await schedules.updateOne(
        { _id: schedule._id, claimedFor },
        { $set: { claimedFor: schedule.claimedFor ?? null } },
      );
      throw error;
    }
  }

  const scheduler = {
    /**
     * Runs one pass and reports what it queued, what it started and what it left alone.
     *
     * Exposed separately from {@link start} so an operator can force a sweep without the daemon,
     * and so the decision is readable on its own.
     *
     * @param {object} [options]
     * @param {boolean} [options.embed=true] whether to consider the embedding stage
     * @param {boolean} [options.sources=true] whether to consider mirroring and writing
     * @returns {Promise<{queued: object[], started: object[], skipped: object[]}>}
     */
    async tick({ embed = true, sources = true } = {}) {
      const queued = [];
      const started = [];
      const skipped = [];
      const considerEmbed = embed && config.retrievalEnabled;
      // The mirror needs no key, so it is considered on every deployment: a workspace with no
      // model still has its site in the Library.
      const considerSources = sources;
      if (!considerEmbed && !considerSources) return { queued, started, skipped };

      const rows = await workspaces.find({}, { projection: { _id: 1 } }).limit(MAX_WORKSPACES_PER_PASS).toArray();
      for (const workspace of rows) {
        const workspaceId = workspace._id;
        const site = await sites.findOne({ workspaceId }, { projection: { _id: 1 } });
        const siteId = site?._id ?? null;
        const id = workspaceId.toHexString();

        /** Queues one stage's first pass, recording whether it was new work. */
        const enqueue = async (stage, context) => {
          // The key is the workspace, without a timestamp: while a pass for it is in flight the
          // next tick finds the same key and adds nothing, which is exactly what should happen to
          // a workspace being edited or crawled while it is being worked on.
          const { created } = await queue.enqueue({
            ...libraryJob(stage, { workspaceId, siteId }),
            maxAttempts: config.maxAttempts,
          });
          if (!created) {
            skipped.push({ workspaceId, stage, reason: "ALREADY_QUEUED" });
            return;
          }
          queued.push({ workspaceId, stage });
          logger("info", "library_scheduler.queued", { workspaceId: id, stage, ...context });
        };

        if (considerEmbed) {
          const position = await embedPosition(workspaceId, siteId);
          if (!position.stale) skipped.push({ workspaceId, stage: LIBRARY_JOBS.embed, reason: "UP_TO_DATE" });
          else {
            await enqueue(LIBRARY_JOBS.embed, {
              changedAt: iso(position.changedAt),
              indexedAt: iso(position.indexedAt),
              afterFailure: position.failed,
            });
          }
        }

        if (!considerSources) continue;
        if (!siteId) {
          skipped.push({ workspaceId, stage: LIBRARY_JOBS.mirror, reason: "NEVER_CRAWLED" });
          continue;
        }
        const position = await sourcePosition(workspaceId, siteId);

        // Writing is decided before mirroring is queued, on what was in flight when this pass
        // arrived. A workspace with a page that fails every time has a mirror pass queued on every
        // tick, and a decision taken after that enqueue would find one in flight forever.
        try {
          const outcome = await considerWrite({ workspaceId, siteId, position });
          if (outcome.runId) {
            started.push({ workspaceId, runId: outcome.runId });
            logger("info", "library_scheduler.run_created", {
              workspaceId: id,
              runId: outcome.runId.toHexString(),
              version: outcome.version,
              sourcesMovedAt: iso(position.movedAt),
            });
          } else {
            skipped.push({ workspaceId, stage: "write", reason: outcome.reason });
          }
        } catch (error) {
          // The mirror is still worth queuing for a workspace whose run could not be created.
          logger("error", "library_scheduler.run_failed", { workspaceId: id, message: error.message });
        }

        // Not while the site is being crawled — the crawl hands the site over when it finishes,
        // with its duplicates folded — and not beside a pass that is already queued or running,
        // whatever key it was queued under: two passes at once each place pages the other has
        // placed. The key alone only ever kept out a second pass with the same number.
        const busy = position.stale ? await upstreamBusy(workspaceId, siteId) : null;
        if (!position.stale) skipped.push({ workspaceId, stage: LIBRARY_JOBS.mirror, reason: "UP_TO_DATE" });
        else if (busy) skipped.push({ workspaceId, stage: LIBRARY_JOBS.mirror, reason: busy });
        else {
          await enqueue(LIBRARY_JOBS.mirror, {
            changedAt: iso(position.changedAt),
            mirroredAt: iso(position.mirroredAt),
            sweptAt: iso(position.sweptAt),
            afterFailure: position.failed,
            requested: position.requested,
          });
        }
      }
      return { queued, started, skipped };
    },

    /** Starts passes until {@link stop} is called. */
    start: loop.start,

    /** Stops scheduling and waits for the pass in progress to finish. */
    async stop() {
      await loop.stop();
      due = null;
    },
  };
  return scheduler;
}

/** One chosen top-level folder as the write run's input carries it. */
function toRunGroup(group) {
  return {
    path: group.path,
    title: group.title,
    summary: group.summary,
    subjects: group.subjects ?? [],
    ...(group.start ? { start: true } : {}),
  };
}

/** The later of two moments, ignoring the ones that are absent. */
function newest(left, right) {
  if (!left) return right ?? null;
  if (!right) return left;
  return left > right ? left : right;
}

/** A moment as text for a log line, or null. */
function iso(value) {
  return value ? value.toISOString() : null;
}

/** Whether a run has ended, however it ended. */
function isTerminal(status) {
  return status === RUN_STATUS.succeeded || status === RUN_STATUS.failed || status === RUN_STATUS.cancelled;
}
