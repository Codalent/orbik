import Anthropic from "@anthropic-ai/sdk";
import { COLLECTIONS, log } from "@orbik/core";
import { MODEL_CATALOG, isSameModel } from "@orbik/protocol";

import { createLoop } from "../../runtime/loop.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
const FIRST_CHECK_MS = 5 * 60 * 1000;

/** How long one request for a page of the list may take; the SDK retries a failed one twice. */
const LIST_TIMEOUT_MS = 30_000;

/** The most models read from the list, so a provider that pages forever cannot hold the loop. */
const MAX_LISTED = 2_000;

/** The `system_state` document the last check is recorded in. */
export const CATALOG_CHECK_ID = "ai-models";

/** The server-extension event told when the findings differ from the last check's. */
export const CATALOG_FINDINGS_EVENT = "ai.catalog.findings.changed";

/** Anything shaped like an API key, cut from a failure before it is logged or stored. */
const KEY_LIKE = /\bsk-[A-Za-z0-9_*-]+/g;

/** An id's dated snapshot suffix, which is not part of its version. */
const SNAPSHOT_SUFFIX = /-\d{8}$/;

/**
 * Whether the model catalog has fallen behind the provider, checked once a day.
 *
 * New models never join the catalog on their own: the provider's model list gives a model's name
 * and date but no price, and every cost Orbik shows is worked out from the catalog. So instead the
 * scheduler compares the two once a day, when Anthropic is the reasoning provider and its key is
 * set, and says what it found:
 *
 * - `not-listed`: a model a tier offers that the provider no longer lists, so a run on that tier
 *   would fail;
 * - `newer`: a listed model in a family a tier offers (an Opus, a Sonnet, a Haiku) that is newer
 *   than the tier's model, by the date the provider gives, or by the version in its id when there
 *   is no date to compare.
 *
 * What it found is logged as a warning, recorded in `system_state` (`_id: "ai-models"`), and, when
 * it differs from what the last check found, told to the server extensions as
 * `ai.catalog.findings.changed`, so a deployment can tell somebody once rather than every day.
 * Somebody then adds the model with its price to the catalog (`packages/protocol/src/modelCatalog.js`)
 * and moves the tier to it.
 *
 * Nothing waits on it and nothing fails with it: a check that cannot list the models is logged and
 * recorded as failed, and tried again the next day. Several schedulers may share one database; the
 * day's check is claimed with one conditional update, so it is made once whichever claims it.
 *
 * @param {object} options
 * @param {import("mongodb").Db} options.database
 * @param {{aiProvider: string, anthropicApiKey: string}} options.config the agents' configuration
 * @param {{emit: (event: string, payload: object) => Promise<void>}} [options.events] the loaded
 *   extensions, told when the findings change
 * @param {Function} [options.logger]
 * @param {{models: {list: Function}}} [options.client] the provider's SDK client; one is built
 *   from the key when not given
 * @param {() => Date} [options.now]
 */
export function createModelCatalogCheck({ database, config, events = null, logger = log, client = null, now = () => new Date() }) {
  const state = database.collection(COLLECTIONS.systemState);
  const enabled = config.aiProvider === "anthropic" && Boolean(config.anthropicApiKey);
  let anthropic = client;
  let waited = false;

  /** Claims today's check, or returns false when one was made less than a day ago. */
  async function claim() {
    const current = now();
    await state.updateOne({ _id: CATALOG_CHECK_ID }, { $setOnInsert: { createdAt: current } }, { upsert: true });
    const claimed = await state.findOneAndUpdate(
      { _id: CATALOG_CHECK_ID, $or: [{ claimedAt: { $exists: false } }, { claimedAt: { $lte: new Date(current.getTime() - DAY_MS) } }] },
      { $set: { claimedAt: current } },
      { returnDocument: "after" },
    );
    return Boolean(claimed);
  }

  /**
   * Makes one check now, records it, and tells the extensions when its findings changed.
   *
   * @param {object} [options]
   * @param {boolean} [options.force] make it even if today's was made: the command run by hand
   * @returns {Promise<{skipped: string} | {failed: string} | {provider: string, listed: number,
   *   findings: object[], changed: boolean}>}
   */
  async function check({ force = false } = {}) {
    if (!enabled) {
      return { skipped: config.aiProvider === "anthropic" ? "ORBIK_ANTHROPIC_API_KEY is not set." : `The reasoning provider is ${config.aiProvider}, not anthropic.` };
    }
    if (!force && !(await claim())) return { skipped: "Checked less than a day ago." };

    const provider = config.aiProvider;
    const checkedAt = now();
    let listed;
    try {
      anthropic ??= new Anthropic({ apiKey: config.anthropicApiKey });
      listed = await listProviderModels(anthropic);
    } catch (error) {
      const message = String(error?.message ?? "unknown").replace(KEY_LIKE, "[key]").replace(/\s+/g, " ").slice(0, 300);
      logger("warn", "ai.catalog_check_failed", { provider, message });
      await record({ $set: { provider, lastFailure: { at: checkedAt, message } } });
      return { failed: message };
    }

    const findings = compareWithCatalog({ provider, listed });
    const before = await state.findOne({ _id: CATALOG_CHECK_ID }, { projection: { findings: 1 } }).catch(() => null);
    const previous = Array.isArray(before?.findings) ? before.findings : [];
    const changed = fingerprint(findings) !== fingerprint(previous);
    await record({
      $set: {
        provider,
        checkedAt,
        listed: listed.length,
        findings,
        lastFailure: null,
        ...(changed ? { findingsChangedAt: checkedAt } : {}),
      },
    });

    if (findings.length) {
      logger("warn", "ai.catalog_out_of_date", { provider, findings: findings.map(describeFinding) });
    } else {
      logger("info", "ai.catalog_checked", { provider, listed: listed.length });
    }
    // The extensions' host never throws out of an event; nothing here waits on what they do.
    if (changed && events) {
      await events.emit(CATALOG_FINDINGS_EVENT, { provider, findings, previous, checkedAt: checkedAt.toISOString() });
    }
    return { provider, listed: listed.length, findings, changed };
  }

  /** Writes to the record; a failed write is logged and changes nothing else. */
  async function record(update) {
    try {
      await state.updateOne({ _id: CATALOG_CHECK_ID }, update, { upsert: true });
    } catch (error) {
      logger("warn", "ai.catalog_check_not_recorded", { message: error?.message ?? "unknown" });
    }
  }

  return {
    check,

    /**
     * The loop the scheduler runs, or null when Anthropic is not the provider or has no key. It
     * looks every hour whether a day has passed since the last check; the first look waits a few
     * minutes, so a scheduler restarted in a loop does not ask the provider on every start.
     */
    loop: enabled
      ? createLoop({
        name: "catalogCheck",
        intervalMs: () => (waited ? CHECK_EVERY_MS : FIRST_CHECK_MS),
        tick: async () => {
          if (!waited) {
            waited = true;
            return;
          }
          await check();
        },
        logger,
        startedContext: { provider: config.aiProvider, everyHours: 24 },
      })
      : null,
  };
}

/**
 * Every model the provider lists, through the SDK, which pages through the list itself.
 *
 * @param {{models: {list: Function}}} client
 * @returns {Promise<Array<{id: string, name: string, createdAt: string|null}>>}
 */
export async function listProviderModels(client) {
  const models = [];
  for await (const model of client.models.list({ limit: 100 }, { timeout: LIST_TIMEOUT_MS })) {
    if (typeof model?.id !== "string") continue;
    models.push({ id: model.id, name: typeof model.display_name === "string" ? model.display_name : model.id, createdAt: model.created_at ?? null });
    if (models.length >= MAX_LISTED) break;
  }
  return models;
}

/**
 * What the provider's list says about the catalog: each tier model it no longer lists, and each
 * listed model newer than a tier's model of the same family. Sorted, so the same findings always
 * compare equal.
 *
 * @param {object} options
 * @param {string} options.provider the catalog's provider key
 * @param {Array<{id: string, name: string, createdAt: string|null}>} options.listed
 * @returns {object[]} findings: `{kind: "not-listed", model, name, tier}` or `{kind: "newer",
 *   model, name, createdAt, family, tier, catalogModel}`
 */
export function compareWithCatalog({ provider, listed }) {
  const catalog = MODEL_CATALOG[provider];
  if (!catalog?.family) return [];
  const findings = [];
  const listedAs = (model) => listed.find((entry) => isSameModel(entry.id, model)) ?? null;

  for (const { tier, model, name } of catalog.tiers) {
    if (!listedAs(model)) findings.push({ kind: "not-listed", model, name, tier });
  }

  const byFamily = new Map(catalog.tiers.map((offered) => [familyOf(catalog, offered.model), offered]));
  for (const entry of listed) {
    const family = familyOf(catalog, entry.id);
    const offered = family ? byFamily.get(family) : null;
    if (!offered || isSameModel(entry.id, offered.model)) continue;
    if (!isNewer(entry, listedAs(offered.model), offered.model)) continue;
    findings.push({
      kind: "newer",
      model: entry.id,
      name: entry.name,
      createdAt: entry.createdAt,
      family,
      tier: offered.tier,
      catalogModel: offered.model,
    });
  }
  return findings.sort((a, b) => `${a.kind} ${a.model}`.localeCompare(`${b.kind} ${b.model}`));
}

/** A model's family, by the provider's pattern: `opus` for `claude-opus-5-5`. */
function familyOf(catalog, id) {
  return catalog.family.exec(id)?.[1] ?? null;
}

/**
 * Whether a listed model is newer than a tier's: by the dates the provider gives both, or, when it
 * gives no real date for one of them (the epoch stands for an unknown one), by the version in the
 * id, `claude-opus-6` after `claude-opus-5-5`.
 */
function isNewer(entry, current, currentId) {
  const released = timeOf(entry.createdAt);
  const currentReleased = timeOf(current?.createdAt);
  if (released && currentReleased) return released > currentReleased;
  return compareVersions(versionOf(entry.id), versionOf(currentId)) > 0;
}

/** A date's time, or 0 for a missing, unreadable or epoch one. */
function timeOf(value) {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 ? time : 0;
}

/** The numbers after an id's family: `[5, 5]` for `claude-opus-5-5`, without a snapshot date. */
function versionOf(id) {
  const parts = id.replace(SNAPSHOT_SUFFIX, "").split("-").slice(2);
  const numbers = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) break;
    numbers.push(Number(part));
  }
  return numbers;
}

function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/** What makes two lists of findings the same: which models, found for which reason. */
function fingerprint(findings) {
  return JSON.stringify(findings.map((finding) => `${finding.kind}:${finding.model}`).sort());
}

/** A finding in one line, for the log. */
export function describeFinding(finding) {
  return finding.kind === "not-listed"
    ? `${finding.model} (the ${finding.tier} tier) is no longer listed by the provider`
    : `${finding.model} (${finding.name}) is newer than ${finding.catalogModel}, the ${finding.tier} tier's ${finding.family}`;
}
