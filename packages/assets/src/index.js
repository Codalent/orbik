/**
 * Public surface of `@orbik/assets`.
 *
 * The one place Orbik keeps binary files: the images of a workspace's brand. The agents worker
 * stores what it harvests, the API streams it to the web app and to outside AIs, and both go
 * through the same store so neither has its own idea of where a picture lives or what a person's
 * decision about one means. The signer beside it mints and checks the links that carry an asset
 * out of Orbik.
 *
 * A name is exported only when something outside this package imports it.
 */
export { createAssetStore } from "./store.js";
export { SIGNED_ASSET_PATH, createAssetUrlSigner } from "./signedUrl.js";
export { looksLikeSvg, sanitiseSvg } from "./svg.js";
