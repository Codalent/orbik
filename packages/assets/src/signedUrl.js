import { createHmac, timingSafeEqual } from "node:crypto";

import { BRAND_LIMITS } from "@orbik/core";

/** Where a signed link points: a route with no session, on the API's own listener. */
export const SIGNED_ASSET_PATH = "/v1/brand-assets";

/**
 * Creates the signer behind the links an outside AI fetches a brand asset by.
 *
 * A person's Claude or ChatGPT has no Orbik session and cannot be given one, and an image model
 * can only be handed a URL. So an asset is reachable from outside by a link that carries its own
 * permission: the asset, when the permission ends, and an HMAC over both and the workspace the
 * asset belongs to. Nothing is stored per link — checking one is arithmetic — which is what lets a
 * tool answer with a dozen of them without a dozen writes.
 *
 * Two properties are worth stating.
 *
 * **A link is for one asset of one workspace.** The workspace is inside the signature but not in
 * the link, so it is read from the asset's own row when the link is checked: a link cannot be
 * edited to reach another asset, and an asset that changed hands stops answering to old links.
 *
 * **Links are short-lived and revocable only all at once.** One hour is long enough for a chat
 * session to fetch what a tool handed it and short enough that a link pasted somewhere public goes
 * dead by itself. Rotating the secret is the one way to end every outstanding link early.
 *
 * @param {object} options
 * @param {string} options.secret `ORBIK_ASSET_URL_SECRET`; at least 32 characters
 * @param {string} options.baseUrl the API's public origin, which is what a link starts with
 * @param {number} [options.ttlSeconds] how long a link works
 * @param {() => Date} [options.now] clock
 */
export function createAssetUrlSigner({ secret, baseUrl, ttlSeconds = BRAND_LIMITS.urlTtlSeconds, now = () => new Date() }) {
  const origin = String(baseUrl).replace(/\/+$/, "");

  /** The signature of one permission, as URL-safe text. */
  function signatureOf(assetId, workspaceId, expires) {
    return createHmac("sha256", secret).update(`${assetId}.${workspaceId}.${expires}`).digest("base64url");
  }

  return {
    /** How long a link minted now will work, in seconds. */
    ttlSeconds,

    /**
     * Mints a link to one asset.
     *
     * @param {object} input
     * @param {unknown} input.assetId the asset
     * @param {unknown} input.workspaceId the workspace it belongs to
     * @returns {{url: string, expiresAt: string}}
     */
    sign({ assetId, workspaceId }) {
      const expires = Math.floor(now().getTime() / 1000) + ttlSeconds;
      const signature = signatureOf(String(assetId), String(workspaceId), expires);
      return {
        url: `${origin}${SIGNED_ASSET_PATH}/${String(assetId)}?exp=${expires}&sig=${signature}`,
        expiresAt: new Date(expires * 1000).toISOString(),
      };
    },

    /**
     * Checks a link against the asset it names.
     *
     * @param {object} input
     * @param {unknown} input.assetId from the link's path
     * @param {unknown} input.workspaceId from the asset's own row, never from the link
     * @param {unknown} input.exp from the link's query
     * @param {unknown} input.sig from the link's query
     * @returns {"ok"|"expired"|"invalid"}
     */
    verify({ assetId, workspaceId, exp, sig }) {
      const expires = Number(exp);
      if (!Number.isInteger(expires) || typeof sig !== "string" || !sig) return "invalid";
      const expected = Buffer.from(signatureOf(String(assetId), String(workspaceId), expires));
      const provided = Buffer.from(sig);
      if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return "invalid";
      // Checked after the signature, so only somebody holding a real link learns that it expired.
      return expires * 1000 < now().getTime() ? "expired" : "ok";
    },
  };
}
