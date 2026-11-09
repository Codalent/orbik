import { readFileSync } from "node:fs";

import { Router } from "express";

/**
 * The release this API is, from the repository's root manifest: the one version number a release
 * is tagged with, which the web app's footer and the telemetry ping report too.
 */
export const ORBIK_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

/**
 * What this install is, for anyone who asks, signed in or not: the edition and the features its
 * extensions turn on, the release, whether self-service signup is open, and whether the install
 * is still waiting for its first account.
 *
 * The web app is one build for every edition. It reads this before it renders anything an
 * extension contributes, and shows a slot only when the feature it names is listed here — so a
 * self-hosted install, which lists none, shows none.
 *
 * Public on purpose: the sign-in page needs it before there is a session. It says nothing about
 * any account, and `setupRequired` stops being true the moment the first account exists.
 *
 * @param {object} options
 * @param {{edition: () => {name: string, features: string[]}}} options.extensions
 * @param {{signup: "open"|"closed"}} options.config
 * @param {() => Promise<boolean>} options.setupRequired whether no account exists yet
 * @param {"email"|"admin"} [options.passwordReset] how a forgotten password is reset: a link the
 *   person is emailed, or one the install's admin makes for them (no email configured)
 */
export function createEditionRouter({ extensions, config, setupRequired, passwordReset = "admin" }) {
  const router = Router();
  router.get("/v1/edition", async (_req, res, next) => {
    try {
      const { name, features } = extensions.edition();
      res.set("Cache-Control", "no-store");
      res.json({
        edition: name,
        version: ORBIK_VERSION,
        features,
        signup: config.signup,
        passwordReset,
        setupRequired: await setupRequired(),
      });
    } catch (error) { next(error); }
  });
  return router;
}
