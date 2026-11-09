import { AGENT_COLLECTIONS } from "@orbik/core";

/**
 * Creates the indexes the agent runtime depends on for correctness, not only for speed.
 *
 * Re-running this function is safe because every index has a stable name and definition.
 *
 * @param {import("mongodb").Db} database connected MongoDB database
 */
export async function ensureAgentIndexes(database) {
  await dropSupersededIndexes(database);
  await stampSupersededKeys(database);
  await retireSupersededJobs(database);
  await dropSupersededLeaseFields(database);

  const jobs = database.collection(AGENT_COLLECTIONS.jobs);
  const runs = database.collection(AGENT_COLLECTIONS.runs);
  const sites = database.collection(AGENT_COLLECTIONS.sites);
  const urls = database.collection(AGENT_COLLECTIONS.urls);
  const robots = database.collection(AGENT_COLLECTIONS.robots);
  const snapshots = database.collection(AGENT_COLLECTIONS.snapshots);
  const links = database.collection(AGENT_COLLECTIONS.links);
  const events = database.collection(AGENT_COLLECTIONS.events);
  const runEvents = database.collection(AGENT_COLLECTIONS.runEvents);
  const aiCalls = database.collection(AGENT_COLLECTIONS.aiCalls);
  const markdown = database.collection(AGENT_COLLECTIONS.markdown);
  const schedules = database.collection(AGENT_COLLECTIONS.schedules);
  const agentSetups = database.collection(AGENT_COLLECTIONS.agentSetups);
  const knowledgeSources = database.collection(AGENT_COLLECTIONS.knowledgeSources);
  const llmsDocuments = database.collection(AGENT_COLLECTIONS.llmsDocuments);
  const libraryNodes = database.collection(AGENT_COLLECTIONS.libraryNodes);
  const libraryRevisions = database.collection(AGENT_COLLECTIONS.libraryRevisions);
  const libraryStructures = database.collection(AGENT_COLLECTIONS.libraryStructures);
  const sourceDocuments = database.collection(AGENT_COLLECTIONS.sourceDocuments);
  const knowledgeChunks = database.collection(AGENT_COLLECTIONS.knowledgeChunks);
  const indexState = database.collection(AGENT_COLLECTIONS.indexState);
  const sourceNotes = database.collection(AGENT_COLLECTIONS.sourceNotes);
  const conversations = database.collection(AGENT_COLLECTIONS.conversations);
  const designObservations = database.collection(AGENT_COLLECTIONS.designObservations);
  const designSystems = database.collection(AGENT_COLLECTIONS.designSystems);
  const designSystemRevisions = database.collection(AGENT_COLLECTIONS.designSystemRevisions);
  const brandAssets = database.collection(AGENT_COLLECTIONS.brandAssets);
  const brandChanges = database.collection(AGENT_COLLECTIONS.brandChanges);

  await Promise.all([
    // Backs the claim query. The key order matches the claim filter and sort exactly
    // (status and readiness first, then the sort keys) so a claim is an index scan of a
    // single short range rather than a scan of every queued job.
    jobs.createIndex(
      { status: 1, availableAt: 1, priority: 1 },
      { name: "agent_jobs_claim" },
    ),

    jobs.createIndex({ agent: 1, status: 1, createdAt: 1, _id: 1 }, { name: "agent_jobs_crawl_fifo" }),
    jobs.createIndex({ runId: 1, updatedAt: -1 }, { name: "agent_jobs_live_activity" }),

    // Enforces "one in-flight job per idempotency key" rather than "one job ever": `active`
    // is present only while a job is pending or running, so the same key can legitimately be
    // enqueued again for the next scheduled crawl once the previous one reaches a terminal
    // state. A plain unique index would permanently burn every key after its first use.
    jobs.createIndex(
      { agent: 1, idempotencyKey: 1 },
      {
        unique: true,
        name: "agent_jobs_active_idempotency_unique",
        partialFilterExpression: { active: { $exists: true } },
      },
    ),

    // Backs lease recovery: finding jobs whose worker died without releasing them.
    jobs.createIndex(
      { status: 1, leaseUntil: 1 },
      { name: "agent_jobs_lease_recovery" },
    ),

    // Backs "jobs for this run" progress queries from the API.
    jobs.createIndex({ runId: 1, status: 1 }, { name: "agent_jobs_run_status" }),

    // Backs "latest runs for this site" and "is an agent already running here" queries.
    runs.createIndex(
      { siteId: 1, agent: 1, startedAt: -1 },
      { name: "agent_runs_site_agent_started" },
    ),
    runs.createIndex({ status: 1, startedAt: -1 }, { name: "agent_runs_status_started" }),

    // One crawl configuration per workspace seed, so a repeated setup updates rather than
    // silently creating a second site that would crawl the same pages twice.
    sites.createIndex(
      { workspaceId: 1, seedUrl: 1 },
      { unique: true, name: "crawl_sites_workspace_seed_unique" },
    ),

    // The URL registry's identity. Every discovery upsert keys on it, so uniqueness here is what
    // makes discovering the same page from a sitemap and from a link produce one row, not two.
    urls.createIndex(
      { siteId: 1, urlHash: 1 },
      { unique: true, name: "crawl_urls_site_hash_unique" },
    ),

    // Backs the frontier query: which in-scope URLs for this site still need fetching, shallowest
    // first, so a crawl that hits its page budget has covered the most important pages.
    urls.createIndex(
      { siteId: 1, eligible: 1, state: 1, depth: 1 },
      { name: "crawl_urls_frontier" },
    ),

    // Backs "what changed since the last run" queries from the API.
    urls.createIndex({ siteId: 1, lastSeenAt: -1 }, { name: "crawl_urls_site_last_seen" }),

    // Backs the route tree: one branch's children are a prefix match on the path, and the tree is
    // read one node at a time so a 50,000-URL site never has to be loaded to draw it.
    urls.createIndex({ siteId: 1, pathDepth: 1, url: 1 }, { name: "crawl_urls_path_tree" }),

    // Backs "show me this page and every URL that is really the same page", which is what lets a
    // list collapse trailing-slash duplicates into one row.
    urls.createIndex({ siteId: 1, groupKey: 1 }, { name: "crawl_urls_group" }),

    // Backs "how did this site's crawl permissions change" over time.
    robots.createIndex({ siteId: 1, fetchedAt: -1 }, { name: "crawl_robots_site_fetched" }),

    // One Markdown document per page; the fetch job upserts on it.
    markdown.createIndex({ siteId: 1, urlHash: 1 }, { unique: true, name: "crawl_page_markdown_site_page_unique" }),

    // Backs the AI call log: an account's calls newest first, and one run's calls.
    aiCalls.createIndex({ workspaceId: 1, startedAt: -1 }, { name: "ai_calls_workspace_started" }),
    aiCalls.createIndex({ runId: 1, startedAt: -1 }, { name: "ai_calls_run_started" }),

    // One snapshot per URL per run. Uniqueness makes a retried fetch job overwrite its own
    // partial result rather than leaving two snapshots that disagree about the same page.
    snapshots.createIndex(
      { siteId: 1, runId: 1, urlHash: 1 },
      { unique: true, name: "crawl_page_snapshots_site_run_url_unique" },
    ),

    // Backs "this page's history" and "the latest snapshot for this URL".
    snapshots.createIndex({ siteId: 1, urlHash: 1, fetchedAt: -1 }, { name: "crawl_page_snapshots_url_history" }),

    // Backs the report queries that matter most: what is broken, and what is not indexable.
    snapshots.createIndex({ siteId: 1, runId: 1, indexable: 1 }, { name: "crawl_page_snapshots_indexable" }),
    snapshots.createIndex({ siteId: 1, runId: 1, status: 1 }, { name: "crawl_page_snapshots_status" }),

    // Outbound edges for one page, which is also the key the per-page replace deletes on.
    links.createIndex({ siteId: 1, fromUrlHash: 1 }, { name: "crawl_links_from" }),

    // Inbound edges for one page: what makes "which pages link here" and "which pages have no
    // internal links pointing at them" answerable.
    links.createIndex({ siteId: 1, toUrlHash: 1 }, { name: "crawl_links_to" }),

    // Backs a consumer resuming from the last event it processed. `_id` is the cursor rather
    // than a timestamp because ObjectIds are unique and ordered, so resuming can neither skip an
    // event sharing a timestamp with the last one read nor deliver it twice.
    events.createIndex({ type: 1, _id: 1 }, { name: "agent_events_type_cursor" }),
    events.createIndex({ siteId: 1, _id: 1 }, { name: "agent_events_site_cursor" }),

    // The scheduler's claim query: which enabled site has been due longest.
    sites.createIndex({ enabled: 1, nextCrawlAt: 1 }, { name: "crawl_sites_due" }),

    // Backs "this workspace's runs, newest first", the agent run history the interface renders.
    runs.createIndex({ workspaceId: 1, startedAt: -1 }, { name: "agent_runs_workspace_started" }),

    // The event log's identity and its read order in one index. Uniqueness makes a retried job that
    // resends events land on the rows it already wrote rather than duplicating
    // the run's history.
    runEvents.createIndex(
      { runId: 1, seq: 1 },
      { unique: true, name: "agent_run_events_run_seq_unique" },
    ),

    // The agent scheduler's claim query: which enabled schedule has been due longest.
    schedules.createIndex({ enabled: 1, nextRunAt: 1 }, { name: "agent_schedules_due" }),

    // One schedule per agent per workspace, so saving a schedule twice updates it rather than
    // creating a second one that would run the same agent again an hour later.
    schedules.createIndex(
      { workspaceId: 1, agentSlug: 1 },
      { unique: true, name: "agent_schedules_workspace_agent_unique" },
    ),

    // One setup per agent per workspace: what a person chose during onboarding.
    agentSetups.createIndex(
      { workspaceId: 1, agentSlug: 1 },
      { unique: true, name: "agent_setups_workspace_agent_unique" },
    ),

    // One verdict per source per agent. Keyed on the source's kind and key rather than on a URL
    // hash, because a verdict is no longer only ever about a crawled page: a route pattern is one
    // verdict that stands for every page under it, and a Notion page or a vault note will be a
    // verdict about something that has no URL at all. The key is also the join the content
    // listing makes on every run.
    knowledgeSources.createIndex(
      { workspaceId: 1, agentSlug: 1, sourceKind: 1, sourceKey: 1 },
      { unique: true, name: "knowledge_sources_workspace_agent_source_unique" },
    ),

    // Backs "what has this agent decided about this workspace", which is what the interface shows
    // when somebody asks why a page was left out.
    knowledgeSources.createIndex(
      { workspaceId: 1, agentSlug: 1, relevant: 1 },
      { name: "knowledge_sources_workspace_verdict" },
    ),

    // The Library's identity: one node per path per workspace. Uniqueness is what makes an agent
    // writing the same file twice in one run an update rather than a second copy of it.
    libraryNodes.createIndex(
      { workspaceId: 1, path: 1 },
      { unique: true, name: "library_nodes_workspace_path_unique" },
    ),

    // Backs listing one folder's children in the order they are shown: a person's explicit order
    // first, then the default of folders before files and alphabetical within each.
    libraryNodes.createIndex(
      { workspaceId: 1, parentPath: 1, order: 1, name: 1 },
      { name: "library_nodes_children" },
    ),

    // Backs reading a whole branch, and the depth bound `library.tree` applies to it.
    libraryNodes.createIndex({ workspaceId: 1, depth: 1, path: 1 }, { name: "library_nodes_depth" }),
    // Who links here: a rename rewrites every file whose stored links name the old path or a path
    // beneath it, and finds them by this rather than by reading every file's text.
    libraryNodes.createIndex({ workspaceId: 1, links: 1 }, { name: "library_nodes_links" }),
    // The overview, the index and the folder they are in are found by role, on every tree read.
    libraryNodes.createIndex(
      { workspaceId: 1, role: 1 },
      { name: "library_nodes_role", partialFilterExpression: { role: { $type: "string" } } },
    ),

    // The sections the top level used to be shown under. Nothing reads or writes the collection
    // any more; the index stays so a deployment that still has rows keeps them consistent.
    libraryStructures.createIndex({ workspaceId: 1 }, { unique: true, name: "library_structures_workspace_unique" }),

    // One file's history, newest first.
    libraryRevisions.createIndex(
      { workspaceId: 1, path: 1, revision: -1 },
      { unique: true, name: "library_revisions_path_revision_unique" },
    ),

    // One prose document per key per workspace, so a connector re-reading its side upserts rather
    // than accumulating copies of the same note.
    sourceDocuments.createIndex(
      { workspaceId: 1, kind: 1, key: 1 },
      { unique: true, name: "source_documents_workspace_kind_key_unique" },
    ),

    // The chunk store's identity, and the same key the vector points are built from. Uniqueness is
    // what makes re-indexing a page replace its passages rather than accumulate a second copy of
    // every one beside the first.
    knowledgeChunks.createIndex(
      { workspaceId: 1, sourceKind: 1, sourceKey: 1, ordinal: 1 },
      { unique: true, name: "knowledge_chunks_workspace_source_ordinal_unique" },
    ),

    // Backs the read a search makes: the vector database returns point ids and scores, and the
    // passages behind them are fetched by those ids in one query.
    knowledgeChunks.createIndex({ workspaceId: 1, pointId: 1 }, { name: "knowledge_chunks_point" }),

    // Backs the read a neighbour search makes before it asks the vector database anything: which
    // other documents carry a passage word for word the same as one of this document's. Those are
    // template text, and are left out of "what is this page close to".
    knowledgeChunks.createIndex({ workspaceId: 1, hash: 1 }, { name: "knowledge_chunks_workspace_hash" }),

    // One state row per source per workspace. This is the key the indexer's whole "what changed"
    // question is asked against, and uniqueness is what stops two passes racing into two rows that
    // disagree about what was last embedded.
    indexState.createIndex(
      { workspaceId: 1, sourceKind: 1, sourceKey: 1 },
      { unique: true, name: "index_state_workspace_source_unique" },
    ),

    // Backs the scheduler's question — when did this workspace last index anything — and the
    // status line's, which is the same one.
    indexState.createIndex({ workspaceId: 1, indexedAt: -1 }, { name: "index_state_workspace_indexed" }),

    // One state row per source page per workspace. The key the mirror's whole "which pages need
    // copying" question is asked against, and uniqueness is what stops two passes racing into two
    // rows that disagree about where a page's file lives.
    sourceNotes.createIndex(
      { workspaceId: 1, sourceKey: 1 },
      { unique: true, name: "source_note_state_workspace_source_unique" },
    ),

    // Back the scheduler's two questions: when did this workspace last copy a page, and when did
    // a page its knowledge base is written from last move.
    sourceNotes.createIndex({ workspaceId: 1, mirroredAt: -1 }, { name: "source_note_state_workspace_mirrored" }),
    sourceNotes.createIndex({ workspaceId: 1, movedAt: -1 }, { name: "source_note_state_workspace_moved" }),

    // Backs going the other way: from a Library path back to the page it is a copy of.
    sourceNotes.createIndex({ workspaceId: 1, path: 1 }, { name: "source_note_state_workspace_path" }),

    // Backs "which pages does this listing link to", which is what a Library folder that names a
    // listing shows beneath it.
    sourceNotes.createIndex({ workspaceId: 1, listedBy: 1 }, { name: "source_note_state_workspace_listed" }),

    // A workspace's conversations, most recently used first: the list down the side of the ask page.
    conversations.createIndex({ workspaceId: 1, updatedAt: -1 }, { name: "conversations_workspace_updated" }),

    // One llms.txt per workspace: the file is a single current deliverable, not a history.
    llmsDocuments.createIndex(
      { workspaceId: 1 },
      { unique: true, name: "llms_documents_workspace_unique" },
    ),

    // One observation per run of the Design system agent. Uniqueness is what makes a job the
    // queue hands back after a crash rewrite its own record rather than leave two for one run.
    designObservations.createIndex({ runId: 1 }, { unique: true, name: "design_observations_run_unique" }),

    // The newest observation of a workspace, and the few before it that are kept.
    designObservations.createIndex({ workspaceId: 1, createdAt: -1 }, { name: "design_observations_workspace_created" }),

    // One design system per workspace: the thing a person corrects and keeps. Uniqueness is what
    // makes a derivation and a pin written at the same moment land on one document.
    designSystems.createIndex({ workspaceId: 1 }, { unique: true, name: "design_systems_workspace_unique" }),

    // A workspace's earlier systems, newest first, each restorable by its number.
    designSystemRevisions.createIndex(
      { workspaceId: 1, revision: -1 },
      { unique: true, name: "design_system_revisions_workspace_revision_unique" },
    ),

    // One stored picture per workspace, whatever found it and however often: the identity of an
    // asset is its bytes. This is what makes a second run refresh a row instead of adding one.
    brandAssets.createIndex({ workspaceId: 1, hash: 1 }, { unique: true, name: "brand_assets_workspace_hash_unique" }),

    // The Brand page's listing and the MCP tools' filter: a workspace's assets of a kind, newest.
    brandAssets.createIndex({ workspaceId: 1, kind: 1, seenAt: -1 }, { name: "brand_assets_workspace_kind_seen" }),
    // The changes one chat turn made, read under each answer; and the later changes an undo checks.
    brandChanges.createIndex({ workspaceId: 1, runId: 1, at: 1 }, { name: "brand_changes_workspace_run" }),
    brandChanges.createIndex({ workspaceId: 1, pointer: 1, at: -1 }, { name: "brand_changes_workspace_pointer" }),
  ]);
}

/**
 * Removes indexes whose key pattern changed while their name stayed the same.
 *
 * MongoDB rejects `createIndex` when an index of that name exists with different keys, so without
 * this the whole `ensureAgentIndexes` call fails on every database created before the change —
 * which means every deployed environment, while a fresh test database passes. Dropping first is
 * safe: an index holds no data, and the correct one is recreated immediately below.
 *
 * Each entry can be removed once no deployment predates the change that superseded it.
 */
async function dropSupersededIndexes(database) {
  const superseded = [
    // Replaced when eligibility (scope, robots, and page budget) was split out of the progress
    // `state` field, so the frontier query filters on `eligible` rather than `inScope`.
    { collection: AGENT_COLLECTIONS.urls, name: "crawl_urls_frontier", key: { siteId: 1, inScope: 1, state: 1, depth: 1 } },
    // Belonged to the page-speed agent's earlier plan-of-cards design, which settled cards by the
    // run holding them. The agent now tracks scores and holds no run references on its setup.
    { collection: AGENT_COLLECTIONS.agentSetups, name: "agent_setups_target_run", key: { "targets.runId": 1 } },
    // Belonged to the desktop runner and its execution modes, both removed: every run is now
    // dispatched the same way, and nothing holds a lease on one.
    { collection: AGENT_COLLECTIONS.runs, name: "agent_runs_dispatch", key: { status: 1, executionMode: 1, startedAt: 1 } },
    { collection: AGENT_COLLECTIONS.runs, name: "agent_runs_runner_lease", key: { status: 1, runnerLeaseUntil: 1 } },
    // Backed "when did this workspace last write a note". The source layer copies pages now and
    // records `mirroredAt`, which has an index of its own.
    { collection: AGENT_COLLECTIONS.sourceNotes, name: "source_note_state_workspace_noted", key: { workspaceId: 1, notedAt: -1 } },
  ];

  // Superseded outright rather than re-keyed under the same name: the source ledger's identity
  // moved from "a page of this site" to "a source of this workspace, of some kind", so the old
  // indexes describe a key that no longer exists. Dropping by name is safe — an index holds no
  // data — and the replacements are created immediately below.
  for (const name of ["knowledge_sources_site_agent_page_unique", "knowledge_sources_verdict"]) {
    try {
      await database.collection(AGENT_COLLECTIONS.knowledgeSources).dropIndex(name);
    } catch (error) {
      // IndexNotFound (27) and NamespaceNotFound (26) both mean there is nothing to remove.
      if (error?.code !== 27 && error?.code !== 26) throw error;
    }
  }

  for (const { collection, name, key } of superseded) {
    let existing;
    try {
      existing = await database.collection(collection).indexes();
    } catch (error) {
      // NamespaceNotFound (26) means the collection has never been written, so there is nothing
      // to migrate.
      if (error?.code === 26) continue;
      throw error;
    }
    const match = existing.find((index) => index.name === name);
    if (match && JSON.stringify(match.key) === JSON.stringify(key)) {
      await database.collection(collection).dropIndex(name);
    }
  }
}

/**
 * Writes the ledger's new key onto rows that predate it.
 *
 * Not a migration framework and not a data rewrite: every verdict keeps its meaning, and the only
 * thing that changes is that the fields the new unique index is built on are present. It has to
 * happen, because a unique index cannot be created over documents that all lack its key — every
 * legacy row would collide on `(null, null)` and `ensureAgentIndexes` would fail on every database
 * that predates the Library, which is every deployed one.
 *
 * Idempotent and cheap: it matches only rows without `sourceKind`, so the second run does nothing.
 * It can be removed once no deployment predates the change.
 */
async function stampSupersededKeys(database) {
  const knowledgeSources = database.collection(AGENT_COLLECTIONS.knowledgeSources);
  try {
    await knowledgeSources.updateMany(
      { sourceKind: { $exists: false }, urlHash: { $type: "string" } },
      // A crawled page's key has always been the crawler's URL hash; the ledger simply did not say
      // so in a field, because a page was the only thing a verdict could be about.
      [{ $set: { sourceKind: "page", sourceKey: "$urlHash" } }],
    );
  } catch (error) {
    // NamespaceNotFound (26) means no agent has ever reviewed anything here.
    if (error?.code !== 26) throw error;
  }
}

/**
 * Takes the job id off the crawl lease.
 *
 * The lease in `crawl_queue_locks` used to be held for one job at a time and named it. It is held
 * for a run now, by a worker that may be running several of the run's jobs, and names its owner
 * and the run only (`runtime/queue.js`). Nothing reads the old field; it is removed so the
 * document says what is true of it.
 *
 * Idempotent, and it can be removed once no deployment predates the change.
 */
async function dropSupersededLeaseFields(database) {
  await database
    .collection(AGENT_COLLECTIONS.crawlLocks)
    .updateOne({ _id: "crawler", jobId: { $exists: true } }, { $unset: { jobId: "" } });
}

/**
 * Clears queued work addressed to agents that no longer exist under that name.
 *
 * Noting and indexing used to be two registered agents, `notes` and `index`, and are now two
 * stages of one, `library`. A worker claims jobs by the names it has registered, so a job queued
 * for either old name would never be claimed and never fail — it would sit in the queue for good.
 *
 * The first stage's job type went the same way later: it was `notes.write` while it wrote a
 * model's note per page, and is `sources.mirror` now that it copies the page. The agent still
 * exists, so such a job would be claimed and then fail for want of a handler.
 *
 * Deleted rather than renamed, because nothing is lost by it: neither stage keeps its work in the
 * job. What is outstanding is a hash comparison against the documents, and the crawler's next
 * hand-off or the scheduler's next pass queues it again under the new name. Renaming could also
 * collide with a pass already queued there for the same workspace.
 *
 * Idempotent, and it can be removed once no deployment predates the change.
 */
async function retireSupersededJobs(database) {
  try {
    await database
      .collection(AGENT_COLLECTIONS.jobs)
      .deleteMany({
        $or: [{ agent: { $in: ["notes", "index"] } }, { agent: "library", type: "notes.write" }],
        status: { $in: ["pending", "running"] },
      });
  } catch (error) {
    // NamespaceNotFound (26) means nothing has ever been queued here.
    if (error?.code !== 26) throw error;
  }
}
