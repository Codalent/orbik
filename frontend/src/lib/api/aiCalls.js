import { apiFetch } from "./client";

/** Filters the list and the summary share, in the order they are written into a query. */
const FILTERS = ["period", "source", "model", "status", "workspaceId", "q"];

/**
 * Lists the account's model calls, newest first.
 *
 * @param {object} [query]
 * @param {number} [query.limit]
 * @param {string|null} [query.before] the previous page's `nextBefore`
 * @param {string|null} [query.period] `1h`, `24h`, `7d` or `30d`
 * @param {string|null} [query.source] `agent-run`, `chat`, `embedding` or `crawl-schedule`
 * @param {string|null} [query.model]
 * @param {string|null} [query.status] `running`, `succeeded` or `failed`
 * @param {string|null} [query.workspaceId]
 * @param {string|null} [query.q] text to find in a prompt, system prompt, reply or run id
 */
export function listAiCalls({ limit = 50, before = null, ...filters } = {}) {
  const params = [`limit=${Number(limit)}`, ...filterParams(filters)];
  if (before) params.push(`before=${encode(before)}`);
  return apiFetch(`/v1/ai-calls?${params.join("&")}`);
}

/** Totals the calls the same filters select: counts, spend, tokens, and spend by model. */
export function summarizeAiCalls(filters = {}) {
  const params = filterParams(filters);
  return apiFetch(`/v1/ai-calls/summary${params.length ? `?${params.join("&")}` : ""}`);
}

/** Reads one call in full: system prompt, prompt, reply. */
export function getAiCall(callId) {
  if (!/^[0-9a-f]{24}$/.test(String(callId))) throw new Error("Call identifier is invalid.");
  return apiFetch(`/v1/ai-calls/${callId}`);
}

/** The filters that are set, as query parameters; an unset filter is left out rather than sent empty. */
function filterParams(filters) {
  return FILTERS.filter((key) => filters[key]).map((key) => `${key}=${encode(String(filters[key]))}`);
}

/**
 * Encodes one query value so it passes `apiFetch`'s path check, which admits `[A-Za-z0-9%&=_.-]`
 * only. `encodeURIComponent` leaves `!'()*~` as they are, and a search for "(draft)" must not be
 * refused for it, so those are escaped too.
 */
function encode(value) {
  return encodeURIComponent(value).replace(/[!'()*~]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
