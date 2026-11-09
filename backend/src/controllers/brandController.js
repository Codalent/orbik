import { pipeline } from "node:stream/promises";

/**
 * What an asset is served under, whoever asks for it.
 *
 * A stored image came from somebody's website, and an SVG is a document that can carry script. So
 * every asset is sent as a picture and nothing more: the type is the stored one and may not be
 * guessed at, and the policy forbids every kind of loading and running and sandboxes the response
 * — which is what makes it safe to open one in a tab on the API's own origin, where a session
 * cookie lives.
 */
const ASSET_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

/** A file name a download would be saved under: the asset's kind and identifier, with its type's extension. */
function fileNameOf(asset) {
  const extension = {
    "image/svg+xml": "svg", "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/avif": "avif",
    "application/pdf": "pdf", "font/woff2": "woff2", "font/woff": "woff", "font/otf": "otf", "font/ttf": "ttf",
    "application/json": "json", "text/css": "css",
  }[asset.mimeType] ?? "bin";
  // An upload keeps the name it came with, made safe for a header: what a person downloads is what
  // they uploaded.
  const uploaded = typeof asset.fileName === "string" ? asset.fileName.replace(/[^\w.\- ]+/g, "_").slice(0, 120) : null;
  return uploaded && uploaded.toLowerCase().endsWith(`.${extension}`) ? uploaded : `${asset.kind}-${asset._id.toHexString().slice(-8)}.${extension}`;
}

/**
 * Sends one stored asset as an HTTP response.
 *
 * Shared by the two routes that serve an asset — to the web app under a session, and to an
 * outside AI under a signed link — so the headers that make an asset safe to serve are written
 * once. The entity tag is the hash of the bytes, which never changes for one asset, so a client
 * that already holds it is told so without a byte being read.
 *
 * @param {import("express").Request} req the request
 * @param {import("express").Response} res the response
 * @param {object} options
 * @param {object} options.asset the stored metadata row
 * @param {() => import("node:stream").Readable} options.open opens the bytes
 * @param {string} options.cacheControl how long, and by whom, the response may be kept
 */
async function sendAsset(req, res, { asset, open, cacheControl }) {
  const etag = `"${asset.hash}"`;
  res.set({
    ETag: etag,
    "Cache-Control": cacheControl,
    "Content-Security-Policy": ASSET_POLICY,
    "X-Content-Type-Options": "nosniff",
    // Helmet's default keeps a response to its own origin, and the web app that shows these is on
    // another one. Relaxed for assets only: they are pictures, and the reader has already been
    // authorised by a session or a signature.
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
  if (req.get("If-None-Match") === etag) {
    res.status(304).end();
    return;
  }
  // A picture is shown; anything else — a guide, a font, a token file — is downloaded. A PDF opened
  // under the sandbox above would be refused by the browser's viewer anyway.
  const disposition = asset.mimeType.startsWith("image/") ? "inline" : "attachment";
  res.set({
    "Content-Type": asset.mimeType,
    "Content-Length": String(asset.bytes),
    "Content-Disposition": `${disposition}; filename="${fileNameOf(asset)}"`,
  });
  if (req.method === "HEAD") {
    res.status(200).end();
    return;
  }
  await pipeline(open(), res);
}

/**
 * Passes a failure on, unless the response has already begun.
 *
 * Once an image's body has started there is no status left to send; the connection is closed, and
 * the error handler would only fail to write a second response.
 */
function failStream(res, next, error) {
  if (res.headersSent) res.destroy(error);
  else next(error);
}

/** Creates HTTP adapters for the Brand page, and for the signed links that leave it. */
export function createBrandController(brandService) {
  /** Every session handler here answers for one workspace, on behalf of the signed-in owner. */
  function caller(req) {
    return { userId: req.auth.userId, workspaceId: req.validated.workspaceId };
  }

  return {
    /** Returns the system, its images and the pages it was read from. */
    async getBrand(req, res, next) {
      try {
        res.json(await brandService.getBrand(caller(req)));
      } catch (error) { next(error); }
    },

    /** Returns the newest record of what the rendered pages showed. */
    async getLatestObservation(req, res, next) {
      try {
        res.json(await brandService.getLatestObservation(caller(req)));
      } catch (error) { next(error); }
    },

    /** Pins one value. */
    async setPin(req, res, next) {
      try {
        res.json(await brandService.setPin({ ...caller(req), pointer: req.validated.pointer, value: req.validated.value, source: req.validated.source }));
      } catch (error) { next(error); }
    },

    /** Stores one uploaded file in the brand. */
    async upload(req, res, next) {
      try {
        const { bytes, fileName, hint } = req.validated;
        res.status(201).json(await brandService.upload({ ...caller(req), bytes, fileName, hint }));
      } catch (error) { next(error); }
    },

    /** Puts back what one change replaced. */
    async undoChange(req, res, next) {
      try {
        res.json(await brandService.undoChange({ ...caller(req), changeId: req.validated.changeId }));
      } catch (error) { next(error); }
    },

    /** Unpins one value. */
    async removePin(req, res, next) {
      try {
        res.json(await brandService.removePin({ ...caller(req), pointer: req.validated.pointer }));
      } catch (error) { next(error); }
    },

    /**
     * Returns the system in one of the forms it is copied out in, as text.
     *
     * Named as a download, so a client that saves the response saves it under a sensible name;
     * the web app reads the text and offers both copying and saving itself.
     */
    async render(req, res, next) {
      try {
        const rendered = await brandService.render({ ...caller(req), format: req.validated.format });
        res.set({
          "Content-Type": `${rendered.mimeType}; charset=utf-8`,
          "Content-Disposition": `attachment; filename="${rendered.filename}"`,
          "Cache-Control": "private, no-store",
        });
        res.send(rendered.text);
      } catch (error) { next(error); }
    },

    /** Lists the kept earlier versions of the system. */
    async listRevisions(req, res, next) {
      try {
        res.json(await brandService.listRevisions(caller(req)));
      } catch (error) { next(error); }
    },

    /** Puts the system back to a kept version. */
    async restoreRevision(req, res, next) {
      try {
        res.json(await brandService.restoreRevision({ ...caller(req), revision: req.validated.revision }));
      } catch (error) { next(error); }
    },

    /** Lists the workspace's stored images. */
    async listAssets(req, res, next) {
      try {
        res.json(await brandService.listAssets({ ...caller(req), kinds: req.validated.kinds }));
      } catch (error) { next(error); }
    },

    /** Records what a person decided about one image. */
    async updateAsset(req, res, next) {
      try {
        res.json(await brandService.updateAsset({ ...caller(req), assetId: req.validated.assetId, changes: req.validated.changes }));
      } catch (error) { next(error); }
    },

    /**
     * Streams one stored image to the web app.
     *
     * Private and cacheable for a day: an asset's bytes never change under its identifier, and it
     * belongs to one account, so the browser may keep it and nothing between may.
     */
    async getAsset(req, res, next) {
      try {
        const { asset, open } = await brandService.openAsset({ ...caller(req), assetId: req.validated.assetId });
        await sendAsset(req, res, { asset, open, cacheControl: "private, max-age=86400" });
      } catch (error) { failStream(res, next, error); }
    },

    /**
     * Streams one stored image to whoever holds a signed link to it.
     *
     * Any origin may read it — the reader is an AI client's server or an image model, and the
     * signature is the permission — and it may be kept only as long as a link lasts, so a cache
     * cannot go on serving a picture after its link has stopped working.
     */
    async getSignedAsset(req, res, next) {
      try {
        const { asset, open } = await brandService.openSignedAsset(req.validated);
        res.set("Access-Control-Allow-Origin", "*");
        await sendAsset(req, res, { asset, open, cacheControl: "private, max-age=3600" });
      } catch (error) { failStream(res, next, error); }
    },
  };
}
