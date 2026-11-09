import { apiFetch, apiFetchText, apiUpload, getApiBaseUrl } from "./client";
import { requireId } from "./ids";

/**
 * The Brand page's HTTP surface, as the browser sees it.
 *
 * Reads are cache keys as well as paths, as everywhere else. Two things here are not JSON: a
 * rendering of the system is text, read with `apiFetchText`, and an asset is an image, which the
 * page shows by putting its address in an `<img>` — the session cookie travels with it, as it does
 * with every other request to the API.
 */

function base(workspaceId) {
  return `/v1/workspaces/${requireId(workspaceId, "Workspace")}/brand`;
}

/**
 * Where the design system, its images and the pages it was read from are read; also their cache
 * key.
 */
export function brandPath(workspaceId) {
  return base(workspaceId);
}

/** Where the newest record of what the rendered pages showed is read from; also its cache key. */
export function brandObservationPath(workspaceId) {
  return `${base(workspaceId)}/observations/latest`;
}

/** Where the kept earlier versions of the system are listed; also their cache key. */
export function brandRevisionsPath(workspaceId) {
  return `${base(workspaceId)}/revisions`;
}

/**
 * The address of one stored image, for an `<img>` or a download link.
 *
 * Absolute, because the API is on another origin and an image element resolves a relative address
 * against the page it is on.
 */
export function brandAssetUrl(workspaceId, assetId) {
  return `${getApiBaseUrl()}${base(workspaceId)}/assets/${requireId(assetId, "Image")}`;
}

/**
 * Pins one value of the system: from now on it is what was set here, whatever the agent proposes.
 *
 * @param {{assetId: string, page?: number|null}|null} [source] the uploaded file it was taken from
 *   — "Add it" beside something the chat left out of a brand guide
 */
export function setBrandPin(workspaceId, pointer, value, source = null) {
  const body = source ? { pointer, value, source: { assetId: source.assetId, ...(source.page ? { page: source.page } : {}) } } : { pointer, value };
  return apiFetch(`${base(workspaceId)}/pins`, { method: "PUT", body: JSON.stringify(body) });
}

/**
 * Uploads one file to the brand: a logo, an image, a brand guide, a font or a token file. What it
 * is is decided by the API from its bytes; `hint` says where on the page it was dropped.
 *
 * @returns {Promise<{asset: object, created: boolean, format: string}>}
 */
export function uploadBrandFile(workspaceId, file, hint = null) {
  return apiUpload(`${base(workspaceId)}/uploads`, file, { name: file.name, for: hint });
}

/** Puts back what one change to the brand replaced. */
export function undoBrandChange(workspaceId, changeId) {
  return apiFetch(`${base(workspaceId)}/changes/${requireId(changeId, "Change")}/undo`, { method: "POST", body: "{}" });
}

/** Unpins one value, handing it back to the agent. */
export function removeBrandPin(workspaceId, pointer) {
  return apiFetch(`${base(workspaceId)}/pins`, { method: "DELETE", body: JSON.stringify({ pointer }) });
}

/**
 * Records what a person decided about one image.
 *
 * @param {object} changes any of `isReference`, `hidden`, `kind`, `caption`; `null` hands a field
 *   back to the agent
 */
export function updateBrandAsset(workspaceId, assetId, changes) {
  return apiFetch(`${base(workspaceId)}/assets/${requireId(assetId, "Image")}`, { method: "PUT", body: JSON.stringify(changes) });
}

/** Reads the system in one of the forms it is copied out in, as text. */
export function renderBrand(workspaceId, format) {
  if (!/^[a-z-]+$/.test(format ?? "")) throw new Error("That format is not available.");
  return apiFetchText(`${base(workspaceId)}/render?format=${format}`);
}

/** Puts the system back to one of its kept versions, as a new version. */
export function restoreBrandRevision(workspaceId, revision) {
  return apiFetch(`${base(workspaceId)}/revisions/${Number(revision)}/restore`, { method: "POST", body: "{}" });
}
