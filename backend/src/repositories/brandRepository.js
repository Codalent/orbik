/**
 * Reads and writes what a workspace's brand is made of.
 *
 * Three stores meet here, and each keeps its own rules. The observations are read-only: the
 * agents worker is their only writer, and a record of what Chrome saw that the API could edit
 * would no longer be one. The design system and the images go through the stores in
 * `@orbik/design-system` and `@orbik/assets`, which the worker writes through too, so neither
 * process has its own idea of what a pin means or where a picture lives.
 *
 * Every read is scoped by workspace in the query itself, so an observation or asset identifier is
 * never an authorization token.
 *
 * @param {object} dependencies collaborators
 * @param {object} dependencies.collections agent collections from `@orbik/core`
 * @param {ReturnType<import("@orbik/assets").createAssetStore>} dependencies.assetStore the images
 * @param {ReturnType<import("@orbik/design-system").createDesignSystemStore>} dependencies.designSystemStore the system and its pins
 * @param {ReturnType<import("@orbik/design-system").createBrandChangeLog>} dependencies.changeLog
 *   every change a person makes, with what it replaced
 */
export function createBrandRepository({ collections, assetStore, designSystemStore, changeLog }) {
  const observations = collections.designObservations;

  return {
    /** The newest record of what the rendered pages showed, or null when there has been no run. */
    findLatestObservation(workspaceId) {
      return observations.find({ workspaceId }).sort({ createdAt: -1 }).limit(1).next();
    },

    /** The newest observation without the measurements: which pages, and how each went. */
    findLatestObservationSummary(workspaceId) {
      return observations
        .find({ workspaceId }, { projection: { runId: 1, host: 1, createdAt: 1, pages: 1, pageSource: 1, chrome: 1, "assets.sheets": 1, "assets.seen": 1 } })
        .sort({ createdAt: -1 })
        .limit(1)
        .next();
    },

    /** The workspace's design system as stored, or null when none has been derived. */
    findSystem(workspaceId) {
      return designSystemStore.find(workspaceId);
    },

    /** Pins one value, recording the change. */
    setPin({ workspaceId, pointer, value, userId, via, host }) {
      return changeLog.pin({ workspaceId, pointer, value, userId, via, host });
    },

    /** Unpins one value, recording the change. */
    removePin({ workspaceId, pointer, userId }) {
      return changeLog.unpin({ workspaceId, pointer, userId });
    },

    /** Puts back what one change replaced. */
    undoChange({ workspaceId, changeId, userId }) {
      return changeLog.undo({ workspaceId, changeId, userId });
    },

    /** The changes some chat turns made, oldest first. */
    listChangesForRuns({ workspaceId, runIds }) {
      return changeLog.listForRuns({ workspaceId, runIds });
    },

    /** Stores one file in the brand: an upload, here. */
    putAsset({ workspaceId, kind, bytes, mimeType, meta, upload }) {
      return assetStore.put({ workspaceId, kind, bytes, mimeType, meta, upload });
    },

    /** The kept earlier versions of the system, newest first. */
    listRevisions(workspaceId) {
      return designSystemStore.listRevisions(workspaceId);
    },

    /** Puts the system back to a kept version, as a new version. */
    restoreRevision({ workspaceId, revision }) {
      return designSystemStore.restore({ workspaceId, revision });
    },

    /** A workspace's stored images, references first, optionally of some kinds only. */
    listAssets({ workspaceId, kinds = null, includeHidden = true }) {
      return assetStore.list({ workspaceId, kinds, includeHidden });
    },

    /** One stored image of a workspace, or null. */
    findAsset({ workspaceId, assetId }) {
      return assetStore.find({ workspaceId, assetId });
    },

    /** One stored image by its identifier alone, for a signed link, or null. */
    findAssetById(assetId) {
      return assetStore.findById(assetId);
    },

    /** Records what a person decided about one stored image, and the change. */
    updateAsset({ workspaceId, assetId, changes, userId }) {
      return changeLog.setAsset({ workspaceId, assetId, fields: changes, userId, via: { kind: "page" } });
    },

    /** The bytes of one stored image, as a stream. */
    openAsset(asset) {
      return assetStore.open(asset);
    },

    /** How many images a workspace holds, how large they are together, and the limits on both. */
    assetStats(workspaceId) {
      return assetStore.stats(workspaceId);
    },
  };
}
