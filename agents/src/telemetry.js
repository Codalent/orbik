import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { AGENT_COLLECTIONS, COLLECTIONS, log } from "@orbik/core";

import { createLoop } from "./runtime/loop.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000;
const SEND_TIMEOUT_MS = 10_000;
const INSTALL_ID = "install";

/** The release, from the repository's root manifest. */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

/**
 * The anonymous usage ping of a self-hosted install: once a day, from the scheduler, only when
 * `ORBIK_TELEMETRY=on` (it is off by default).
 *
 * What it sends is everything in {@link buildPing} and nothing else: a random id made for this
 * install, the release, how many workspaces there are, how many pages were fetched and which
 * agents ran in the last 30 days, and which optional services are configured. No page, address,
 * hostname, name, email or key is read into it. The ping it sends is also written to this
 * process's log, so an operator can see exactly what left.
 *
 * Several schedulers may run against one database: the day's ping is claimed with one
 * conditional update on the install's document, so it is sent once whichever claims it. A failed
 * send is logged and not retried until the next day; nothing waits on it.
 *
 * @param {object} options
 * @param {import("mongodb").Db} options.database
 * @param {{telemetryEnabled: boolean, telemetryUrl: string, anthropicApiKey: string, openaiApiKey: string}} options.config
 * @param {{extensions: string[]}} options.extensions loaded here; only how many is reported
 * @param {Function} [options.logger]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => Date} [options.now]
 */
export function createTelemetry({ database, config, extensions, logger = log, fetchImpl = fetch, now = () => new Date() }) {
  const state = database.collection(COLLECTIONS.systemState);
  let checked = false;

  /** Claims today's ping, or returns null when it was sent less than a day ago. */
  async function claim() {
    const current = now();
    await state.updateOne(
      { _id: INSTALL_ID },
      { $setOnInsert: { installId: randomUUID(), createdAt: current } },
      { upsert: true },
    );
    return state.findOneAndUpdate(
      { _id: INSTALL_ID, $or: [{ lastPingAt: { $exists: false } }, { lastPingAt: { $lte: new Date(current.getTime() - DAY_MS) } }] },
      { $set: { lastPingAt: current } },
      { returnDocument: "after" },
    );
  }

  async function tick() {
    // The first pass only waits: a scheduler restarted in a loop must not ping on every start, and
    // whoever reads its log at start sees the notice before anything is sent.
    if (!checked) {
      checked = true;
      return;
    }
    const install = await claim();
    if (!install) return;
    const ping = await buildPing({ database, config, extensions, installId: install.installId, now: now() });
    logger("info", "telemetry.sending", { url: config.telemetryUrl, ping });
    try {
      const response = await fetchImpl(config.telemetryUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": `orbik/${VERSION}` },
        body: JSON.stringify(ping),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      logger(response.ok ? "info" : "warn", "telemetry.sent", { status: response.status });
    } catch (error) {
      logger("info", "telemetry.not_sent", { message: error?.cause?.code ?? error?.message ?? "unknown" });
    }
  }

  return {
    /** Says what is sent and how to stop it, or that nothing is, in words, in this process's log. */
    announce() {
      if (!config.telemetryEnabled) {
        console.log("Anonymous usage statistics are off: nothing is sent. ORBIK_TELEMETRY=on sends a daily anonymous ping (docs/self-hosting.md).");
        return;
      }
      console.log([
        `Orbik sends anonymous usage statistics once a day to ${config.telemetryUrl}:`,
        "a random id for this install, the release, counts of workspaces, pages fetched and agent runs,",
        "and which optional services are configured. Never content, addresses, emails or keys.",
        "Set ORBIK_TELEMETRY=off to send nothing. Each ping is also written to this log.",
      ].join("\n"));
    },

    /** The loop the scheduler runs, or null when telemetry is off. */
    loop: config.telemetryEnabled
      ? createLoop({
        name: "telemetry",
        intervalMs: () => (checked ? CHECK_EVERY_MS : FIRST_CHECK_MS),
        tick,
        logger,
        startedContext: { url: config.telemetryUrl },
      })
      : null,

    /** One pass, for checking what would be sent. */
    tick,
  };
}

/**
 * The whole of what is sent. Counts and switches only: nothing here can name a person, a site or
 * a key, and each field is listed in docs/self-hosting.md.
 */
export async function buildPing({ database, config, extensions, installId, now }) {
  const since = new Date(now.getTime() - 30 * DAY_MS);
  const runs = database.collection(AGENT_COLLECTIONS.runs);
  const [workspaces, crawls, agentRuns] = await Promise.all([
    database.collection(COLLECTIONS.workspaces).countDocuments({}),
    runs.aggregate([
      { $match: { agent: "crawler", startedAt: { $gte: since } } },
      { $group: { _id: null, runs: { $sum: 1 }, pages: { $sum: { $ifNull: ["$counters.pagesFetched", 0] } } } },
    ]).toArray(),
    runs.aggregate([
      { $match: { agent: "ai", startedAt: { $gte: since }, agentSlug: { $type: "string" } } },
      { $group: { _id: "$agentSlug", runs: { $sum: 1 } } },
    ]).toArray(),
  ]);
  return {
    installId,
    version: VERSION,
    node: process.versions.node,
    sentAt: now.toISOString(),
    counts: {
      workspaces,
      crawlRuns30d: crawls[0]?.runs ?? 0,
      pagesFetched30d: crawls[0]?.pages ?? 0,
      // Agent slugs are the names of the agents this release ships (or an extension adds), not
      // anything a person typed.
      agentRuns30d: Object.fromEntries(agentRuns.map((row) => [row._id, row.runs]).sort(([left], [right]) => left.localeCompare(right))),
    },
    services: {
      anthropic: Boolean(config.anthropicApiKey),
      openaiEmbeddings: Boolean(config.openaiApiKey),
      chrome: chromeInstalled(),
      extensions: extensions.extensions.length,
    },
  };
}

/** Whether a Chrome the agents can start is installed, by the paths chrome-launcher looks at. */
function chromeInstalled() {
  const candidates = [process.env.CHROME_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.some((candidate) => candidate && existsSync(candidate));
}
