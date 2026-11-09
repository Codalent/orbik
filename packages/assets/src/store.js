import { createHash } from "node:crypto";

import { AGENT_COLLECTIONS, BRAND_ASSET_ORIGINS, BRAND_LIMITS, BRAND_UPLOAD_LIMITS, toObjectId } from "@orbik/core";
import { GridFSBucket, ObjectId } from "mongodb";

/**
 * The GridFS bucket the bytes are kept in.
 *
 * GridFS writes two collections under this name, `brand_assets_files.files` and
 * `brand_assets_files.chunks`, and maintains their indexes itself.
 */
const ASSET_BUCKET = "brand_assets_files";

/** The fields of an asset a person may set, and which a later run therefore leaves alone. */
const PERSON_FIELDS = Object.freeze(["isReference", "hidden", "kind", "caption", "label", "variant", "tone"]);

/**
 * What a listing leaves out: a guide's text, which can be a few hundred kilobytes and is read only
 * when somebody asks for that one guide.
 */
const LIST_PROJECTION = Object.freeze({ "document.text": 0 });

/** Whether an asset came from a person's upload, which no run may remove. */
const UPLOADED = { origin: BRAND_ASSET_ORIGINS.upload };

/**
 * The binary store behind a workspace's brand: its logos, images, screenshots and specimen.
 *
 * Nothing else in Orbik stores a file, so this is deliberately small and deliberately replaceable.
 * The interface is five verbs — put, find, read, change, remove — over a metadata row and some
 * bytes, and the first implementation keeps the bytes in MongoDB GridFS: no new infrastructure,
 * and it works on every machine that already runs Orbik. A deployment that outgrows that puts an
 * object store behind the same five verbs, and nothing that calls them changes.
 *
 * **An image is stored once per workspace.** The row is unique on `(workspaceId, hash)`, where the
 * hash is of the bytes, so a run that harvests the same logo it found last week refreshes the row
 * — which run last saw it, on which page — instead of storing the picture again. That is also what
 * keeps a person's decisions about an image attached to it: "use this as a reference" is a fact
 * about the picture, and survives every run that finds the same picture.
 *
 * **What a person set is theirs.** `pinnedFields` names the fields somebody changed by hand. A run
 * refreshes everything else and never those, the same bargain the Library's protected blocks make.
 *
 * @param {object} dependencies collaborators
 * @param {import("mongodb").Db} dependencies.database connected database
 * @param {() => Date} [dependencies.now] clock; defaults to the system clock
 */
export function createAssetStore({ database, now = () => new Date() }) {
  const assets = database.collection(AGENT_COLLECTIONS.brandAssets);
  const bucket = new GridFSBucket(database, { bucketName: ASSET_BUCKET });

  /** Writes the bytes under the asset's own identifier, so the row and the file share one key. */
  function writeBytes(id, bytes, { mimeType, workspaceId }) {
    return new Promise((resolve, reject) => {
      const stream = bucket.openUploadStreamWithId(id, id.toHexString(), {
        metadata: { workspaceId, mimeType },
      });
      stream.once("error", reject);
      stream.once("finish", resolve);
      stream.end(bytes);
    });
  }

  /** Removes the bytes, treating a file that is already gone as removed. */
  async function discard(id) {
    try {
      await bucket.delete(id);
    } catch (error) {
      // The driver reports a missing file as a plain error; a file that is not there is the
      // outcome that was wanted.
      if (!/file not found/i.test(String(error?.message ?? ""))) throw error;
    }
  }

  const store = {
    /**
     * Stores one image, or recognises one this workspace already holds.
     *
     * The bytes go in first and the row second, so a crash between the two leaves bytes nobody
     * references rather than a row whose picture is missing — the first is swept by
     * {@link sweepOrphans}, the second would be a broken image on a page.
     *
     * @param {object} input
     * @param {unknown} input.workspaceId owning workspace
     * @param {unknown} [input.runId] the run that found it
     * @param {string} input.kind one of `BRAND_ASSET_KINDS`
     * @param {Buffer} input.bytes the file
     * @param {string} input.mimeType e.g. `image/webp`, `image/svg+xml`
     * @param {object} [input.meta] `width`, `height`, `sourceUrl`, `pageUrl`, `position`, `alt`,
     *   `label`, `viewport`, `dominantColors`, `colorCount`, and for a logo its `variant` and `tone`
     * @param {object} [input.upload] set when a person uploaded it: `userId`, `fileName`, and what
     *   was read from the file — `font` (family, subfamily, weight, style) or `document` (pages,
     *   text). An upload is never pruned, and a picture a run also finds stays an upload.
     * @returns {Promise<{id: ObjectId, hash: string, created: boolean, asset: object}>}
     */
    async put({ workspaceId, runId = null, kind, bytes, mimeType, meta = {}, upload = null }) {
      const workspace = toObjectId(workspaceId);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const current = now();
      const seen = {
        runId: runId ? toObjectId(runId) : null,
        seenAt: current,
        updatedAt: current,
        ...describe(meta),
      };

      const uploaded = upload ? uploadFields(upload, current) : null;
      const existing = await assets.findOne({ workspaceId: workspace, hash });
      if (existing) {
        // The kind is refreshed like everything else unless a person chose it: the classifier
        // improves between releases, and a picture it once called a photograph should not stay
        // one for good because that is what it was called first. An upload of a picture a run
        // already found makes it an upload; a run finding an uploaded picture leaves it one.
        const base = existing.pinnedFields?.includes("kind") ? seen : { ...seen, kind };
        const changes = uploaded ? { ...base, ...uploaded, runId: existing.runId ?? null } : existing.origin === BRAND_ASSET_ORIGINS.upload ? { ...base, kind: existing.kind } : base;
        const asset = await assets.findOneAndUpdate({ _id: existing._id }, { $set: changes }, { returnDocument: "after" });
        return { id: existing._id, hash, created: false, asset };
      }

      const id = new ObjectId();
      await writeBytes(id, bytes, { mimeType, workspaceId: workspace });
      const asset = {
        _id: id,
        workspaceId: workspace,
        kind,
        hash,
        mimeType,
        bytes: bytes.length,
        caption: null,
        isReference: false,
        hidden: false,
        pinned: false,
        pinnedFields: [],
        origin: BRAND_ASSET_ORIGINS.site,
        createdAt: current,
        ...seen,
        ...(uploaded ?? {}),
      };
      try {
        await assets.insertOne(asset);
      } catch (error) {
        // Two writers stored the same picture at the same moment and the unique index let one
        // through. The loser's bytes are surplus; the winner's row is the answer.
        if (error?.code !== 11000) throw error;
        await discard(id);
        const winner = await assets.findOne({ workspaceId: workspace, hash });
        return { id: winner._id, hash, created: false, asset: winner };
      }
      return { id, hash, created: true, asset };
    },

    /** One asset of a workspace, or null. An identifier that is not one finds nothing. */
    find({ workspaceId, assetId }) {
      if (!ObjectId.isValid(assetId)) return null;
      return assets.findOne({ _id: new ObjectId(assetId), workspaceId: toObjectId(workspaceId) });
    },

    /**
     * One asset by its identifier alone, or null.
     *
     * For the signed-link route, which has no session and so no workspace to ask with: the link's
     * signature covers the workspace the row names, so the row is read first and the signature
     * checked against it.
     */
    findById(assetId) {
      if (!ObjectId.isValid(assetId)) return null;
      return assets.findOne({ _id: new ObjectId(assetId) });
    },

    /**
     * A workspace's assets, the ones a person marked as references first, then newest.
     *
     * @param {object} options
     * @param {unknown} options.workspaceId owning workspace
     * @param {readonly string[]} [options.kinds] only these kinds
     * @param {boolean} [options.includeHidden] also those a person hid; off for outside readers
     */
    list({ workspaceId, kinds = null, includeHidden = true }) {
      const filter = { workspaceId: toObjectId(workspaceId) };
      if (kinds?.length) filter.kind = { $in: [...kinds] };
      if (!includeHidden) filter.hidden = { $ne: true };
      return assets
        .find(filter, { projection: LIST_PROJECTION })
        .sort({ isReference: -1, seenAt: -1, _id: 1 })
        .limit(BRAND_LIMITS.assets * 2 + BRAND_UPLOAD_LIMITS.files)
        .toArray();
    },

    /** A guide's text, page by page, or null when it has none: kept apart from every listing. */
    async guideText(asset) {
      const row = await assets.findOne({ _id: asset._id }, { projection: { "document.text": 1 } });
      return Array.isArray(row?.document?.text) ? row.document.text : null;
    },

    /** The bytes of one asset as a stream, for an HTTP response. */
    open(asset) {
      return bucket.openDownloadStream(asset._id);
    },

    /** The bytes of one asset in memory, for an inline image or a model call. */
    async read(asset) {
      const chunks = [];
      for await (const chunk of bucket.openDownloadStream(asset._id)) chunks.push(chunk);
      return Buffer.concat(chunks);
    },

    /**
     * Records what a person decided about an asset.
     *
     * Each field set here is added to `pinnedFields`, which is what tells the next run it is not
     * the agent's to change. `null` hands a field back to the agent.
     *
     * @param {object} input
     * @param {unknown} input.workspaceId owning workspace
     * @param {string} input.assetId the asset
     * @param {object} input.changes any of `isReference`, `hidden`, `kind`, `caption`
     * @returns {Promise<object|null>} the stored asset, or null when there is none
     */
    async update({ workspaceId, assetId, changes }) {
      const existing = await store.find({ workspaceId, assetId });
      if (!existing) return null;
      const set = { updatedAt: now() };
      const pinnedFields = new Set(existing.pinnedFields ?? []);
      for (const field of PERSON_FIELDS) {
        if (!Object.hasOwn(changes, field)) continue;
        if (changes[field] === null) {
          pinnedFields.delete(field);
          continue;
        }
        set[field] = changes[field];
        pinnedFields.add(field);
      }
      set.pinnedFields = [...pinnedFields];
      set.pinned = pinnedFields.size > 0;
      return assets.findOneAndUpdate({ _id: existing._id }, { $set: set }, { returnDocument: "after" });
    },

    /**
     * Records what the agent worked out about assets after storing them: a caption, what kind of
     * image each turned out to be, whether it is the brand's own, and whether it is a reference.
     *
     * Each is a field a person may also set, and a field a person set is left exactly as they set
     * it: the agent's opinion of a picture never overrules somebody's decision about it.
     *
     * @param {object} input
     * @param {unknown} input.workspaceId owning workspace
     * @param {Array<{id: unknown, caption?: string|null, kind?: string|null, hidden?: boolean, isReference?: boolean}>} input.notes
     */
    async annotate({ workspaceId, notes }) {
      const workspace = toObjectId(workspaceId);
      for (const note of notes) {
        if (!ObjectId.isValid(note.id)) continue;
        const filter = { _id: new ObjectId(note.id), workspaceId: workspace };
        const offered = {
          caption: typeof note.caption === "string" && note.caption ? note.caption.slice(0, 300) : undefined,
          kind: typeof note.kind === "string" && note.kind ? note.kind : undefined,
          hidden: typeof note.hidden === "boolean" ? note.hidden : undefined,
          isReference: typeof note.isReference === "boolean" ? note.isReference : undefined,
        };
        for (const [field, value] of Object.entries(offered)) {
          if (value === undefined) continue;
          await assets.updateOne({ ...filter, pinnedFields: { $ne: field } }, { $set: { [field]: value } });
        }
      }
    },

    /** Removes one asset: the row first, then its bytes. */
    async remove(asset) {
      await assets.deleteOne({ _id: asset._id });
      await discard(asset._id);
    },

    /**
     * Removes every image a workspace holds, rows and bytes, when the workspace is deleted.
     *
     * The bytes go first, found two ways — by the rows' identifiers and by the workspace stamped
     * on each file's metadata — so a file whose row a crash already removed goes too. The rows go
     * last, so a deletion that fails half way still finds the identifiers on its retry.
     *
     * @param {unknown} workspaceId the workspace being deleted
     * @returns {Promise<{assets: number, files: number}>} rows and files removed
     */
    async purgeWorkspace(workspaceId) {
      const workspace = toObjectId(workspaceId);
      const rows = await assets.find({ workspaceId: workspace }, { projection: { _id: 1 } }).toArray();
      const stamped = await bucket.find({ "metadata.workspaceId": workspace }, { projection: { _id: 1 } }).toArray();
      const ids = new Map([...rows, ...stamped].map((row) => [String(row._id), row._id]));
      for (const id of ids.values()) await discard(id);
      const removed = await assets.deleteMany({ workspaceId: workspace });
      return { assets: removed.deletedCount, files: stamped.length };
    },

    /**
     * How many assets a workspace holds and how many bytes they add up to: the website's, against
     * the limits a run prunes to, and the uploads, against their own.
     */
    async stats(workspaceId) {
      const rows = await assets
        .aggregate([
          { $match: { workspaceId: toObjectId(workspaceId) } },
          { $group: { _id: { $eq: ["$origin", BRAND_ASSET_ORIGINS.upload] }, assets: { $sum: 1 }, bytes: { $sum: "$bytes" } } },
        ])
        .toArray();
      const site = rows.find((row) => row._id === false);
      const uploads = rows.find((row) => row._id === true);
      return {
        assets: site?.assets ?? 0,
        bytes: site?.bytes ?? 0,
        limits: { assets: BRAND_LIMITS.assets, bytes: BRAND_LIMITS.bytes },
        uploads: {
          files: uploads?.assets ?? 0,
          bytes: uploads?.bytes ?? 0,
          limits: { files: BRAND_UPLOAD_LIMITS.files, bytes: BRAND_UPLOAD_LIMITS.bytes, fileBytes: BRAND_UPLOAD_LIMITS.fileBytes },
        },
      };
    },

    /**
     * Brings a workspace's assets back within its limits once a run has finished.
     *
     * Two steps, and neither touches anything a person pinned or marked as a reference. First,
     * whatever only a superseded run saw goes: the page moved on, and a screenshot of how it
     * looked last month beside this month's proposal would be read as current. Then, if the run
     * itself stored more than a workspace may hold, the least useful of its own go — in the order
     * `rank` gives, so the caller decides what "least useful" means.
     *
     * @param {object} input
     * @param {unknown} input.workspaceId owning workspace
     * @param {unknown} input.runId the run that just finished
     * @param {(asset: object) => number} [input.rank] lower is kept longer; defaults to newest first
     * @returns {Promise<{superseded: number, overLimit: number}>} how many were removed, and why
     */
    async prune({ workspaceId, runId, rank = () => 0 }) {
      const workspace = toObjectId(workspaceId);
      const run = toObjectId(runId);
      // An upload is a person's file, not something the site showed: no run removes one, and it
      // takes none of the room the website's images are given.
      const keep = { $or: [{ pinned: true }, { isReference: true }, UPLOADED] };

      const stale = await assets.find({ workspaceId: workspace, runId: { $ne: run }, $nor: [keep] }, { projection: LIST_PROJECTION }).toArray();
      for (const asset of stale) await store.remove(asset);

      const rows = await assets.find({ workspaceId: workspace, origin: { $ne: BRAND_ASSET_ORIGINS.upload } }, { projection: LIST_PROJECTION }).toArray();
      const ordered = rows
        .map((asset) => ({ asset, kept: asset.pinned === true || asset.isReference === true, rank: rank(asset) }))
        .sort((left, right) => Number(right.kept) - Number(left.kept) || left.rank - right.rank || right.asset.seenAt - left.asset.seenAt);

      let count = 0;
      let bytes = 0;
      let overLimit = 0;
      for (const { asset, kept } of ordered) {
        const fits = count < BRAND_LIMITS.assets && bytes + asset.bytes <= BRAND_LIMITS.bytes;
        if (fits || kept) {
          count += 1;
          bytes += asset.bytes;
          continue;
        }
        await store.remove(asset);
        overLimit += 1;
      }
      return { superseded: stale.length, overLimit };
    },

    /**
     * Removes bytes no row points at: what a crash between the upload and the row leaves behind.
     *
     * Bounded to files older than an hour, so a write in flight is never mistaken for an orphan.
     */
    async sweepOrphans(workspaceId) {
      const workspace = toObjectId(workspaceId);
      const before = new Date(now().getTime() - 3_600_000);
      const files = await bucket.find({ "metadata.workspaceId": workspace, uploadDate: { $lt: before } }).project({ _id: 1 }).toArray();
      if (!files.length) return 0;
      const known = await assets.find({ _id: { $in: files.map((file) => file._id) } }).project({ _id: 1 }).toArray();
      const referenced = new Set(known.map((row) => row._id.toHexString()));
      let removed = 0;
      for (const file of files) {
        if (referenced.has(file._id.toHexString())) continue;
        await discard(file._id);
        removed += 1;
      }
      return removed;
    },
  };
  return store;
}

/**
 * The fields that make an asset an upload: who sent it, under what name, and what was read from
 * the file. Clipped like everything else a row holds.
 */
function uploadFields(upload, at) {
  const text = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
  const fields = {
    origin: BRAND_ASSET_ORIGINS.upload,
    uploadedBy: upload.userId ? toObjectId(upload.userId) : null,
    uploadedAt: at,
    fileName: text(upload.fileName, 200),
  };
  if (upload.font) {
    fields.font = {
      family: text(upload.font.family, 120),
      subfamily: text(upload.font.subfamily, 80),
      fullName: text(upload.font.fullName, 160),
      postscriptName: text(upload.font.postscriptName, 120),
      weight: Number.isFinite(upload.font.weight) ? Math.round(upload.font.weight) : null,
      style: upload.font.style === "italic" ? "italic" : "normal",
      format: text(upload.font.format, 10),
    };
  }
  if (upload.document) {
    const pages = Array.isArray(upload.document.text) ? upload.document.text.map((page) => String(page ?? "")) : [];
    let budget = BRAND_UPLOAD_LIMITS.guideCharacters;
    const kept = pages.map((page) => {
      const slice = page.slice(0, Math.max(0, budget));
      budget -= slice.length;
      return slice;
    });
    fields.document = {
      pages: Number.isFinite(upload.document.pages) ? upload.document.pages : pages.length,
      title: text(upload.document.title, 200),
      text: kept,
      truncated: budget < 0 || kept.some((page, index) => page.length < pages[index].length),
    };
  }
  if (upload.tokens) {
    fields.tokens = { format: text(upload.tokens.format, 20), count: Number.isFinite(upload.tokens.count) ? upload.tokens.count : null };
  }
  return fields;
}

/**
 * The descriptive fields a caller may record with an asset, clipped to what a row should hold.
 *
 * Only the fields present are returned, so refreshing a row a second run found again does not
 * blank what the first run knew and the second did not look at.
 */
function describe(meta) {
  const fields = {};
  const text = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
  const whole = (value) => (Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

  if ("width" in meta) fields.width = whole(meta.width);
  if ("height" in meta) fields.height = whole(meta.height);
  if ("sourceUrl" in meta) fields.sourceUrl = text(meta.sourceUrl, 2000);
  if ("pageUrl" in meta) fields.pageUrl = text(meta.pageUrl, 2000);
  if ("position" in meta) fields.position = text(meta.position, 40);
  if ("alt" in meta) fields.alt = text(meta.alt, 300);
  if ("label" in meta) fields.label = text(meta.label, 80);
  if ("viewport" in meta) fields.viewport = text(meta.viewport, 20);
  if ("variant" in meta) fields.variant = text(meta.variant, 40);
  if ("tone" in meta) fields.tone = text(meta.tone, 20);
  if ("colorCount" in meta) fields.colorCount = whole(meta.colorCount);
  if ("dominantColors" in meta) {
    fields.dominantColors = (Array.isArray(meta.dominantColors) ? meta.dominantColors : [])
      .filter((value) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value))
      .slice(0, 6)
      .map((value) => value.toLowerCase());
  }
  return fields;
}
