import { BRAND_ASSET_KINDS, BRAND_ASSET_ORIGINS, BRAND_PRIVATE_KINDS, BRAND_UPLOAD_LIMITS } from "@orbik/core";
import { BRAND_RENDER_FORMATS, BRAND_RENDER_FORMAT_VALUES, DesignSystemError, renderBrand } from "@orbik/design-system";

import { AppError } from "../errors/appError.js";
import { readUpload } from "./brandUploads.js";
import { createWorkspaceAccessCheck } from "./workspaceAccess.js";

/** A date as the API sends it, or null. */
function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

/** An identifier as the API sends it, or null. */
function hex(value) {
  return value ? value.toHexString() : null;
}

/** How each refusal of the design-system store reads over HTTP. */
const STORE_FAILURES = Object.freeze({
  PIN_INVALID: 400,
  DESIGN_SYSTEM_MISSING: 409,
  DESIGN_SYSTEM_BUSY: 409,
  REVISION_MISSING: 404,
  CHANGE_MISSING: 404,
  CHANGED_SINCE: 409,
});

/** Runs a store operation, turning its refusal into an HTTP failure with the same code. */
async function withStore(work) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DesignSystemError) {
      throw new AppError({ status: STORE_FAILURES[error.code] ?? 409, code: error.code, message: error.message });
    }
    throw error;
  }
}

/**
 * Converts a stored asset to the shape the web app reads.
 *
 * The bytes are not here and neither is a link to them: the web app builds the address from the
 * workspace and the identifier, and loads it with the session cookie like any other request.
 *
 * @param {object} asset the stored metadata row
 */
export function toAssetSummary(asset) {
  return {
    id: asset._id.toHexString(),
    kind: asset.kind,
    mimeType: asset.mimeType,
    bytes: asset.bytes,
    width: asset.width ?? null,
    height: asset.height ?? null,
    label: asset.label ?? null,
    alt: asset.alt ?? null,
    caption: asset.caption ?? null,
    position: asset.position ?? null,
    viewport: asset.viewport ?? null,
    variant: asset.variant ?? null,
    tone: asset.tone ?? null,
    pageUrl: asset.pageUrl ?? null,
    sourceUrl: asset.sourceUrl ?? null,
    dominantColors: asset.dominantColors ?? [],
    isReference: asset.isReference === true,
    hidden: asset.hidden === true,
    // Which of the above a person set, and a run therefore leaves alone.
    pinnedFields: asset.pinnedFields ?? [],
    runId: hex(asset.runId),
    createdAt: iso(asset.createdAt),
    seenAt: iso(asset.seenAt),
    // Where it came from: the website through a run, or a person's upload — and for an upload,
    // what was read from the file. A guide's text is not here; it is read when asked for.
    origin: asset.origin ?? BRAND_ASSET_ORIGINS.site,
    fileName: asset.fileName ?? null,
    uploadedAt: iso(asset.uploadedAt),
    font: asset.font ?? null,
    document: asset.document ? { pages: asset.document.pages ?? null, title: asset.document.title ?? null, truncated: asset.document.truncated === true } : null,
    tokens: asset.tokens ?? null,
  };
}

/**
 * Converts one recorded change to the shape the chat and the page read: where, before, after, how
 * it was made, and whether it has been undone.
 *
 * @param {object} change a `brand_changes` row
 */
export function toChangeView(change) {
  return {
    id: change._id.toHexString(),
    kind: change.kind,
    pointer: change.pointer ?? null,
    assetId: hex(change.assetId),
    fields: change.fields ?? null,
    before: change.before ?? null,
    after: change.after ?? null,
    via: change.via ?? null,
    runId: hex(change.runId),
    at: iso(change.at),
    undoneAt: iso(change.undoneAt),
  };
}

/** The host a workspace's site is on, for a brand started from uploads; null when it has none. */
function hostOf(workspace) {
  try {
    return new URL(workspace.websiteUrl).host;
  } catch {
    return null;
  }
}

/**
 * Converts a stored design system to the shape the Brand page reads.
 *
 * Both layers travel: `system` is what everything else is handed — the proposal with the pins laid
 * over it — and `proposal` is what the agent said, so the page can show "the agent proposed this,
 * you set that" and offer the agent's value back.
 *
 * @param {object|null} document the stored system
 */
function toSystemView(document) {
  if (!document) return null;
  return {
    revision: document.revision ?? 0,
    host: document.host ?? null,
    derivedAt: iso(document.derivedAt),
    previousDerivedAt: iso(document.previousDerivedAt),
    updatedAt: iso(document.updatedAt),
    runId: hex(document.runId),
    agentVersion: document.agentVersion ?? null,
    restoredFrom: document.restoredFrom ?? null,
    system: document.system ?? null,
    proposal: document.proposal ?? null,
    pins: (document.pins ?? []).map((pin) => ({ pointer: pin.pointer, value: pin.value, pinnedAt: iso(pin.pinnedAt), via: pin.via ?? null })),
    // Nothing was derived from the site: every value is one a person gave.
    startedFromUploads: document.startedFromUploads === true && !document.derivedAt,
    changes: document.changes ?? [],
    synthesis: document.synthesis ?? null,
    pages: document.pages ?? [],
    // A derivation that rendered the site and could not propose a system from it: what was tried
    // and why it produced nothing, shown beside whatever system was already there.
    lastAttempt: document.lastAttempt
      ? { runId: hex(document.lastAttempt.runId), at: iso(document.lastAttempt.at), synthesis: document.lastAttempt.synthesis ?? null }
      : null,
  };
}

/**
 * Creates the use cases behind the Brand page: reading the design system, correcting it, and
 * copying it out.
 *
 * A correction is a **pin**, never an edit of what the agent proposed: the value a person sets is
 * recorded beside the proposal and laid over it, so the next derivation cannot undo it and
 * unpinning gives the agent's value straight back. A pin takes effect at once: the Brand page, the
 * exports and `brand_get` all read the system as it now stands.
 *
 * A derivation itself is started through the run and schedule routes every agent shares, and the
 * pages it renders are chosen through the agent setup routes, so nothing here starts work.
 *
 * @param {object} dependencies collaborators
 * @param {object} dependencies.workspaceRepository workspace access by owner or membership
 * @param {object} dependencies.brandRepository the design system, its pins and its images
 * @param {ReturnType<import("@orbik/assets").createAssetUrlSigner>|null} dependencies.assetUrls
 *   mints signed links for exports; null when this API has no secret to sign with
 */
export function createBrandService({ workspaceRepository, brandRepository, assetUrls = null }) {
  const requireWorkspaceAccess = createWorkspaceAccessCheck(workspaceRepository);

  /** Resolves one of the workspace's assets, or fails as a missing one. */
  async function requireAsset(workspace, assetId) {
    const asset = await brandRepository.findAsset({ workspaceId: workspace._id, assetId });
    if (!asset) {
      throw new AppError({ status: 404, code: "ASSET_NOT_FOUND", message: "That image was not found." });
    }
    return asset;
  }

  /** Resolves the workspace's derived system, or fails saying there is none yet. */
  async function requireSystem(workspace) {
    const document = await brandRepository.findSystem(workspace._id);
    if (!document?.system) {
      throw new AppError({ status: 409, code: "DESIGN_SYSTEM_MISSING", message: "There is no design system yet. Derive one first." });
    }
    return document;
  }

  return {
    /**
     * Everything the Brand page opens with: the system, its images, and the pages it was read from.
     *
     * `brand` is null when no system has been derived, which is an ordinary state — a workspace
     * that has not set the agent to work — and not an error. The images and the last observation
     * are returned regardless, because a deployment without a model still has both.
     */
    async getBrand({ userId, workspaceId }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      const [document, assets, stats, observation] = await Promise.all([
        brandRepository.findSystem(workspace._id),
        brandRepository.listAssets({ workspaceId: workspace._id }),
        brandRepository.assetStats(workspace._id),
        brandRepository.findLatestObservationSummary(workspace._id),
      ]);
      return {
        brand: toSystemView(document),
        assets: assets.map(toAssetSummary),
        stats,
        observation: observation
          ? {
              id: observation._id.toHexString(),
              runId: hex(observation.runId),
              host: observation.host,
              createdAt: iso(observation.createdAt),
              pageSource: observation.pageSource,
              chrome: observation.chrome ?? null,
              pages: observation.pages,
              sheets: observation.assets?.sheets ?? {},
              seen: observation.assets?.seen ?? null,
            }
          : null,
        formats: BRAND_RENDER_FORMAT_VALUES.map((format) => ({ id: format, label: BRAND_RENDER_FORMATS[format].label })),
        // Whether a copied export can carry working links to its images.
        signedLinks: Boolean(assetUrls),
      };
    },

    /**
     * The newest record of what the rendered pages showed, for the Observed drawer.
     *
     * `observation` is null when the agent has never rendered this site.
     */
    async getLatestObservation({ userId, workspaceId }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      const stored = await brandRepository.findLatestObservation(workspace._id);
      if (!stored) return { observation: null };
      return {
        observation: {
          id: stored._id.toHexString(),
          runId: hex(stored.runId),
          host: stored.host,
          createdAt: iso(stored.createdAt),
          forced: stored.forced === true,
          chrome: stored.chrome ?? null,
          pageSource: stored.pageSource,
          pages: stored.pages,
          observed: stored.observed,
          assets: stored.assets,
        },
      };
    },

    /**
     * Pins one value of the system, recording the change so it can be undone.
     *
     * `source` names an uploaded file the value was taken from — "Add it" beside something the
     * chat left out of a brand guide — and is shown beside the value as that file and page.
     */
    async setPin({ userId, workspaceId, pointer, value, source = null }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "member" });
      let via = { kind: "page" };
      if (source) {
        const file = await brandRepository.findAsset({ workspaceId: workspace._id, assetId: source.assetId });
        if (!file || file.origin !== BRAND_ASSET_ORIGINS.upload) {
          throw new AppError({ status: 400, code: "SOURCE_INVALID", message: "That file is not one of this brand's uploads." });
        }
        via = { kind: "upload", assetId: source.assetId, fileName: file.fileName ?? null, page: source.page ?? undefined };
      }
      // The main logo is chosen from the logos there are: an identifier that names something
      // else, or nothing, is not a choice the system can hold.
      if (pointer === "/logos/primary") {
        const asset = typeof value === "string" ? await brandRepository.findAsset({ workspaceId: workspace._id, assetId: value }) : null;
        if (!asset || asset.kind !== BRAND_ASSET_KINDS.logo) {
          throw new AppError({ status: 400, code: "PIN_INVALID", message: "Choose one of the stored logos." });
        }
      }
      const { document, change } = await withStore(() => brandRepository.setPin({ workspaceId: workspace._id, pointer, value, userId, via, host: hostOf(workspace) }));
      return { brand: toSystemView(document), change: toChangeView(change) };
    },

    /** Unpins one value, handing it back to the agent. */
    async removePin({ userId, workspaceId, pointer }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "member" });
      const { document, change } = await withStore(() => brandRepository.removePin({ workspaceId: workspace._id, pointer, userId }));
      return { brand: toSystemView(document), change: toChangeView(change) };
    },

    /**
     * Stores one file a person uploaded: a logo, an image, a brand guide, a font or a token file.
     *
     * What it is is read from its bytes (`readUpload`); it is kept as long as the person keeps it,
     * outside the room the website's images are pruned to, within the uploads' own limits. Storing
     * it changes nothing in the system: the chat looks at it and decides, or the person does.
     */
    async upload({ userId, workspaceId, bytes, fileName, hint }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "member" });
      const stats = await brandRepository.assetStats(workspace._id);
      if (stats.uploads.files >= BRAND_UPLOAD_LIMITS.files) {
        throw new AppError({ status: 409, code: "UPLOADS_FULL", message: `This brand holds ${BRAND_UPLOAD_LIMITS.files} uploaded files, the most it may. Remove one first.` });
      }
      if (stats.uploads.bytes + bytes.length > BRAND_UPLOAD_LIMITS.bytes) {
        throw new AppError({ status: 409, code: "UPLOADS_FULL", message: `This brand's uploads would pass ${Math.round(BRAND_UPLOAD_LIMITS.bytes / 1048576)} MB. Remove a large file first.` });
      }
      const read = await readUpload({ bytes, fileName, hint });
      const { asset, created } = await brandRepository.putAsset({
        workspaceId: workspace._id,
        kind: read.kind,
        bytes: read.bytes,
        mimeType: read.mimeType,
        meta: read.meta,
        upload: { ...read.upload, userId },
      });
      return { asset: toAssetSummary(asset), created, format: read.label };
    },

    /** Puts back what one change replaced: the earlier pin, the website's value, an image's flags. */
    async undoChange({ userId, workspaceId, changeId }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "member" });
      const { change, document, asset } = await withStore(() => brandRepository.undoChange({ workspaceId: workspace._id, changeId, userId }));
      return {
        change: toChangeView(change),
        brand: document ? toSystemView(document) : null,
        asset: asset ? toAssetSummary(asset) : null,
      };
    },

    /** The kept earlier versions of the system, newest first. */
    async listRevisions({ userId, workspaceId }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      const rows = await brandRepository.listRevisions(workspace._id);
      return {
        revisions: rows.map((row) => ({
          revision: row.revision,
          reason: row.reason ?? "derivation",
          savedAt: iso(row.savedAt),
          derivedAt: iso(row.derivedAt),
          pins: (row.pins ?? []).length,
        })),
      };
    },

    /** Puts the system back to a kept version, as a new version. */
    async restoreRevision({ userId, workspaceId, revision }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "member" });
      const document = await withStore(() => brandRepository.restoreRevision({ workspaceId: workspace._id, revision }));
      return { brand: toSystemView(document) };
    },

    /**
     * The system in one of the forms it is copied out in.
     *
     * The two forms that carry images — DESIGN.md and the image prompt — carry them as signed
     * links when this API can sign one, because the text is on its way out of Orbik, to a tool
     * that has no session here. Without a secret the images are named and not linked.
     *
     * @returns {Promise<{text: string, mimeType: string, filename: string}>}
     */
    async render({ userId, workspaceId, format }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      const document = await requireSystem(workspace);
      const assets = await brandRepository.listAssets({ workspaceId: workspace._id, includeHidden: false });
      return renderBrand(format, {
        system: document.system,
        host: document.host,
        name: workspace.name ?? null,
        derivedAt: document.derivedAt,
        assets,
        assetUrl: assetUrls ? (asset) => assetUrls.sign({ assetId: asset._id.toHexString(), workspaceId: workspace._id.toHexString() }).url : () => null,
        voiceNote: "Voice and tone are not part of this file: they are in the Orbik Library's overview, the file the Library's tree names as its front page.",
      });
    },

    /** The workspace's stored images, and how much room they take of how much there is. */
    async listAssets({ userId, workspaceId, kinds }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      const [assets, stats] = await Promise.all([
        brandRepository.listAssets({ workspaceId: workspace._id, kinds }),
        brandRepository.assetStats(workspace._id),
      ]);
      return { assets: assets.map(toAssetSummary), stats };
    },

    /**
     * Records what a person decided about one image: whether it is a reference, whether it is
     * hidden, what kind it is, how it is captioned.
     *
     * Each is the asset's own pin: the next run refreshes everything else about the image and
     * leaves these as they were set.
     */
    async updateAsset({ userId, workspaceId, assetId, changes }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "member" });
      await requireAsset(workspace, assetId);
      const { asset, change } = await brandRepository.updateAsset({ workspaceId: workspace._id, assetId, changes, userId });
      return { asset: toAssetSummary(asset), change: toChangeView(change) };
    },

    /**
     * One stored image, ready to be sent: its row, and a way to open its bytes.
     *
     * The stream is opened by the caller only once it knows a body is wanted — a request that
     * already holds this version is answered without reading a byte.
     */
    async openAsset({ userId, workspaceId, assetId }) {
      const workspace = await requireWorkspaceAccess(userId, workspaceId, { role: "read-only" });
      const asset = await requireAsset(workspace, assetId);
      return { asset, open: () => brandRepository.openAsset(asset) };
    },

    /**
     * One stored image reached by a signed link rather than a session.
     *
     * One answer for every failure — no such image, a signature that does not match, a link that
     * has expired, an API that cannot check links at all — because a response that told them apart
     * would say which asset identifiers exist to anybody who cared to ask.
     */
    async openSignedAsset({ assetId, exp, sig }) {
      const refused = new AppError({ status: 404, code: "ASSET_LINK_INVALID", message: "This link is not valid, or it has expired." });
      if (!assetUrls) throw refused;
      const asset = await brandRepository.findAssetById(assetId);
      // The workspace is read from the asset's own row, never from the link: it is inside the
      // signature, so a link cannot be edited to reach another workspace's picture.
      // A font is never served by a link: its licence is the company's, not the link holder's.
      if (!asset || asset.hidden === true || BRAND_PRIVATE_KINDS.includes(asset.kind)) throw refused;
      if (assetUrls.verify({ assetId, workspaceId: asset.workspaceId.toHexString(), exp, sig }) !== "ok") throw refused;
      return { asset, open: () => brandRepository.openAsset(asset) };
    },
  };
}
