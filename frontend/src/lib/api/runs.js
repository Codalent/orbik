import { apiFetch } from "./client";
import { requireId, requireSlug } from "./ids";

/**
 * Where the agent catalog — the agents this account can run, with what each is expected to cost —
 * is read from; also its cache key.
 */
export const AGENTS_PATH = "/v1/agents";

/**
 * Starts an agent run.
 *
 * The idempotency key is generated per attempt by the caller rather than here, so that a retry of
 * a request that may have succeeded reuses the same key and returns the original run instead of
 * starting — and paying for — a second one.
 */
export function createRun(workspaceId, { agentSlug, input }, idempotencyKey) {
  const body = { agentSlug: requireSlug(agentSlug) };
  if (input) body.input = input;

  return apiFetch(`/v1/workspaces/${requireId(workspaceId, "Workspace")}/runs`, {
    method: "POST",
    body: JSON.stringify(body),
    idempotencyKey,
  });
}

/** Where a workspace's agent runs are listed from, newest first; also their cache key. */
export function runsPath(workspaceId, { agent, status, limit = 20 } = {}) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (agent) query.set("agent", requireSlug(agent));
  if (status) query.set("status", status);
  return `/v1/workspaces/${requireId(workspaceId, "Workspace")}/runs?${query}`;
}

/** Reads one run with its input and, once it has finished successfully, its result. */
export function getRun(workspaceId, runId) {
  return apiFetch(
    `/v1/workspaces/${requireId(workspaceId, "Workspace")}/runs/${requireId(runId, "Run")}`,
  );
}

/**
 * Reads a run's progress events after one the caller already has.
 *
 * Paged by sequence number rather than by time, so resuming can neither skip an event that shared
 * a millisecond with the last one seen nor deliver it twice.
 */
export function listRunEvents(workspaceId, runId, { after = 0, limit = 200 } = {}) {
  const query = new URLSearchParams({ after: String(after), limit: String(limit) });
  return apiFetch(
    `/v1/workspaces/${requireId(workspaceId, "Workspace")}/runs/${requireId(runId, "Run")}/events?${query}`,
  );
}

/**
 * Asks a run to stop.
 *
 * The body is an empty object rather than absent: the API requires JSON on every state-changing
 * request, so a bodyless POST is refused before it reaches the route.
 */
export function cancelRun(workspaceId, runId) {
  return apiFetch(
    `/v1/workspaces/${requireId(workspaceId, "Workspace")}/runs/${requireId(runId, "Run")}/cancel`,
    { method: "POST", body: "{}" },
  );
}
