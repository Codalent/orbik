/**
 * How a model call from the AI call log is put into words.
 *
 * Shared by the log's rows and the call it opens, which both the AI calls section of Settings and
 * the LLM calls developer page show, so a call is named, priced, and timed the same way wherever
 * it appears.
 */

/** What a value that is not known, or does not apply, is shown as. */
export const MISSING = "–";

/**
 * The agents that answer questions in the Ask panel — the one members ask, and the read-only variant
 * a read-only member is answered by; their runs are chat, not agent work.
 */
const CHAT_AGENT_SLUGS = Object.freeze(["library-chat", "library-chat-read", "brand-chat", "brand-chat-read"]);

/** What a call was for, as the filter offers it and as a row names it. */
export const SOURCES = Object.freeze([
  { value: "agent-run", label: "Agent run" },
  { value: "chat", label: "Chat" },
  { value: "embedding", label: "Index" },
  { value: "crawl-schedule", label: "Crawl planning" },
]);

/** How far back the log looks. */
export const PERIODS = Object.freeze([
  { value: "1h", label: "Last hour" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
]);

/** How a call ended, or that it has not. */
export const STATUSES = Object.freeze([
  { value: "succeeded", label: "Succeeded" },
  { value: "running", label: "Working now" },
  { value: "failed", label: "Failed" },
]);

/** Says what a call was for, in the words a person used to start it. */
export function describePurpose(call) {
  if (call.purpose === "crawl-schedule") return "Crawl frequency planning";
  // The only embedding a run makes is its search query; an index pass has no run.
  if (call.purpose === "embedding") return call.runId ? "Search query embedding" : "Embeddings";
  if (call.agentSlug) return `${humanize(call.agentSlug)}${call.agentVersion ? ` v${call.agentVersion}` : ""}`;
  return "Agent run";
}

/** Says which of the sources a call belongs to, with the label the filter uses for it. */
export function describeSource(call) {
  if (call.purpose === "embedding") return "Index";
  if (call.purpose === "crawl-schedule") return "Crawl planning";
  if (CHAT_AGENT_SLUGS.includes(call.agentSlug)) return "Chat";
  return "Agent run";
}

/** Says who was asked, and how it was paid for. */
export function describeBackend(backend) {
  if (backend === "openai-api") return "OpenAI API";
  return "Anthropic API";
}

/** The model a row shows: the one that answered, or the one asked for until something has. */
export function modelOf(call) {
  return call.model?.used ?? call.model?.requested ?? null;
}

/** Input and output tokens as one phrase, `6,214 → 842`. Embeddings have no output. */
export function describeTokens(call) {
  const usage = call.usage;
  if (!usage) return MISSING;
  const output = call.purpose === "embedding" ? MISSING : formatCount(usage.outputTokens);
  return `${formatCount(usage.inputTokens)} → ${output}`;
}

/** What the prompt cache did for a call, or how many texts an embedding request carried. */
export function describeCache(call) {
  if (call.purpose === "embedding") {
    return Number.isFinite(call.inputs) ? `${formatCount(call.inputs)} ${call.inputs === 1 ? "input" : "inputs"}` : "";
  }
  const usage = call.usage;
  if (!usage) return "";
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  if (read && write) return `${formatCompact(read)} read · ${formatCompact(write)} write`;
  if (read) return `${formatCompact(read)} cache read`;
  if (write) return `${formatCompact(write)} cache write`;
  return "no cache";
}

/** What a call's total is, and on what basis. */
export function describeCostBasis(call) {
  if (call.status === "running") return "arrives when the call finishes";
  if (!Number.isFinite(call.costUsd)) return "no usage reported";
  if (call.backend === "openai-api") return "OpenAI list price";
  return "list price";
}

const TOKEN_KINDS = Object.freeze([
  { key: "input", label: "Input", usage: "inputTokens" },
  { key: "output", label: "Output", usage: "outputTokens" },
  { key: "cacheWrite", label: "Cache write", usage: "cacheWriteTokens" },
  { key: "cacheRead", label: "Cache read", usage: "cacheReadTokens" },
]);

/**
 * A call's cost line by line: each kind of token, times the price recorded for it, and the sum.
 *
 * The prices are the ones the worker recorded when the call finished, so a re-pricing later does
 * not rewrite an old call's arithmetic. `difference` is what the recorded total and the lines do
 * not agree on, when they do not; the gap is shown rather than hidden.
 *
 * @returns {{lines: Array<{label: string, tokens: number|null, rate: number|null, amount: number|null}>,
 *   itemized: number|null, difference: number|null}}
 */
export function costBreakdown(call) {
  const pricing = call.pricing ?? {};
  const kinds = call.purpose === "embedding" ? TOKEN_KINDS.slice(0, 1) : TOKEN_KINDS;
  const lines = kinds.map((kind) => {
    const tokens = call.usage ? call.usage[kind.usage] ?? 0 : null;
    const rate = Number.isFinite(pricing[kind.key]) ? pricing[kind.key] : null;
    return {
      label: kind.label,
      tokens,
      rate,
      amount: Number.isFinite(tokens) && rate !== null ? (tokens * rate) / 1_000_000 : null,
    };
  });
  const itemized = lines.every((line) => line.amount !== null)
    ? lines.reduce((total, line) => total + line.amount, 0)
    : null;
  const difference = itemized !== null && Number.isFinite(call.costUsd) && Math.abs(call.costUsd - itemized) >= 0.00005
    ? call.costUsd - itemized
    : null;
  return { lines, itemized, difference };
}

/** A token price, `$2.00 / M`, with as many places as the price needs. */
export function formatRate(rate) {
  if (!Number.isFinite(rate)) return MISSING;
  return `$${rate.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} / M`;
}

/**
 * The agents whose runs have a page of their own. A call logged by any other agent — one an older
 * version of Orbik had, whose runs are still in the log — has no page to open, and is not linked.
 */
const RUN_PAGE_AGENT_SLUGS = Object.freeze(["business-knowledge-base", "llms-txt", "design-system"]);

/** Where to look at the run a call was part of, when it has one and a page shows it. */
export function runHref(call) {
  if (!call.runId || !call.workspaceId) return null;
  if (CHAT_AGENT_SLUGS.includes(call.agentSlug)) return `/workspaces/${call.workspaceId}/ask`;
  if (RUN_PAGE_AGENT_SLUGS.includes(call.agentSlug)) return `/workspaces/${call.workspaceId}/agents/${call.agentSlug}?run=${call.runId}`;
  return null;
}

/** Four decimals, because a Haiku call is fractions of a cent and "$0.00" says nothing. */
export function formatCost(value) {
  if (!Number.isFinite(value)) return MISSING;
  return `$${value.toFixed(4)}`;
}

export function formatCount(value) {
  return Number.isFinite(value) ? value.toLocaleString("en-US") : MISSING;
}

/** A large count in three significant figures: `3.14M`, `38.9K`, `212K`. */
export function formatCompact(value) {
  if (!Number.isFinite(value)) return MISSING;
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000_000) return `${significant(value / 1_000_000)}M`;
  if (magnitude >= 1_000) return `${significant(value / 1_000)}K`;
  return String(Math.round(value));
}

function significant(value) {
  const places = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  return String(Number(value.toFixed(places)));
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return MISSING;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/** How long a call took, or has taken so far while it is still running. */
export function describeDuration(call, now = Date.now()) {
  if (call.status === "running" && call.startedAt) {
    const started = new Date(call.startedAt).getTime();
    return Number.isFinite(started) ? `${formatDuration(Math.max(0, now - started))} so far` : MISSING;
  }
  return formatDuration(call.durationMs);
}

/** A start time for a row: the time alone today, the day and minute before that. */
export function formatClock(iso, now = new Date()) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return MISSING;
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  }
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day} ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
}

/** A start time in full, `Sep 24, 14:32:08`. */
export function formatStarted(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return MISSING;
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day}, ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })}`;
}

/** Turns an agent slug into its name: `business-knowledge-base` → `Business knowledge base`. */
export function humanize(slug) {
  const words = String(slug).split("-").filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
