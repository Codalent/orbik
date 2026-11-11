import { assertValidEnvironment, parseBoundedInteger, parseMongoUri, parseNodeEnv, parseUrl } from "@orbik/core";
import { AGENT_CAPABILITIES } from "@orbik/protocol";
import { parseRetrievalEnvironment } from "@orbik/retrieval";
import { hostname } from "node:os";

import { ROUTES_BY_PROVIDER } from "../ai/model/modelRouter.js";
import { DEFAULT_CRAWLER_CONTACT_URL } from "../crawler/siteConfig.js";

/**
 * Parses and validates every environment input owned by the agent processes.
 *
 * Agent processes never bind a port: the API on 4100 is the only HTTP listener, and run status is
 * observed through MongoDB. That is why no host or port input exists here.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} source environment values
 * @returns {Readonly<object>} canonical agent runtime configuration
 * @throws {Error} listing every invalid value when any input is missing, malformed, or out of range
 */
export function parseAgentEnvironment(source) {
  const errors = [];
  const nodeEnv = parseNodeEnv(source, errors);
  const { mongodbUri, databaseName } = parseMongoUri(source, errors);

  const workerId = (source.AGENT_WORKER_ID ?? `${hostname()}-${process.pid}`).trim();
  if (!workerId || workerId.length > 128 || !/^[\w.:-]+$/.test(workerId)) {
    errors.push("AGENT_WORKER_ID must be 1-128 characters of letters, digits, dot, colon, dash, or underscore.");
  }

  const concurrency = parseBoundedInteger(source.AGENT_CONCURRENCY, 4, 1, 64, "AGENT_CONCURRENCY", errors);
  const pollIntervalMs = parseBoundedInteger(source.AGENT_POLL_INTERVAL_MS, 1000, 100, 60_000, "AGENT_POLL_INTERVAL_MS", errors);
  const leaseSeconds = parseBoundedInteger(source.AGENT_LEASE_SECONDS, 300, 30, 3600, "AGENT_LEASE_SECONDS", errors);
  const maxAttempts = parseBoundedInteger(source.AGENT_MAX_ATTEMPTS, 5, 1, 20, "AGENT_MAX_ATTEMPTS", errors);
  const shutdownGraceMs = parseBoundedInteger(source.AGENT_SHUTDOWN_GRACE_MS, 20_000, 1000, 120_000, "AGENT_SHUTDOWN_GRACE_MS", errors);
  // The scheduler only needs to notice that a site has become due. Checking far more often than
  // the shortest supported cadence buys nothing and only adds queries.
  const schedulerIntervalMs = parseBoundedInteger(source.AGENT_SCHEDULER_INTERVAL_MS, 60_000, 1000, 3_600_000, "AGENT_SCHEDULER_INTERVAL_MS", errors);
  const dispatcherIntervalMs = parseBoundedInteger(source.AGENT_DISPATCHER_INTERVAL_MS, 2000, 250, 60_000, "AGENT_DISPATCHER_INTERVAL_MS", errors);

  // The credential of Anthropic, which serves every reasoning call — agent runs, the Library chat
  // and the summaries plain-code agents ask for — when `ORBIK_AI_PROVIDER` (below) chooses it. The
  // embeddings stay on `ORBIK_OPENAI_API_KEY`, parsed below with the retrieval settings. Optional,
  // like that one: a worker without it still starts, and says what it cannot do.
  //
  // Never echoed into an error, a log line, or a run's failure detail — only its presence is ever
  // reported. `redactValue` in @orbik/core covers the accidental cases; this covers the deliberate
  // ones.
  const anthropicApiKey = (source.ORBIK_ANTHROPIC_API_KEY ?? "").trim();
  if (anthropicApiKey && anthropicApiKey.length < 20) {
    errors.push("ORBIK_ANTHROPIC_API_KEY must be a complete API key when it is set.");
  }

  // ---------------------------------------------------------------------------------------------
  // The retrieval index — the vector database beside MongoDB — and `ORBIK_OPENAI_API_KEY`, which
  // the embeddings are made with. It also serves the reasoning calls when `ORBIK_AI_PROVIDER`
  // chooses OpenAI (`OPENAI_ROUTES`).
  //
  // All optional, and parsed by `parseRetrievalEnvironment`, the one parser the API uses too. A
  // worker without the key still starts, crawls, mirrors each site into its Library and derives
  // the brand; it indexes nothing, rather than refusing to start over a credential a
  // crawler-only deployment never uses.
  const { qdrantUrl, qdrantCollection, qdrantApiKey, openaiApiKey, embeddingModel } = parseRetrievalEnvironment(source, errors);

  // Which provider serves the reasoning calls: `anthropic` or `openai`. Unset (or `auto`), it is
  // the one whose key is set — Anthropic when both are — so an install with only the OpenAI key,
  // which the embeddings need anyway, runs everything on that one key. Naming a provider whose key
  // is missing is not an error at start: the worker says no AI provider is configured, as it does
  // with no key at all.
  const providerSetting = (source.ORBIK_AI_PROVIDER ?? "").trim().toLowerCase();
  if (providerSetting && providerSetting !== "auto" && !Object.hasOwn(ROUTES_BY_PROVIDER, providerSetting)) {
    errors.push("ORBIK_AI_PROVIDER must be anthropic, openai or auto.");
  }
  const providerKeys = { anthropic: anthropicApiKey, openai: openaiApiKey };
  const aiProvider = Object.hasOwn(ROUTES_BY_PROVIDER, providerSetting)
    ? providerSetting
    : (!anthropicApiKey && openaiApiKey ? "openai" : "anthropic");

  // How often the index scheduler looks for a workspace whose documents have moved since they were
  // embedded. A minute: a person editing a Library file should be able to ask about it shortly
  // afterwards, and the check itself is two indexed queries per workspace.
  const indexIntervalMs = parseBoundedInteger(source.AGENT_INDEX_INTERVAL_MS, 60_000, 5000, 3_600_000, "AGENT_INDEX_INTERVAL_MS", errors);

  // How often the Library scheduler looks for a workspace whose pages have been rendered since
  // they were last copied into its source layer, or where somebody has asked for a page by name,
  // and decides whether the knowledge base should be rewritten. A minute, like the index: a copy
  // is a few database writes, and a page somebody asked for should arrive while they are looking.
  // It was five minutes, under `AGENT_NOTE_INTERVAL_MS`, while each page cost a model call.
  const sourceIntervalMs = parseBoundedInteger(source.AGENT_SOURCE_INTERVAL_MS, 60_000, 5000, 3_600_000, "AGENT_SOURCE_INTERVAL_MS", errors);

  // The page the crawler's User-Agent names (`crawlerUserAgent`), read from the environment where
  // the request is made; checked here so a bad value stops the process at start.
  parseUrl(source.ORBIK_CRAWLER_CONTACT_URL, DEFAULT_CRAWLER_CONTACT_URL, "ORBIK_CRAWLER_CONTACT_URL", errors);

  // ---------------------------------------------------------------------------------------------
  // The anonymous usage ping the scheduler sends once a day (`agents/src/telemetry.js`): off unless
  // switched on with ORBIK_TELEMETRY=on, documented in the README and announced in the scheduler's
  // log at start. It carries counts and which optional services are configured — never content, an
  // address, an email or a key. ORBIK_TELEMETRY_URL is where it goes; pointing it elsewhere is for
  // checking what is sent.
  const telemetrySetting = (source.ORBIK_TELEMETRY ?? "off").trim().toLowerCase();
  if (!["on", "off", "true", "false", "1", "0"].includes(telemetrySetting)) errors.push("ORBIK_TELEMETRY must be on or off.");
  const telemetryEnabled = ["on", "true", "1"].includes(telemetrySetting);
  const telemetryUrl = parseUrl(source.ORBIK_TELEMETRY_URL, "https://telemetry.orbik.io/v1/ping", "ORBIK_TELEMETRY_URL", errors);

  assertValidEnvironment(errors);

  return Object.freeze({
    nodeEnv,
    mongodbUri,
    databaseName,
    isProduction: nodeEnv === "production",
    workerId,
    concurrency,
    pollIntervalMs,
    leaseSeconds,
    leaseMs: leaseSeconds * 1000,
    maxAttempts,
    shutdownGraceMs,
    schedulerIntervalMs,
    dispatcherIntervalMs,
    anthropicApiKey,
    /** The provider every reasoning call goes to, and its capability-to-model table. */
    aiProvider,
    aiProviderConfigured: Boolean(providerKeys[aiProvider]),
    routes: ROUTES_BY_PROVIDER[aiProvider],
    qdrantUrl,
    qdrantCollection,
    qdrantApiKey,
    openaiApiKey,
    embeddingModel,
    indexIntervalMs,
    sourceIntervalMs,
    /** Whether this worker can index and search at all, for reporting and for the scheduler. */
    retrievalEnabled: Boolean(openaiApiKey),
    /**
     * Whether a write run of the Library agent could be served at all. The scheduler starts those
     * runs on its own, and without a key every one would fail saying no provider is configured —
     * so on a crawler-only deployment it starts none, and says that is why. The run is
     * long-context work, so the key that matters is the one of the provider the chosen route
     * table sends that to.
     */
    synthesisEnabled: Boolean(providerKeys[ROUTES_BY_PROVIDER[aiProvider][AGENT_CAPABILITIES.longContext].provider]),
    telemetryEnabled,
    telemetryUrl,
  });
}
