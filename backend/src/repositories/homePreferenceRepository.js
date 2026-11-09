import { toObjectId } from "@orbik/core";

/**
 * Where a person's choices about a workspace's Home page are kept: which recommended steps they
 * skipped, and whether they hid the checklist.
 *
 * Named here rather than in `@orbik/core`'s collection list because only the API reads or writes
 * it: no agent, worker or outside AI has any business with how one person likes their Home page.
 */
export const HOME_PREFERENCES_COLLECTION = "workspace_home_preferences";

/**
 * Creates access to the Home page preferences: one row per person per workspace, made the first
 * time they skip a step or hide the checklist, and never otherwise.
 *
 * Kept on the server rather than in the browser so a skipped step stays skipped on the person's
 * phone and in the other browser they use at work. They are only ever presentation: none of them
 * changes where the workspace opens, which only the essentials decide.
 *
 * @param {import("mongodb").Db} database connected database
 * @param {() => Date} [now]
 */
export function createHomePreferenceRepository(database, now = () => new Date()) {
  const collection = database.collection(HOME_PREFERENCES_COLLECTION);
  const filterFor = (userId, workspaceId) => ({ workspaceId: toObjectId(workspaceId), userId: toObjectId(userId) });

  return {
    /**
     * The person's preferences for one workspace; the defaults when they have never set any.
     *
     * @returns {Promise<{skipped: string[], hidden: boolean, updatedAt: Date|null}>}
     */
    async find(userId, workspaceId) {
      const row = await collection.findOne(filterFor(userId, workspaceId), { projection: { skipped: 1, hidden: 1, updatedAt: 1 } });
      return { skipped: row?.skipped ?? [], hidden: row?.hidden === true, updatedAt: row?.updatedAt ?? null };
    },

    /**
     * Applies one change and returns the result.
     *
     * Each step is added or removed on its own (`$addToSet`/`$pull`) rather than the list being
     * replaced, so skipping one step in one tab and another in a second leaves both skipped.
     *
     * @param {object} change
     * @param {string[]} [change.skip] steps to mark skipped
     * @param {string[]} [change.unskip] steps to bring back
     * @param {boolean} [change.hidden] hide or show the checklist
     */
    async update(userId, workspaceId, { skip = [], unskip = [], hidden } = {}) {
      const filter = filterFor(userId, workspaceId);
      const at = now();
      const base = {
        $set: { updatedAt: at, ...(typeof hidden === "boolean" ? { hidden } : {}) },
        // The filter's two identifiers are written by the upsert itself.
        $setOnInsert: { createdAt: at },
      };
      // Two writes when a request both adds and removes, because MongoDB refuses `$addToSet` and
      // `$pull` on the same field in one update. A step named in both ends up brought back.
      await collection.updateOne(filter, { ...base, ...(skip.length ? { $addToSet: { skipped: { $each: skip } } } : {}) }, { upsert: true });
      if (unskip.length) await collection.updateOne(filter, { $pull: { skipped: { $in: unskip } }, $set: { updatedAt: at } });
      return this.find(userId, workspaceId);
    },
  };
}
