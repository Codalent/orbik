import { AGENT_COLLECTIONS, BRAND_LIMITS, toObjectId } from "@orbik/core";

import { applyPins, readPointer, validatePin } from "./pins.js";
import { annotateSystem } from "./system.js";

/** How many differences between two proposals one system records as "what changed". */
const MAX_CHANGES = 40;

/**
 * The last segments of a pointer whose value is prose about a token rather than the token.
 *
 * Left out of "what changed": a re-worded usage note is the model phrasing the same thing again,
 * and listing it beside a primary colour that really did move would bury the one that matters.
 */
const PROSE_FIELDS = Object.freeze(new Set([
  "usage", "usedFor", "notes", "observedFrom", "source", "summary", "description", "style", "adjectives", "rules", "doNot",
  "undetermined", "stylePrefix", "negative",
  // The graphics language is prose from end to end; only its medium is a value.
  "subjects", "paletteUsage", "strokeAndShading", "perspective", "composition", "peopleDepiction", "texture", "mood",
  "strokeWeight", "corner", "fill",
]));

/** How many times a pin is retried when a derivation or another pin landed in between. */
const PIN_ATTEMPTS = 4;

/**
 * Raised when something asks the store for a thing that is not there, or to do what it cannot.
 *
 * Carries a stable code, as the Library's error does and for the same reason: the API turns it
 * into an HTTP failure and the MCP tools into a result a model reads, and neither may invent its
 * own.
 */
export class DesignSystemError extends Error {
  /**
   * @param {object} options failure detail
   * @param {string} options.code stable upper-case code, e.g. `DESIGN_SYSTEM_MISSING`
   * @param {string} options.message safe description, written for a person and a model to read
   */
  constructor({ code, message }) {
    super(message);
    this.name = "DesignSystemError";
    this.code = code;
  }
}

/**
 * A workspace's design system: the one document two writers share.
 *
 * The agents worker writes the **proposal** — what the agent worked out from the site — and a
 * person, through the API, writes **pins**. Neither writes the other's, and the **system** both
 * are read through is the two laid together: `system = pins over proposal`, recomputed whenever
 * either moves. That is the whole of the arrangement, and it is why a pin survives every
 * derivation without the agent having to be told about it: the agent replaces `proposal`, and the
 * pins are applied again on top.
 *
 * It lives in this package rather than in either process for the reason the Library's store does:
 * two doors into one document need one implementation of what the document means.
 *
 * @param {object} dependencies collaborators
 * @param {import("mongodb").Db} dependencies.database connected database
 * @param {() => Date} [dependencies.now] clock; defaults to the system clock
 */
export function createDesignSystemStore({ database, now = () => new Date() }) {
  const systems = database.collection(AGENT_COLLECTIONS.designSystems);
  const revisions = database.collection(AGENT_COLLECTIONS.designSystemRevisions);

  /** The system that results from a proposal and some pins, with its worked-out figures. */
  function effective(proposal, pins) {
    return annotateSystem(applyPins(proposal, pins));
  }

  /** Keeps one earlier version of a workspace's system, and forgets the oldest past the limit. */
  async function keepRevision(document, reason) {
    if (!document?.proposal) return;
    await revisions.updateOne(
      { workspaceId: document.workspaceId, revision: document.revision },
      {
        $set: {
          proposal: document.proposal,
          pins: document.pins ?? [],
          system: document.system,
          synthesis: document.synthesis ?? null,
          host: document.host ?? null,
          runId: document.runId ?? null,
          derivedAt: document.derivedAt ?? null,
          reason,
          savedAt: now(),
        },
        $setOnInsert: { workspaceId: document.workspaceId, revision: document.revision },
      },
      { upsert: true },
    );
    const stale = await revisions
      .find({ workspaceId: document.workspaceId })
      .project({ _id: 1 })
      .sort({ revision: -1 })
      .skip(BRAND_LIMITS.revisions)
      .toArray();
    if (stale.length) await revisions.deleteMany({ _id: { $in: stale.map((row) => row._id) } });
  }

  /** Changes a workspace's pins, retrying when the document moved underneath. */
  async function changePins(workspaceId, change) {
    const workspace = toObjectId(workspaceId);
    for (let attempt = 0; attempt < PIN_ATTEMPTS; attempt += 1) {
      const current = await systems.findOne({ workspaceId: workspace });
      if (!current?.proposal) {
        throw new DesignSystemError({ code: "DESIGN_SYSTEM_MISSING", message: "There is no design system to pin a value on yet. Derive one first." });
      }
      const pins = change(current.pins ?? [], current);
      // The write is conditional on the version read, so a derivation that replaced the proposal
      // in between is not overwritten with a system computed from the old one.
      const updated = await systems.findOneAndUpdate(
        { _id: current._id, version: current.version },
        { $set: { pins, system: effective(current.proposal, pins), updatedAt: now() }, $inc: { version: 1 } },
        { returnDocument: "after" },
      );
      if (updated) return updated;
    }
    throw new DesignSystemError({ code: "DESIGN_SYSTEM_BUSY", message: "The design system changed while that was being saved. Try again." });
  }

  return {
    /** A workspace's design system, or null when none has been derived. */
    find(workspaceId) {
      return systems.findOne({ workspaceId: toObjectId(workspaceId) });
    },

    /**
     * Stores what a derivation proposed, keeping every pin and the version it replaces.
     *
     * The previous version goes into the history first, so a derivation that turns out worse than
     * the one before can be put back. The pins are read in the same write that replaces the
     * proposal, so a pin set while the run was rendering is laid over the new proposal rather than
     * lost to it.
     *
     * @param {object} input
     * @param {unknown} input.workspaceId owning workspace
     * @param {unknown} [input.siteId] the crawl site it was derived from
     * @param {string} input.host the site's host
     * @param {unknown} input.runId the run that derived it
     * @param {unknown} input.observationId the observation it was derived from
     * @param {number} input.agentVersion the definition version
     * @param {string|null} input.styleFingerprint what the styling hashed to; null when the
     *   derivation is incomplete and the next run should try again
     * @param {object} input.proposal the system as the agent proposed it
     * @param {object} input.synthesis what became of each model call
     * @param {object[]} input.pages the pages it was derived from
     * @returns {Promise<object>} the stored document
     */
    async saveDerivation({ workspaceId, siteId = null, host, runId, observationId, agentVersion, styleFingerprint, proposal, synthesis, pages }) {
      const workspace = toObjectId(workspaceId);
      for (let attempt = 0; attempt < PIN_ATTEMPTS; attempt += 1) {
        const current = await systems.findOne({ workspaceId: workspace });
        const sameRun = current?.runId && String(current.runId) === String(runId);
        // A job handed back after a crash rewrites its own derivation, and must not file the
        // half-written one it is replacing as an earlier version.
        if (current && !sameRun) await keepRevision(current, "derivation");
        const at = now();
        const pins = current?.pins ?? [];
        const content = {
          siteId: siteId ? toObjectId(siteId) : null,
          host,
          runId: toObjectId(runId),
          observationId: toObjectId(observationId),
          agentVersion,
          styleFingerprint,
          proposal,
          pins,
          system: effective(proposal, pins),
          synthesis,
          pages,
          changes: sameRun ? current.changes ?? [] : diffProposals(current?.proposal ?? null, proposal),
          previousDerivedAt: sameRun ? current.previousDerivedAt ?? null : current?.derivedAt ?? null,
          lastAttempt: null,
          derivedAt: at,
          updatedAt: at,
        };
        try {
          const stored = await systems.findOneAndUpdate(
            current ? { _id: current._id, version: current.version } : { workspaceId: workspace },
            {
              $set: { ...content, revision: sameRun ? current.revision : (current?.revision ?? 0) + 1 },
              $inc: { version: 1 },
              $setOnInsert: { workspaceId: workspace, createdAt: at },
            },
            { upsert: !current, returnDocument: "after" },
          );
          if (stored) return stored;
        } catch (error) {
          // Two first derivations raced to the insert and the unique index let one through.
          if (error?.code !== 11000) throw error;
        }
      }
      throw new DesignSystemError({ code: "DESIGN_SYSTEM_BUSY", message: "The design system changed while the derivation was being stored." });
    },

    /**
     * Records a derivation that observed the site and could not propose a system from it.
     *
     * The system that is there stays exactly as it was — a deployment without a model must not
     * lose the proposal a deployment with one wrote — and what is recorded is that an attempt was
     * made, when, and why it produced nothing. The fingerprint is left alone, so the next run does
     * not mistake "tried and failed at this styling" for "derived at this styling".
     */
    async recordAttempt({ workspaceId, siteId = null, host, runId, observationId, synthesis }) {
      const workspace = toObjectId(workspaceId);
      const at = now();
      return systems.findOneAndUpdate(
        { workspaceId: workspace },
        {
          $set: { lastAttempt: { runId: toObjectId(runId), observationId: toObjectId(observationId), synthesis, at }, updatedAt: at },
          $inc: { version: 1 },
          $setOnInsert: {
            workspaceId: workspace,
            siteId: siteId ? toObjectId(siteId) : null,
            host,
            revision: 0,
            proposal: null,
            pins: [],
            system: null,
            synthesis: null,
            styleFingerprint: null,
            pages: [],
            changes: [],
            derivedAt: null,
            createdAt: at,
          },
        },
        { upsert: true, returnDocument: "after" },
      );
    },

    /**
     * Pins one value: from now on it is what a person set, whatever the agent proposes.
     *
     * @param {object} input
     * @param {unknown} input.workspaceId owning workspace
     * @param {string} input.pointer where in the system, as a JSON pointer
     * @param {unknown} input.value what to set there
     * @param {unknown} input.userId who set it
     * @param {object} [input.via] where it came from: `{kind: "page"|"chat"|"upload", assetId?,
     *   fileName?, page?}` — shown beside the value, so a person can tell "from the guide, p. 6"
     *   from "you said so"
     * @returns {Promise<object>} the stored document
     * @throws {DesignSystemError} `PIN_INVALID`, `DESIGN_SYSTEM_MISSING`, `DESIGN_SYSTEM_BUSY`
     */
    async setPin({ workspaceId, pointer, value, userId, via = null }) {
      const checked = validatePin(pointer, value);
      if (!checked.ok) throw new DesignSystemError({ code: "PIN_INVALID", message: checked.message });
      const pin = { pointer: checked.pointer, value: checked.value, pinnedAt: now(), by: toObjectId(userId), via: cleanVia(via) };
      return changePins(workspaceId, (pins) => [...pins.filter((entry) => entry.pointer !== pin.pointer), pin]);
    },

    /**
     * Makes sure a workspace has a system a pin can be laid on, starting an empty one when nothing
     * has been derived: a person who uploads a logo or a brand guide before the site is crawled —
     * or for a site that cannot be crawled — still gets a brand, built from what they gave.
     *
     * The empty proposal claims nothing: every value in the system it yields is a pin. A later
     * derivation replaces it as it replaces any proposal, and the pins are laid over that.
     *
     * @returns {Promise<object>} the stored document, as it now is
     */
    async ensureSystem({ workspaceId, host = null }) {
      const workspace = toObjectId(workspaceId);
      const current = await systems.findOne({ workspaceId: workspace });
      if (current?.proposal) return current;
      const at = now();
      const proposal = emptyProposal();
      const pins = current?.pins ?? [];
      return systems.findOneAndUpdate(
        { workspaceId: workspace, proposal: current ? null : { $exists: false } },
        {
          $set: { proposal, pins, system: effective(proposal, pins), updatedAt: at, startedFromUploads: true },
          $inc: { version: 1 },
          $setOnInsert: { workspaceId: workspace, host, revision: 1, synthesis: null, styleFingerprint: null, pages: [], changes: [], derivedAt: null, createdAt: at },
        },
        { upsert: !current, returnDocument: "after" },
      ).then((stored) => stored ?? systems.findOne({ workspaceId: workspace }));
    },

    /** Unpins one value, handing it back to the agent: the system shows what was proposed again. */
    async removePin({ workspaceId, pointer }) {
      return changePins(workspaceId, (pins) => pins.filter((entry) => entry.pointer !== pointer));
    },

    /** A workspace's earlier systems, newest first, without their contents. */
    async listRevisions(workspaceId) {
      return revisions
        .find({ workspaceId: toObjectId(workspaceId) })
        .project({ revision: 1, reason: 1, savedAt: 1, derivedAt: 1, host: 1, runId: 1, "pins.pointer": 1 })
        .sort({ revision: -1 })
        .limit(BRAND_LIMITS.revisions)
        .toArray();
    },

    /**
     * Puts the system back to one of its kept versions, as a new version.
     *
     * Forward rather than backward, as a Library restore is: the version being replaced is kept
     * first, so restoring is itself something that can be undone. The proposal and the pins come
     * back together, because that pair is what the system was.
     *
     * @throws {DesignSystemError} `REVISION_MISSING`
     */
    async restore({ workspaceId, revision }) {
      const workspace = toObjectId(workspaceId);
      const kept = await revisions.findOne({ workspaceId: workspace, revision });
      if (!kept) {
        throw new DesignSystemError({ code: "REVISION_MISSING", message: `Version ${revision} of the design system is no longer kept.` });
      }
      for (let attempt = 0; attempt < PIN_ATTEMPTS; attempt += 1) {
        const current = await systems.findOne({ workspaceId: workspace });
        if (!current) break;
        await keepRevision(current, "restore");
        const updated = await systems.findOneAndUpdate(
          { _id: current._id, version: current.version },
          {
            $set: {
              proposal: kept.proposal,
              pins: kept.pins ?? [],
              system: effective(kept.proposal, kept.pins ?? []),
              changes: diffProposals(current.proposal, kept.proposal),
              restoredFrom: revision,
              revision: current.revision + 1,
              updatedAt: now(),
            },
            $inc: { version: 1 },
          },
          { returnDocument: "after" },
        );
        if (updated) return updated;
      }
      throw new DesignSystemError({ code: "DESIGN_SYSTEM_BUSY", message: "The design system changed while that was being restored. Try again." });
    },
  };
}

/** The kinds of place a pin can come from. */
const VIA_KINDS = Object.freeze(["page", "chat", "upload"]);

/**
 * Where a pin came from, clipped to what a pin should carry. Unknown kinds become `page`: a value
 * set without saying how was set by hand.
 */
export function cleanVia(via) {
  if (!via || typeof via !== "object") return { kind: "page" };
  const kind = VIA_KINDS.includes(via.kind) ? via.kind : "page";
  const clean = { kind };
  if (typeof via.assetId === "string" && /^[0-9a-f]{24}$/.test(via.assetId)) clean.assetId = via.assetId;
  if (typeof via.fileName === "string" && via.fileName.trim()) clean.fileName = via.fileName.trim().slice(0, 200);
  if (Number.isInteger(via.page) && via.page > 0 && via.page < 10_000) clean.page = via.page;
  return clean;
}

/**
 * A proposal with nothing in it, for a brand started from uploads.
 *
 * The parts every reader walks are present and empty, so nothing has to ask whether they exist;
 * each value a person pins fills its own place in it.
 */
export function emptyProposal() {
  return {
    colors: {},
    typography: { families: {}, scale: {}, rules: [] },
    spacing: { base: null, scale: [], containerMaxWidth: null, sectionPadding: null },
    shape: { radius: {}, borderWidth: null, shadows: {} },
    components: { button: {} },
    personality: null,
    rules: [],
    graphics: null,
    logos: { primary: null },
    undetermined: [],
  };
}

/**
 * What moved between one proposal and the next, token by token.
 *
 * Only values are compared — a colour, a size, a family, a recipe's choice — and never the prose
 * around them, so the list reads as "the primary went from this to that" rather than as a diff of
 * two paragraphs a model wrote on different days.
 *
 * @param {object|null} before the earlier proposal
 * @param {object} after the later one
 * @returns {Array<{pointer: string, from: unknown, to: unknown}>} null on either side means absent
 */
export function diffProposals(before, after) {
  if (!before || !after) return [];
  const changes = [];
  const pointers = new Set([...leavesOf(before), ...leavesOf(after)]);
  for (const pointer of pointers) {
    if (changes.length >= MAX_CHANGES) break;
    const from = readPointer(before, pointer) ?? null;
    const to = readPointer(after, pointer) ?? null;
    // A part that exists on one side only is reported through its own values, not as a whole.
    if (isHolder(from) || isHolder(to)) continue;
    if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ pointer, from, to });
  }
  return changes;
}

/** Whether a value holds other values rather than being one. */
function isHolder(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The pointers of a proposal's token values: every leaf that is not prose about a token. */
function leavesOf(value, pointer = "", found = []) {
  if (value === null || typeof value !== "object") {
    found.push(pointer);
    return found;
  }
  if (Array.isArray(value)) {
    // A list of numbers is one value — a spacing scale; a list of anything else is prose.
    if (value.every((entry) => typeof entry === "number")) found.push(pointer);
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    if (PROSE_FIELDS.has(key) || key === "pinned" || key === "oklch" || key === "contrastOn") continue;
    leavesOf(child, `${pointer}/${key}`, found);
  }
  return found;
}
