import { createHash } from "node:crypto";

import { AGENT_COLLECTIONS, toObjectId } from "@orbik/core";

import { looksLikeSvg, sanitiseSvg } from "./svg.js";

/**
 * A workspace's icon: the small picture it is shown with beside its name — on Home, in the
 * workspace switcher, in Settings — instead of the first letter of that name.
 *
 * It comes from one of two places. The crawler reads the website's own icon (the `<link rel=icon>`
 * of its home page, or `/favicon.ico`) on every crawl, so a site that changes its icon changes the
 * workspace's too; and a person may upload one in Settings instead. Which of the two the workspace
 * is shown with — or neither, its letter — is the person's choice, kept beside them. Both pictures
 * are kept whatever the choice, so switching back is one click and costs no request to the site.
 *
 * One row per workspace in `workspace_icons`, the pictures inside it: an icon is a few kilobytes,
 * and a listing that leaves the bytes out costs nothing for having them there.
 */

/** How large an icon may be, from a site or an upload. A favicon is a few kilobytes. */
export const WORKSPACE_ICON_LIMITS = Object.freeze({ bytes: 512 * 1024 });

/** Where an icon came from. */
export const WORKSPACE_ICON_ORIGINS = Object.freeze({ site: "site", upload: "upload" });

/**
 * What a workspace is shown with: the website's icon (the default, also when a row has no choice),
 * the uploaded one, or `none` — its name's first letter.
 */
export const WORKSPACE_ICON_CHOICES = Object.freeze(["site", "upload", "none"]);

/** What a listing reads: everything but the pictures. */
const SUMMARY_PROJECTION = Object.freeze({ "site.data": 0, "upload.data": 0 });

/** Whether the bytes start with the given ASCII signature at an offset. */
function startsWith(bytes, signature, offset = 0) {
  return bytes.length >= offset + signature.length && bytes.subarray(offset, offset + signature.length).toString("latin1") === signature;
}

/**
 * What picture some bytes are, as an icon: its type, read from the bytes and never from a name or a
 * header, and its size where the header says it. An SVG comes back sanitised, so what is stored is
 * a picture and nothing that runs. Anything else — an HTML page a server sent for a missing icon,
 * a cursor, a file too large — is null.
 *
 * @param {Buffer|Uint8Array} input the file
 * @returns {{mimeType: string, data: Buffer, width: number|null, height: number|null}|null}
 */
export function readIconImage(input) {
  const bytes = Buffer.from(input ?? []);
  if (!bytes.length || bytes.length > WORKSPACE_ICON_LIMITS.bytes) return null;
  const image = (mimeType, size = {}, data = bytes) => ({ mimeType, data, width: size.width ?? null, height: size.height ?? null });
  try {
    if (bytes.length >= 24 && bytes[0] === 0x89 && startsWith(bytes, "PNG", 1)) {
      return image("image/png", { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
    }
    if (bytes.length >= 10 && (startsWith(bytes, "GIF87a") || startsWith(bytes, "GIF89a"))) {
      return image("image/gif", { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) });
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return image("image/jpeg");
    if (startsWith(bytes, "RIFF") && startsWith(bytes, "WEBP", 8)) return image("image/webp");
    if (startsWith(bytes, "ftyp", 4) && (startsWith(bytes, "avif", 8) || startsWith(bytes, "avis", 8))) return image("image/avif");
    // An .ico: reserved 0, type 1 (2 is a cursor), then how many pictures it holds, each with a
    // width and height byte where 0 means 256. The largest is the size it can be shown at.
    if (bytes.length >= 22 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1) {
      const count = bytes.readUInt16LE(4);
      if (count < 1 || bytes.length < 6 + count * 16) return null;
      let largest = 0;
      for (let index = 0; index < count; index += 1) largest = Math.max(largest, bytes[6 + index * 16] || 256);
      return image("image/x-icon", { width: largest, height: largest });
    }
    if (looksLikeSvg(bytes)) {
      const data = Buffer.from(sanitiseSvg(bytes.toString("utf8")), "utf8");
      return image("image/svg+xml", svgSize(data.toString("utf8")), data);
    }
  } catch {
    // A header cut short is not a picture this can vouch for.
  }
  return null;
}

/** The drawn size of an SVG, from its viewBox or its width and height. */
function svgSize(text) {
  const tag = text.match(/<svg\b[^>]*>/i)?.[0] ?? "";
  const viewBox = tag.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (viewBox) return { width: Math.round(Number(viewBox[1])), height: Math.round(Number(viewBox[2])) };
  const width = Number(tag.match(/\bwidth\s*=\s*["']?([\d.]+)/i)?.[1]);
  const height = Number(tag.match(/\bheight\s*=\s*["']?([\d.]+)/i)?.[1]);
  return { width: Number.isFinite(width) ? Math.round(width) : null, height: Number.isFinite(height) ? Math.round(height) : null };
}

/** The short form of a picture's hash that its address carries, so a new picture is a new address. */
function versionOf(picture) {
  return picture?.hash ? picture.hash.slice(0, 16) : null;
}

/** A picture's bytes as a Buffer: the driver reads them back as a BSON `Binary`. */
function bufferOf(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data.buffer.subarray(0, data.length()));
}

/**
 * Which picture a row shows, by the choice it holds: the upload when that was chosen, the website's
 * otherwise, nothing when the person chose the letter or there is no picture of the chosen kind.
 */
function currentOf(row) {
  const choice = WORKSPACE_ICON_CHOICES.includes(row?.choice) ? row.choice : "site";
  if (choice === "none") return null;
  if (choice === "upload") return row.upload ? { origin: WORKSPACE_ICON_ORIGINS.upload, picture: row.upload } : null;
  return row?.site ? { origin: WORKSPACE_ICON_ORIGINS.site, picture: row.site } : null;
}

/**
 * What the web app is told about a workspace's icon, beside its name: what it shows now, and the
 * two pictures there are to choose from. Never the bytes; each picture carries a `version`, which
 * changes with the picture and goes into the address it is fetched from.
 *
 * @param {object|null} row the workspace's `workspace_icons` row, if it has one
 * @returns {{choice: string, current: {origin: string, version: string}|null,
 *   site: {version: string, sourceUrl: string|null, fetchedAt: string}|null,
 *   upload: {version: string, fileName: string|null, uploadedAt: string}|null}}
 */
export function toIconSummary(row) {
  const current = currentOf(row);
  return {
    choice: WORKSPACE_ICON_CHOICES.includes(row?.choice) ? row.choice : "site",
    current: current ? { origin: current.origin, version: versionOf(current.picture) } : null,
    site: row?.site
      ? { version: versionOf(row.site), sourceUrl: row.site.sourceUrl ?? null, fetchedAt: row.site.fetchedAt?.toISOString?.() ?? null }
      : null,
    upload: row?.upload
      ? { version: versionOf(row.upload), fileName: row.upload.fileName ?? null, uploadedAt: row.upload.uploadedAt?.toISOString?.() ?? null }
      : null,
  };
}

/**
 * The store behind workspace icons. The crawler writes the website's picture, the API a person's
 * upload and their choice; each writes only its own fields of the row, so neither can undo the
 * other.
 *
 * @param {object} dependencies
 * @param {import("mongodb").Db} dependencies.database connected database
 * @param {() => Date} [dependencies.now] clock
 */
export function createWorkspaceIconStore({ database, now = () => new Date() }) {
  const icons = database.collection(AGENT_COLLECTIONS.workspaceIcons);

  /** The stored form of a picture: its bytes and what was read from them. */
  function pictureOf(image) {
    return {
      data: image.data,
      mimeType: image.mimeType,
      bytes: image.data.length,
      hash: createHash("sha256").update(image.data).digest("hex"),
      width: image.width ?? null,
      height: image.height ?? null,
    };
  }

  return {
    /**
     * Records the icon the crawler found on the website. The same picture as last time only moves
     * `checkedAt`, so its address — and every browser's copy of it — stays as it was.
     *
     * @param {object} input
     * @param {unknown} input.workspaceId the workspace
     * @param {{mimeType: string, data: Buffer, width?: number|null, height?: number|null}} input.image
     *   what `readIconImage` made of the bytes
     * @param {string} input.sourceUrl where the picture was fetched from
     * @param {string|null} [input.pageUrl] the page that named it, when one did
     * @returns {Promise<{changed: boolean}>} whether the picture is not the one already held
     */
    async putSite({ workspaceId, image, sourceUrl, pageUrl = null }) {
      const id = toObjectId(workspaceId);
      const at = now();
      const picture = pictureOf(image);
      const same = await icons.updateOne({ _id: id, "site.hash": picture.hash }, { $set: { "site.checkedAt": at, "site.sourceUrl": sourceUrl, "site.pageUrl": pageUrl } });
      if (same.matchedCount) return { changed: false };
      await icons.updateOne(
        { _id: id },
        { $set: { workspaceId: id, site: { ...picture, sourceUrl, pageUrl, fetchedAt: at, checkedAt: at }, updatedAt: at }, $setOnInsert: { createdAt: at } },
        { upsert: true },
      );
      return { changed: true };
    },

    /**
     * Forgets the website's icon: the workspace's website moved to another site, whose own icon the
     * next crawl reads. An upload and the person's choice stay.
     */
    async clearSite(workspaceId) {
      await icons.updateOne({ _id: toObjectId(workspaceId) }, { $unset: { site: "" }, $set: { updatedAt: now() } });
    },

    /**
     * Keeps a person's upload, replacing any earlier one, and shows it: uploading an icon is
     * choosing it.
     *
     * @param {object} input
     * @param {unknown} input.workspaceId the workspace
     * @param {object} input.image what `readIconImage` made of the file
     * @param {unknown} input.userId who uploaded it
     * @param {string|null} [input.fileName] the name it came with
     */
    async putUpload({ workspaceId, image, userId, fileName = null }) {
      const id = toObjectId(workspaceId);
      const at = now();
      const name = typeof fileName === "string" && fileName.trim() ? fileName.trim().slice(0, 200) : null;
      return icons.findOneAndUpdate(
        { _id: id },
        {
          $set: { workspaceId: id, choice: "upload", upload: { ...pictureOf(image), fileName: name, uploadedBy: toObjectId(userId), uploadedAt: at }, updatedAt: at },
          $setOnInsert: { createdAt: at },
        },
        { upsert: true, returnDocument: "after", projection: SUMMARY_PROJECTION },
      );
    },

    /**
     * Records what the workspace is shown with. `upload` needs an upload to show, and returns null
     * without one; the website's icon may be chosen before a crawl has found one, and is shown once
     * it has.
     *
     * @param {unknown} workspaceId the workspace
     * @param {string} choice one of `WORKSPACE_ICON_CHOICES`
     * @returns {Promise<object|null>} the row, without its pictures
     */
    async choose(workspaceId, choice) {
      const id = toObjectId(workspaceId);
      const at = now();
      if (choice === "upload") {
        return icons.findOneAndUpdate({ _id: id, upload: { $exists: true } }, { $set: { choice, updatedAt: at } }, { returnDocument: "after", projection: SUMMARY_PROJECTION });
      }
      return icons.findOneAndUpdate(
        { _id: id },
        { $set: { workspaceId: id, choice, updatedAt: at }, $setOnInsert: { createdAt: at } },
        { upsert: true, returnDocument: "after", projection: SUMMARY_PROJECTION },
      );
    },

    /** One workspace's row without its pictures, or null. */
    find(workspaceId) {
      return icons.findOne({ _id: toObjectId(workspaceId) }, { projection: SUMMARY_PROJECTION });
    },

    /**
     * Several workspaces' rows without their pictures, by workspace identifier, for a listing.
     *
     * @param {unknown[]} workspaceIds
     * @returns {Promise<Map<string, object>>}
     */
    async findMany(workspaceIds) {
      if (!workspaceIds.length) return new Map();
      const rows = await icons.find({ _id: { $in: workspaceIds.map(toObjectId) } }, { projection: SUMMARY_PROJECTION }).toArray();
      return new Map(rows.map((row) => [row._id.toHexString(), row]));
    },

    /**
     * One picture to send: the one the workspace shows, or the website's or the upload by name
     * (Settings shows both to choose between). Null when there is none.
     *
     * @param {unknown} workspaceId the workspace
     * @param {"site"|"upload"|null} [origin] which picture; the one shown when not given
     * @returns {Promise<{origin: string, mimeType: string, data: Buffer, bytes: number, hash: string}|null>}
     */
    async open(workspaceId, origin = null) {
      const row = await icons.findOne({ _id: toObjectId(workspaceId) });
      const chosen = origin ? (row?.[origin] ? { origin, picture: row[origin] } : null) : currentOf(row);
      if (!chosen) return null;
      const data = bufferOf(chosen.picture.data);
      if (!data) return null;
      return { origin: chosen.origin, mimeType: chosen.picture.mimeType, data, bytes: data.length, hash: chosen.picture.hash };
    },
  };
}
