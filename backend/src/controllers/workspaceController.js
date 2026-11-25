/**
 * What an icon is served under. It may have come from somebody else's website, and an SVG is a
 * document that can carry script, so it is sent as a picture and nothing more — the brand images'
 * policy (`brandController.js`): the stored type, no sniffing, nothing loaded or run, sandboxed.
 */
const ICON_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

/** Creates HTTP adapters for workspace use cases. */
export function createWorkspaceController(workspaceService) {
  return {
    /** Maps a validated idempotent creation to 201 or replay status 200. */
    async create(req, res, next) {
      try {
        const result = await workspaceService.create({ userId: req.auth.userId, ...req.validated });
        const { created, ...body } = result;
        res.set("Idempotency-Replayed", String(!created)).status(created ? 201 : 200).json(body);
      } catch (error) { next(error); }
    },
    /** Returns only the authenticated owner's safe workspace summaries. */
    async list(req, res, next) {
      try { res.json(await workspaceService.list({ userId: req.auth.userId })); } catch (error) { next(error); }
    },
    /** Applies a validated change of name or website; admins and the owner. */
    async update(req, res, next) {
      try { res.json(await workspaceService.update({ userId: req.auth.userId, ...req.validated })); } catch (error) { next(error); }
    },
    /** Deletes the workspace and everything in it; the owner, with its name repeated. */
    async remove(req, res, next) {
      try { res.json(await workspaceService.remove({ userId: req.auth.userId, ...req.validated })); } catch (error) { next(error); }
    },
    /** Maps an owner-authorized workspace selection to its mutation response. */
    async select(req, res, next) {
      try { res.json(await workspaceService.select({ userId: req.auth.userId, workspaceId: req.validated.workspaceId })); } catch (error) { next(error); }
    },

    /**
     * Sends one of the workspace's icons as the picture it is.
     *
     * Private and cacheable for a day, like a brand image: the address carries the picture's
     * version (`?v=`), so a new icon is a new address and a kept copy is never the wrong one. The
     * entity tag is the hash of the bytes.
     */
    async getIcon(req, res, next) {
      try {
        const icon = await workspaceService.openIcon({ userId: req.auth.userId, ...req.validated });
        const etag = `"${icon.hash}"`;
        res.set({
          ETag: etag,
          "Cache-Control": "private, max-age=86400",
          "Content-Security-Policy": ICON_POLICY,
          "X-Content-Type-Options": "nosniff",
          // The web app that shows it may be on another origin; the reader has a session.
          "Cross-Origin-Resource-Policy": "cross-origin",
        });
        if (req.get("If-None-Match") === etag) {
          res.status(304).end();
          return;
        }
        res.set({ "Content-Type": icon.mimeType, "Content-Length": String(icon.bytes), "Content-Disposition": "inline" });
        res.status(200).end(req.method === "HEAD" ? undefined : icon.data);
      } catch (error) { next(error); }
    },

    /** Keeps an uploaded picture as the workspace's icon and shows it; admins and the owner. */
    async uploadIcon(req, res, next) {
      try { res.status(201).json(await workspaceService.uploadIcon({ userId: req.auth.userId, ...req.validated })); } catch (error) { next(error); }
    },

    /** Chooses the website's icon, the upload or the letter; admins and the owner. */
    async chooseIcon(req, res, next) {
      try { res.json(await workspaceService.chooseIcon({ userId: req.auth.userId, ...req.validated })); } catch (error) { next(error); }
    },
  };
}
