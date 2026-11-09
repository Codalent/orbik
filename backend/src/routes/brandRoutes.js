import { SIGNED_ASSET_PATH } from "@orbik/assets";
import { BRAND_UPLOAD_LIMITS } from "@orbik/core";
import express, { Router } from "express";

import { createBrandController } from "../controllers/brandController.js";
import { requireAuthentication } from "../middleware/auth.js";
import { createRateLimit } from "../middleware/rateLimits.js";
import {
  readSignedAssetLink,
  validateAssetBody,
  validateChangeScope,
  validateUploadQuery,
  validateAssetListQuery,
  validateAssetScope,
  validatePinBody,
  validateRenderQuery,
  validateRevisionScope,
  validateUnpinBody,
} from "../validators/brandValidators.js";
import { validateWorkspaceScope } from "../validators/shared.js";

/** How many signed links one address may follow in a minute. A chat session fetches a handful. */
const SIGNED_LINKS_PER_MINUTE = 240;

/**
 * Builds the routes a workspace's design system is read and corrected through.
 *
 * Addressed through the workspace like every other workspace-owned thing, so ownership is enforced
 * by the same check that protects the workspace. Two things here are unlike the routes around
 * them. Some answers are not JSON: an asset is streamed as the image it is, and a rendering is
 * sent as the text it is. And one route takes no session at all: a signed link, which an outside
 * AI follows, carries its permission in its own signature.
 *
 * The verbs are the ones the API already allows across origins. An asset's flags are changed with
 * `PUT`, replacing the fields named, because the browser policy in `middleware/security.js` admits
 * no `PATCH` and widening it for one route would widen it for all of them.
 *
 * @param {object} options collaborators
 * @param {object} options.brandService the use cases
 * @param {Function} options.csrfProtection the session's write check
 * @param {import("mongodb").Collection} options.rateLimitCollection backs the signed-link ceiling
 */
export function createBrandRouter({ brandService, csrfProtection, rateLimitCollection }) {
  const router = Router();
  const controller = createBrandController(brandService);
  const base = "/v1/workspaces/:workspaceId/brand";
  const read = [requireAuthentication, validateWorkspaceScope];
  const write = [requireAuthentication, csrfProtection, validateWorkspaceScope];

  router.get(base, ...read, controller.getBrand);
  router.put(`${base}/pins`, ...write, validatePinBody, controller.setPin);
  router.delete(`${base}/pins`, ...write, validateUnpinBody, controller.removePin);
  router.get(`${base}/render`, ...read, validateRenderQuery, controller.render);
  router.get(`${base}/revisions`, ...read, controller.listRevisions);
  router.post(`${base}/revisions/:revision/restore`, ...write, validateRevisionScope, controller.restoreRevision);
  router.get(`${base}/observations/latest`, ...read, controller.getLatestObservation);
  router.get(`${base}/assets`, ...read, validateAssetListQuery, controller.listAssets);
  router.get(`${base}/assets/:assetId`, ...read, validateAssetScope, controller.getAsset);
  router.put(`${base}/assets/:assetId`, ...write, validateAssetScope, validateAssetBody, controller.updateAsset);
  // A file is the body itself, read raw here: the one route of the API whose body is not JSON,
  // exempted from the JSON rule by `BRAND_UPLOAD_PATH` in middleware/security.js. The session's
  // CSRF header is still required, which no form on another site can send.
  const raw = express.raw({ type: () => true, limit: BRAND_UPLOAD_LIMITS.fileBytes + 1024 });
  router.post(`${base}/uploads`, ...write, raw, validateUploadQuery, controller.upload);
  router.post(`${base}/changes/:changeId/undo`, ...write, validateChangeScope, controller.undoChange);

  // The one route here without a session. Limited by address, because nothing else identifies the
  // caller before the signature is checked and a signature costs a database read to check.
  const limit = createRateLimit({ collection: rateLimitCollection, keyPrefix: "brand-asset", points: SIGNED_LINKS_PER_MINUTE, durationSeconds: 60 });
  router.get(`${SIGNED_ASSET_PATH}/:assetId`, limit, readSignedAssetLink, controller.getSignedAsset);

  return router;
}
