import { AGENT_COLLECTIONS, COLLECTIONS } from "@orbik/core";

import { MCP_CALL_RETENTION_DAYS } from "../mcp/mcpCallLog.js";
import { HOME_PREFERENCES_COLLECTION } from "../repositories/homePreferenceRepository.js";

/**
 * Creates uniqueness, owner-list, idempotency, and limiter indexes.
 * Re-running this function is safe because every index has a stable name.
 * The `sessions` TTL index is intentionally absent: connect-mongo creates it
 * itself (`expires_1`) under `autoRemove: "native"`, and declaring the same
 * key pattern here under another name makes Mongo reject it as a conflict.
 */
export async function ensureIndexes(database) {
  await dropLegacySessionTtlIndex(database);
  await dropLegacyCrawlBudgetIndex(database);
  await Promise.all([
    database.collection(COLLECTIONS.users).createIndex(
      { email: 1 },
      { unique: true, name: "users_email_unique" },
    ),
    database.collection(COLLECTIONS.workspaces).createIndex(
      { ownerId: 1, creationKey: 1 },
      { unique: true, name: "workspaces_owner_creation_key_unique" },
    ),
    database.collection(COLLECTIONS.workspaces).createIndex(
      { ownerId: 1, createdAt: -1 },
      { name: "workspaces_owner_created" },
    ),
    database.collection(COLLECTIONS.rateLimits).createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: "rate_limits_expiry_ttl" },
    ),

    // One crawl budget document per workspace per month. Uniqueness is what makes the month's
    // allowance a single row that can be decremented atomically: two documents for one
    // workspace-month would let two workers each charge against a different copy of the same
    // allowance and overspend it. It also backs "this workspace's spend over time", which reads
    // the same key in reverse. Partial, because months kept while budgets were per account have
    // no `workspaceId` (the `2026-11-13-crawl-budget-per-workspace` migration).
    database.collection(COLLECTIONS.crawlBudgetPeriods).createIndex(
      { workspaceId: 1, period: -1 },
      {
        unique: true,
        name: "crawl_budget_periods_workspace_period_unique",
        partialFilterExpression: { workspaceId: { $exists: true } },
      },
    ),

    // One membership row per person per workspace: the uniqueness is what makes adding somebody
    // twice — two invites accepted, a retried request — leave one role rather than two that
    // disagree. The `userId` index backs `listAccessible`, which every workspace list and every
    // access check for a member starts from.
    database.collection(COLLECTIONS.workspaceMembers).createIndex(
      { workspaceId: 1, userId: 1 },
      { unique: true, name: "workspace_members_workspace_user_unique" },
    ),
    database.collection(COLLECTIONS.workspaceMembers).createIndex(
      { userId: 1 },
      { name: "workspace_members_user" },
    ),

    // An invite link is found by the SHA-256 of its token and nothing else, so the hash is unique:
    // two invites can never answer to one link. The `(workspaceId, email)` index backs the pending
    // list on the settings page and the "a new invite to this address replaces the old one" rule.
    database.collection(COLLECTIONS.workspaceInvites).createIndex(
      { tokenHash: 1 },
      { unique: true, name: "workspace_invites_token_unique" },
    ),
    database.collection(COLLECTIONS.workspaceInvites).createIndex(
      { workspaceId: 1, email: 1 },
      { name: "workspace_invites_workspace_email" },
    ),

    // One access request per address: asking twice updates the row rather than adding one. The
    // approved link is found by its hash alone, and only approved rows carry one.
    database.collection(COLLECTIONS.accessRequests).createIndex(
      { email: 1 },
      { unique: true, name: "access_requests_email_unique" },
    ),
    database.collection(COLLECTIONS.accessRequests).createIndex(
      { "approval.tokenHash": 1 },
      { unique: true, name: "access_requests_token_unique", partialFilterExpression: { "approval.tokenHash": { $type: "string" } } },
    ),
    database.collection(COLLECTIONS.accessRequests).createIndex(
      { status: 1, lastRequestedAt: -1 },
      { name: "access_requests_status_requested" },
    ),

    // A password reset link is found by its hash; rows go a day after they expire.
    database.collection(COLLECTIONS.passwordResets).createIndex(
      { tokenHash: 1 },
      { unique: true, name: "password_resets_token_unique" },
    ),
    database.collection(COLLECTIONS.passwordResets).createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 86_400, name: "password_resets_expiry_ttl" },
    ),
    database.collection(COLLECTIONS.passwordResets).createIndex(
      { userId: 1 },
      { name: "password_resets_user" },
    ),

    // A signup waiting for its address: one per address (signing up again replaces it), found by
    // its link's hash, gone a day after it expires.
    database.collection(COLLECTIONS.signupVerifications).createIndex(
      { tokenHash: 1 },
      { unique: true, name: "signup_verifications_token_unique" },
    ),
    database.collection(COLLECTIONS.signupVerifications).createIndex(
      { email: 1 },
      { unique: true, name: "signup_verifications_email_unique" },
    ),
    database.collection(COLLECTIONS.signupVerifications).createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 86_400, name: "signup_verifications_expiry_ttl" },
    ),

    // One row of Home page preferences per person per workspace: unique, so two tabs skipping a
    // step at the same moment upsert one row rather than two that disagree.
    database.collection(HOME_PREFERENCES_COLLECTION).createIndex(
      { workspaceId: 1, userId: 1 },
      { unique: true, name: "workspace_home_preferences_workspace_user_unique" },
    ),

    // Backs the MCP token list on a workspace's settings page, newest first, through its `userId`
    // prefix: a token names a set of its owner's workspaces, and the list is every token of the
    // owner's whose set covers the page's workspace — the same query that authorizes it.
    database.collection(COLLECTIONS.mcpTokens).createIndex(
      { userId: 1, workspaceId: 1, createdAt: -1 },
      { name: "mcp_tokens_user_workspace_created" },
    ),

    // The MCP call log is read one workspace at a time, newest first, over a window of days; and
    // it is swept, because a question an AI asked three months ago says little about what the
    // knowledge base is missing now. The TTL is on `at`, the moment of the call.
    database.collection(COLLECTIONS.mcpCalls).createIndex(
      { workspaceId: 1, at: -1 },
      { name: "mcp_calls_workspace_at" },
    ),
    database.collection(COLLECTIONS.mcpCalls).createIndex(
      { at: 1 },
      { expireAfterSeconds: MCP_CALL_RETENTION_DAYS * 24 * 60 * 60, name: "mcp_calls_ttl" },
    ),

    // One row per OAuth client. For a client that publishes its own metadata the identifier is the
    // HTTPS URL it publishes at, so uniqueness here is what makes the row a cache of that document
    // rather than a second source of truth for it.
    database.collection(COLLECTIONS.oauthClients).createIndex(
      { clientId: 1 },
      { unique: true, name: "oauth_clients_client_id_unique" },
    ),

    // Authorization requests and codes expire on their own. A request nobody approved and a code
    // nobody exchanged are both ordinary outcomes — somebody closed the tab — so they are swept
    // rather than cleaned up by anything that would have to notice they were abandoned.
    database.collection(COLLECTIONS.oauthRequests).createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: "oauth_requests_ttl" },
    ),
    database.collection(COLLECTIONS.oauthCodes).createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: "oauth_codes_ttl" },
    ),

    // Written when a grant named one workspace, and kept rather than migrated. Grants written since
    // name a set of workspaces and carry no `workspaceId`, so for them this index allows one row per
    // person and client — which is the rule `upsertGrant` keeps (a second consent updates the grant
    // a person already sees), and what stops two approvals racing from inserting two rows. Rows
    // written before sets keep their `workspaceId` and stay unique per workspace, as they were.
    database.collection(COLLECTIONS.oauthGrants).createIndex(
      { userId: 1, clientId: 1, workspaceId: 1 },
      { unique: true, name: "oauth_grants_user_client_workspace_unique" },
    ),
    // Backs the connected-apps list on a workspace's settings page, through its `userId` prefix
    // now that the list is "every grant whose set covers this workspace".
    database.collection(COLLECTIONS.oauthGrants).createIndex(
      { userId: 1, workspaceId: 1, createdAt: -1 },
      { name: "oauth_grants_user_workspace_created" },
    ),

    // Expired tokens are swept rather than kept: a refresh token that died 30 days ago proves
    // nothing a revoked grant does not already say. Rotation detection works on the live rows.
    database.collection(COLLECTIONS.oauthTokens).createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: "oauth_tokens_ttl" },
    ),
    // Backs revoking every token under a grant in one operation, which is what revoking the grant
    // from the settings page does.
    database.collection(COLLECTIONS.oauthTokens).createIndex(
      { grantId: 1, kind: 1 },
      { name: "oauth_tokens_grant_kind" },
    ),

    // The one index on an agent-owned collection that the API declares, because the API is what
    // depends on it: `POST /runs` is made idempotent by this uniqueness, and leaving it to the
    // agent worker's startup would mean a deployment where the API came up first could accept a
    // retried request and start a second run — charging a user twice for one click. Both
    // ensure-functions are idempotent and the name is stable, so one owner is enough.
    //
    // The API writes agent setups during onboarding and reads them on every agent page, so the
    // uniqueness that makes "save the setup" an upsert rather than a duplicate belongs here too.
    database.collection(AGENT_COLLECTIONS.agentSetups).createIndex(
      { workspaceId: 1, agentSlug: 1 },
      { unique: true, name: "agent_setups_workspace_agent_unique" },
    ),

    // Partial rather than plain: most runs carry no key at all — a scheduled run has nobody to
    // retry it — and a plain unique index would collapse every one of those onto a single
    // missing value.
    database.collection(AGENT_COLLECTIONS.runs).createIndex(
      { workspaceId: 1, requestKey: 1 },
      {
        unique: true,
        name: "agent_runs_request_key_unique",
        partialFilterExpression: { requestKey: { $exists: true } },
      },
    ),
  ]);
}

/**
 * Removes the `sessions_expiry_ttl` index an earlier version of this file created.
 * It covers the same `{ expires: 1 }` key connect-mongo indexes as `expires_1`, so
 * leaving it in place makes the session store fail its own createIndex with
 * IndexOptionsConflict. Dropping it is safe: connect-mongo recreates the TTL index
 * on connect, and the index carries no data of its own.
 */
/**
 * Drops the index that kept one crawl budget month per account, from before budgets were per
 * workspace: it would refuse a second workspace of the same owner its own month. The migration
 * drops it too, for the worker and the scheduler, which start without this function.
 */
async function dropLegacyCrawlBudgetIndex(database) {
  try {
    await database.collection(COLLECTIONS.crawlBudgetPeriods).dropIndex("crawl_budget_periods_user_period_unique");
  } catch (error) {
    // IndexNotFound (27) and NamespaceNotFound (26) mean there is nothing to clean up.
    if (error?.code !== 27 && error?.code !== 26) throw error;
  }
}

async function dropLegacySessionTtlIndex(database) {
  try {
    await database.collection(COLLECTIONS.sessions).dropIndex("sessions_expiry_ttl");
  } catch (error) {
    // IndexNotFound (27) and NamespaceNotFound (26) mean there is nothing to clean up.
    if (error?.code !== 27 && error?.code !== 26) throw error;
  }
}
