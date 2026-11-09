/**
 * Version of the running application, inlined at build time by `next.config.mjs` from the frontend
 * package manifest so the displayed value cannot drift from the deployed build.
 *
 * A build that did not inline it leaves this empty, which callers render as "no version" rather
 * than as a bare `v`.
 */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "";
