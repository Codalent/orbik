/**
 * Stable physical collection names owned by the authentication and workspace features.
 *
 * These names are the cross-process schema contract: the API writes them and agent processes
 * read them, so a rename here is a coordinated change. Agent-owned collections are declared in
 * `AGENT_COLLECTIONS` below instead of being added to this map.
 */
export const COLLECTIONS = Object.freeze({
  users: "users",
  workspaces: "workspaces",
  sessions: "sessions",
  rateLimits: "rate_limits",
  /**
   * One document per user per calendar month, holding that month's page-fetch allowance.
   *
   * Crawl budget buys page fetches. Keeping a document per period rather than one balance that a job resets is what
   * makes the monthly reset need no scheduled job at all — a new month is a new key, and the
   * previous month's document stays as the record of what was spent.
   */
  crawlBudgetPeriods: "crawl_budget_periods",
  /**
   * Long-lived credentials that let a person's own AI client read one workspace over MCP.
   *
   * A row holds an argon2id hash of the secret and the workspace it names, and nothing else a
   * client could redirect: no tool in the registry takes a workspace argument, so the workspace on
   * this row is the only thing that decides what the credential can read. One token names one
   * workspace, which is why this is not a field on `users`.
   */
  mcpTokens: "mcp_tokens",
  /**
   * AI clients that have asked to read a workspace through OAuth, rather than a pasted token.
   *
   * Two kinds of row, told apart by `kind`. A `cimd` row is a *cache* of a document the client
   * publishes at its own HTTPS `client_id` — Orbik re-reads it rather than trusting the copy
   * forever. A `dcr` row is a registration this server minted, for older clients that cannot
   * publish one. Neither is a credential: a public client authenticates with PKCE, not a secret.
   */
  oauthClients: "oauth_clients",
  /**
   * Authorization requests waiting for a person to see them.
   *
   * They exist because consent is rendered by the web app and the authorization endpoint is on the
   * API: the request has to survive a redirect to another origin and back. Short-lived and
   * TTL-swept, and a request that is never approved simply expires.
   */
  oauthRequests: "oauth_requests",
  /** Authorization codes. Single use, TTL-swept, and bound to the PKCE challenge that minted them. */
  oauthCodes: "oauth_codes",
  /**
   * One row per person × client × workspace: what somebody actually agreed to.
   *
   * The grant is the thing a person recognises and revokes — "Claude.ai may read Acme" — while the
   * access and refresh tokens beneath it come and go. Revoking it kills every token issued under
   * it, which is why tokens carry a grant rather than repeating its fields.
   */
  oauthGrants: "oauth_grants",
  /** Access and refresh tokens issued under a grant, stored hashed and TTL-swept when they expire. */
  oauthTokens: "oauth_tokens",
  /**
   * One row per tool call a person's own AI made over MCP, in the workspace it read: which tool,
   * through which credential and client, how it went, and — for the two search tools — the query
   * with how many passages came back and how close the best one was.
   *
   * It is what the "What your AI asked" report on the settings page is read from: the questions the
   * knowledge base answered least well, a to-do list for the Library and a content gap list for
   * the site. Never the answer, never the credential's secret. Swept ninety days after the call.
   */
  mcpCalls: "mcp_calls",
  /**
   * One row per person who belongs to a workspace they do not own, with their role in it.
   *
   * The owner is the workspace's `ownerId` and never has a row here, so a workspace with no rows
   * is exactly the single-owner workspace it always was. A row holds `admin`, `member` or
   * `read-only`; deleting it is what removes somebody, and they lose access on their next request.
   */
  workspaceMembers: "workspace_members",
  /**
   * Invitations to join a workspace, each redeemable once by the address it names.
   *
   * Only a hash of the link's token is stored, as for `mcp_tokens`: the link is shown once, when
   * it is made, and a copy of this collection cannot be turned into a way into a workspace.
   */
  workspaceInvites: "workspace_invites",
  /**
   * One row per deleted workspace: who deleted it and when, how many records went from each
   * store, and anything that could not be removed at the time — today only the vector database's
   * points, when Qdrant was not answering (`leftovers`, each with the store, the code and the
   * reason). The workspace's own data is gone; this is the record that it was, and of what an
   * operator may still have to remove by hand.
   */
  workspaceDeletions: "workspace_deletions",
  /**
   * People who asked to join an install whose signup is closed: one row per address, with its
   * status (`pending`, `approved`, `dismissed`, `joined`). An approved row carries the hash of the
   * one-time link that lets that address make an account; the link itself is never stored.
   */
  accessRequests: "access_requests",
  /**
   * One-time links that set a new password for an account, each stored only as a hash, valid for
   * an hour and once. Rows are removed a day after they expire.
   */
  passwordResets: "password_resets",
  /**
   * A handful of documents about the install itself rather than any account, each under a fixed
   * `_id`: `setup`, the one-time code that claims a new install, which exists only until its first
   * account does; `install`, the anonymous id the usage ping reports under; `secrets`, the
   * secrets an install generated for itself when its environment named none; and `migrations`,
   * the lock that keeps two processes from migrating at once.
   */
  systemState: "system_state",
  /** One row per data migration this database has had, by its id: see `@orbik/migrations`. */
  migrations: "migrations",
});

/**
 * Returns the documented application collections for a connected database.
 *
 * @param {import("mongodb").Db} database connected MongoDB database
 */
export function getCollections(database) {
  return Object.fromEntries(
    Object.entries(COLLECTIONS).map(([name, collection]) => [name, database.collection(collection)]),
  );
}

/**
 * Physical collection names for agent execution.
 *
 * They live here rather than in the `agents` package because both processes touch them, in both
 * directions: the API renders crawl configuration, run progress, and results, while the workers
 * read the runs and schedules the API writes. Keeping the names in one place is what
 * stops the two processes from drifting apart on the schema they share. The *logic* over these
 * collections — index definitions, the queue, the crawler, the runtimes — stays in the package
 * that owns it, so the API never depends on a crawler's parser or a model provider to read a row.
 */
export const AGENT_COLLECTIONS = Object.freeze({
  /** One document per unit of work claimed by a worker. */
  jobs: "agent_jobs",
  crawlLocks: "crawl_queue_locks",
  /** One document per agent execution, holding status, counters, and failure detail. */
  runs: "agent_runs",
  /** Append-only progress events for one run, ordered by a per-run sequence number. */
  runEvents: "agent_run_events",
  /** Recurring agent executions: what to run and how often. */
  schedules: "agent_schedules",
  /**
   * One document per agent per workspace holding what a person configured during onboarding.
   *
   * Whether the agent is set to work, and for an agent that takes one, the list of pages a person
   * chose for it (the Design system agent's pages to render) — chosen by the person, never by the
   * agent.
   */
  agentSetups: "agent_setups",
  /**
   * One document per derivation run of the Design system agent: what Chrome saw on the pages it
   * rendered — colours with how much of the page each paints, type, spacing, shape, components.
   *
   * The *observed* layer, kept apart from the system a model proposes from it so that "what is on
   * the site" and "what we suggest the system is" can always be told apart, and so a proposal can
   * be made again from the same observations without opening Chrome. The last few are kept: the
   * newest feeds the Brand page's Observed drawer, the one before it is what "what changed" is
   * compared with.
   */
  designObservations: "design_observations",
  /**
   * One document per workspace: its design system as it stands — the agent's proposal, the values
   * a person pinned, and the two merged.
   *
   * One current system rather than one per run, because it is a thing a person corrects and keeps:
   * a pin has to outlive the derivation it was made against, which it could not do on a document a
   * later run replaces.
   */
  designSystems: "design_systems",
  /** Earlier versions of a workspace's design system, newest first, restorable. */
  designSystemRevisions: "design_system_revisions",
  /**
   * One document per stored image of a workspace's brand: a logo, a photograph, an illustration,
   * an icon, a screenshot, the type specimen.
   *
   * Metadata only. The bytes are in GridFS under `brand_assets_files`, keyed by this document's
   * identifier, because a row every listing reads should not carry a megabyte it never shows.
   * Unique on `(workspaceId, hash)`, so a run that finds the same image again refreshes the row
   * rather than storing the picture twice.
   */
  brandAssets: "brand_assets",
  /**
   * One document per change made to a workspace's brand by a person — on the Brand page or
   * through the chat — with the value before and after, so each can be shown and undone.
   */
  brandChanges: "brand_changes",
  /** Per-workspace crawl configuration: seeds, scope, politeness, cadence, and robots policy. */
  sites: "crawl_sites",
  /** The durable URL registry: every URL ever discovered for a site, and how. */
  urls: "crawl_urls",
  /** One document per robots.txt retrieval, so a change in crawl permissions is visible. */
  robots: "crawl_robots",
  /** One document per fetched URL per run: status, metadata, and the indexability verdict. */
  snapshots: "crawl_page_snapshots",
  /** The internal link graph, replaced per page on each fetch. */
  links: "crawl_links",
  /**
   * One document per page holding its latest content as Markdown.
   *
   * Its own collection because the Markdown is the one large field a page has, and the
   * snapshots are read by every list and tree query. Latest only: the snapshot history already
   * says what changed and when, and a copy per crawl would multiply storage on every visit for a
   * file that is usually identical.
   */
  markdown: "crawl_page_markdown",
  /**
   * One document per folder or file of a workspace's Library.
   *
   * The Library is what the business *is*, arranged the way a person arranges a vault: a tree of
   * folders and files that agents and people both write. It replaced a flat set of knowledge
   * pages, whose one level and model-chosen slugs meant nothing was addressable by meaning and a
   * consuming agent had to list everything and guess from titles. Paths are materialised on each
   * node — `/clients/deeplearning-ai` — so reading a branch is one indexed query rather than a
   * walk, which is the trade that matters: a Library is read constantly and reorganised rarely.
   */
  libraryNodes: "library_nodes",
  /**
   * The last twenty versions of every Library file.
   *
   * History exists because two writers share these documents. "The agent replaced the paragraph I
   * wrote" has to be answerable with the text rather than with an apology, and a person who
   * deleted a file has to be able to get it back — which is what makes file deletion safe to
   * offer at all.
   */
  libraryRevisions: "library_revisions",
  /**
   * Retired: one document per workspace holding the sections its Library's top level used to be
   * shown under — "Start here", "Offer", "Proof" — as display headings over a flat set of paths.
   *
   * The top level is real folders now, chosen by the person (`structure.js` in `@orbik/library`),
   * and nothing reads or writes this collection. Existing rows are left where they are; the name
   * stays so the index on it and any operator looking for it still find it.
   */
  libraryStructures: "library_structures",
  /**
   * Prose from outside the website that the Library may be built from.
   *
   * Empty today: connectors are deliberately not in this release. It exists now because the
   * source model is keyed on `(kind, key)` everywhere, and the day a Notion or vault connector
   * lands it should be one module rather than a re-key of a ledger that already holds real
   * verdicts.
   */
  sourceDocuments: "source_documents",
  /**
   * One document per source page per agent: whether it belongs in that agent's output, why, and
   * the content hash last folded in.
   *
   * This is what makes a second run cheap and an update honest. Without it every run would
   * re-read the whole site and rewrite the whole knowledge base; with it a run asks "what is new
   * or changed since I last looked", and the answer is exact — a hash comparison, not a guess
   * from a timestamp. Keyed per agent because the knowledge base and the llms.txt file judge
   * relevance differently and run on their own cadences.
   */
  knowledgeSources: "knowledge_sources",
  /**
   * One document per workspace: the llms.txt file the agent maintains for that site.
   *
   * A single current file rather than a history, because it is a deliverable a person copies onto
   * their site. Its parsed sections are stored beside the text so the interface can show what is
   * in it without re-parsing Markdown in the browser.
   */
  llmsDocuments: "llms_documents",
  /**
   * One document per chunk of every indexed source: the passage itself, and where it came from.
   *
   * The text lives here rather than in Qdrant because a vector database is for finding things, not
   * for holding them: a search returns identities and scores, and the passage it found has to be
   * readable — and expandable to its neighbours — without paying for a second embedding. Keyed the
   * same way the vector points are, so a result from one is a lookup in the other.
   */
  knowledgeChunks: "knowledge_chunks",
  /**
   * One document per indexed source: the content hash it was last embedded at.
   *
   * This is the whole reason a re-index is cheap. Embedding is the only part of Orbik that is paid
   * for per unit of text, so the indexer must never re-embed a page whose words did not move — and
   * "did not move" is a hash comparison against what was actually embedded, not a crawl timestamp
   * or a revision number, both of which change when nothing was said differently.
   */
  indexState: "index_state",
  /**
   * One document per source page: whether the Library holds a copy of it, at which content hash,
   * and whether the knowledge base is written from it.
   *
   * The same bargain `index_state` makes, for the same reason: a page whose words did not move is
   * not copied again, and "did not move" is a hash comparison against the hash the copy was made
   * from, not a crawl timestamp. The row also holds the copy's path, so the mirror stays stable
   * when a URL would slugify onto a path another page already has; the reason a page is not
   * stored, so the ledger can say so; a person's "include this anyway"; whether the page was
   * chosen for the knowledge base, why, and which pages list it; when a chosen page last moved,
   * which is what starts a write run; and the last failure, so one page that could not be written
   * is retried without stopping the batch it was in.
   *
   * The collection and its handle are named for the notes the source layer used to hold — a
   * model's digest of each page, at the same paths. Rows from then carry `notedAt` and no
   * `mirroredAt`, which is how the first pass after the change knows to replace each note with
   * its page.
   */
  sourceNotes: "source_note_state",
  /**
   * One document per chat conversation: the questions asked of a workspace's index and the answers.
   *
   * A conversation rather than a list of runs because a follow-up question only makes sense beside
   * the turn before it. The run that produced each answer is recorded on the message, so the same
   * history and events every other agent run has are the ones behind a chat answer too.
   */
  conversations: "conversations",
  /** Append-only outbox of observed changes, which is how agents reach each other. */
  events: "agent_events",
  /**
   * One document per model call, whoever made it and however it went.
   *
   * The prompt, the model, the tokens, the cost, the answer. It exists because "what did the AI
   * actually do" is otherwise unanswerable once a run has finished: the run holds its result and
   * its events, but not the words the model was given or the words it replied with, and the
   * provider's own console — where there even is one — knows nothing about which workspace a
   * call belonged to. Written by the agents worker at the start of a call and completed at its
   * end, so a call that is still running, or that crashed the worker, is visible too.
   */
  aiCalls: "ai_calls",
});

/**
 * Returns handles for the agent-owned collections on a connected database.
 *
 * @param {import("mongodb").Db} database connected MongoDB database
 */
export function getAgentCollections(database) {
  return Object.fromEntries(
    Object.entries(AGENT_COLLECTIONS).map(([name, collection]) => [name, database.collection(collection)]),
  );
}

/**
 * Collections written by agents this release no longer has, which a database may still hold.
 *
 * The SEO agents (Change watch, Technical SEO audit, Titles & descriptions, Internal linking,
 * Redirect map, Structured data, Cannibalisation, AI crawler readiness, Competitor topic gap,
 * Image alt text, Search Console, Lighthouse Page Speed) and the suggestions they wrote left the
 * open-source release in November 2026. Nothing reads or writes these collections now, and no
 * migration drops them: removing data from a deployment is its operator's call. They are named
 * here for one reason: deleting a workspace must still remove its rows from them.
 *
 * `workspace` holds the collections whose rows carry `workspaceId`; `siteOrRun` the ones where
 * some rows carry only the crawl site's or a run's id instead.
 */
export const RETIRED_COLLECTIONS = Object.freeze({
  workspace: Object.freeze([
    "lighthouse_reports",
    "change_watch_digests",
    "technical_audits",
    "agent_suggestions",
    "overlap_scans",
    "search_console_connections",
    "search_console_oauth_states",
    "search_console_property_days",
    "search_console_page_days",
    "search_console_query_days",
    "search_console_reports",
    "competitor_setups",
    "competitor_reads",
    "competitor_pages",
    "competitor_reports",
    "competitor_site_maps",
    "competitor_documents",
    "competitor_profiles",
    "competitor_changes",
    "alt_text_images",
  ]),
  siteOrRun: Object.freeze(["change_watch_digests", "technical_audits", "lighthouse_reports"]),
});
