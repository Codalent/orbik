import { AGENT_COLLECTIONS, toObjectId } from "@orbik/core";
import { ObjectId } from "mongodb";

import { readPointer } from "./pins.js";
import { DesignSystemError, cleanVia } from "./store.js";

/** The asset fields a change may set, and therefore the ones an undo puts back. */
const ASSET_FIELDS = Object.freeze(["isReference", "hidden", "kind", "caption", "label", "variant", "tone"]);

/** Changes listed for one turn of the chat, or one listing. */
const MAX_LISTED = 100;

/**
 * Every change a person makes to a brand, with what it replaced, so each can be shown and undone.
 *
 * A pin already keeps the agent's value underneath it, so unpinning gives the website back. What
 * it does not keep is the *person's* earlier value — the orange they set last week before the
 * brand guide changed it — and the chat needs exactly that: a card that says "#E64B18 → #E5501C"
 * and an Undo that puts #E64B18 back, whoever set it. So every change made through here is
 * recorded beside the system: where, before, after, who, how, and in which chat turn.
 *
 * Both writers go through this: the API for a change on the Brand page or an undo, the brand
 * chat's tools in the worker for what it decides. The pins themselves are still written by the
 * design-system store, which stays the one implementation of what a pin is.
 *
 * @param {object} dependencies collaborators
 * @param {import("mongodb").Db} dependencies.database connected database
 * @param {ReturnType<import("./store.js").createDesignSystemStore>} dependencies.designSystemStore
 * @param {object} dependencies.assetStore the brand's asset store (`find`, `update`)
 * @param {() => Date} [dependencies.now] clock
 */
export function createBrandChangeLog({ database, designSystemStore, assetStore, now = () => new Date() }) {
  const changes = database.collection(AGENT_COLLECTIONS.brandChanges);

  async function record(entry) {
    const row = { _id: new ObjectId(), ...entry, at: now(), undoneAt: null, undoneBy: null };
    await changes.insertOne(row);
    return row;
  }

  /** The pin a document holds at a pointer, as a change remembers it, or null. */
  function pinAt(document, pointer) {
    const pin = (document?.pins ?? []).find((entry) => entry.pointer === pointer);
    return pin ? { value: pin.value, via: pin.via ?? null } : null;
  }

  /**
   * Refuses to undo a change something later changed again: putting the old value back would
   * silently throw the later one away.
   */
  async function requireLatest(change) {
    const filter = { workspaceId: change.workspaceId, at: { $gt: change.at }, undoneAt: null };
    const later = change.kind === "asset"
      ? await changes.findOne({ ...filter, kind: "asset", assetId: change.assetId, fields: { $in: Object.keys(change.before ?? {}) } })
      : await changes.findOne({ ...filter, kind: { $in: ["pin", "unpin"] }, pointer: change.pointer });
    if (later) {
      throw new DesignSystemError({ code: "CHANGED_SINCE", message: "This was changed again afterwards. Undo the later change first." });
    }
  }

  const log = {
    /**
     * Sets one value of the system and records the change.
     *
     * A brand with nothing derived yet is started empty first (`ensureSystem`), so a logo or a
     * colour can be set before — or without — the site being read.
     *
     * @returns {Promise<{document: object, change: object}>}
     */
    async pin({ workspaceId, pointer, value, userId, via = null, runId = null, host = null }) {
      let current = await designSystemStore.find(workspaceId);
      if (!current?.proposal) current = await designSystemStore.ensureSystem({ workspaceId, host });
      const before = { value: readPointer(current?.system, pointer) ?? null, pin: pinAt(current, pointer) };
      const document = await designSystemStore.setPin({ workspaceId, pointer, value, userId, via });
      const after = { value: readPointer(document.system, pointer) ?? null, pin: pinAt(document, pointer) };
      const change = await record({
        workspaceId: toObjectId(workspaceId),
        kind: "pin",
        pointer,
        before,
        after,
        via: cleanVia(via),
        userId: userId ? toObjectId(userId) : null,
        runId: runId ? toObjectId(runId) : null,
      });
      return { document, change };
    },

    /** Hands one value back to what the website says, and records the change. */
    async unpin({ workspaceId, pointer, userId, via = null, runId = null }) {
      const current = await designSystemStore.find(workspaceId);
      const before = { value: readPointer(current?.system, pointer) ?? null, pin: pinAt(current, pointer) };
      const document = await designSystemStore.removePin({ workspaceId, pointer });
      const after = { value: readPointer(document.system, pointer) ?? null, pin: null };
      const change = await record({
        workspaceId: toObjectId(workspaceId),
        kind: "unpin",
        pointer,
        before,
        after,
        via: cleanVia(via),
        userId: userId ? toObjectId(userId) : null,
        runId: runId ? toObjectId(runId) : null,
      });
      return { document, change };
    },

    /**
     * Changes what is recorded about one image — its kind, caption, label, form, which background
     * it is for, whether it is set aside — and records what it was before.
     *
     * @returns {Promise<{asset: object, change: object}|null>} null when there is no such asset
     */
    async setAsset({ workspaceId, assetId, fields, userId, via = null, runId = null }) {
      const existing = await assetStore.find({ workspaceId, assetId });
      if (!existing) return null;
      const wanted = Object.fromEntries(Object.entries(fields).filter(([field]) => ASSET_FIELDS.includes(field)));
      const before = Object.fromEntries(Object.keys(wanted).map((field) => [field, existing[field] ?? null]));
      const asset = await assetStore.update({ workspaceId, assetId, changes: wanted });
      const after = Object.fromEntries(Object.keys(wanted).map((field) => [field, asset?.[field] ?? null]));
      const change = await record({
        workspaceId: toObjectId(workspaceId),
        kind: "asset",
        assetId: existing._id,
        fields: Object.keys(wanted),
        before,
        after,
        via: cleanVia(via),
        userId: userId ? toObjectId(userId) : null,
        runId: runId ? toObjectId(runId) : null,
      });
      return { asset, change };
    },

    /**
     * Puts back what one change replaced.
     *
     * A pin that was there before is set again with its own value and its own source; a value
     * that was the website's goes back to the website's. An undone change stays listed, marked
     * undone, so the chat still shows what was done and then taken back.
     *
     * @throws {DesignSystemError} `CHANGE_MISSING`, `CHANGED_SINCE`
     */
    async undo({ workspaceId, changeId, userId }) {
      if (!ObjectId.isValid(changeId)) throw new DesignSystemError({ code: "CHANGE_MISSING", message: "That change was not found." });
      const change = await changes.findOne({ _id: new ObjectId(changeId), workspaceId: toObjectId(workspaceId) });
      if (!change) throw new DesignSystemError({ code: "CHANGE_MISSING", message: "That change was not found." });
      if (change.undoneAt) return { change, document: null, asset: null };
      await requireLatest(change);

      let document = null;
      let asset = null;
      if (change.kind === "asset") {
        asset = await assetStore.update({ workspaceId, assetId: change.assetId.toHexString(), changes: change.before ?? {} });
      } else if (change.before?.pin) {
        document = await designSystemStore.setPin({ workspaceId, pointer: change.pointer, value: change.before.pin.value, userId, via: change.before.pin.via });
      } else {
        document = await designSystemStore.removePin({ workspaceId, pointer: change.pointer });
      }
      const undone = await changes.findOneAndUpdate(
        { _id: change._id },
        { $set: { undoneAt: now(), undoneBy: userId ? toObjectId(userId) : null } },
        { returnDocument: "after" },
      );
      return { change: undone, document, asset };
    },

    /** The changes a set of chat turns made, oldest first, for showing under each answer. */
    listForRuns({ workspaceId, runIds }) {
      const ids = runIds.filter((id) => ObjectId.isValid(String(id))).map((id) => toObjectId(id));
      if (!ids.length) return [];
      return changes.find({ workspaceId: toObjectId(workspaceId), runId: { $in: ids } }).sort({ at: 1 }).limit(MAX_LISTED * ids.length).toArray();
    },

    /** One change, or null. */
    find({ workspaceId, changeId }) {
      if (!ObjectId.isValid(changeId)) return null;
      return changes.findOne({ _id: new ObjectId(changeId), workspaceId: toObjectId(workspaceId) });
    },

    /** Removes every change a workspace recorded, when the workspace is deleted. */
    async purgeWorkspace(workspaceId) {
      const removed = await changes.deleteMany({ workspaceId: toObjectId(workspaceId) });
      return removed.deletedCount;
    },
  };
  return log;
}
