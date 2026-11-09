import { DESIGN_SYSTEM_AGENT_SLUG } from "@orbik/core";

import { isWithinLibraryPath } from "./library.js";

/**
 * The brand folder of the Library: where a workspace's design system used to be written down.
 *
 * The Design system agent wrote a guide at `/brand/design-system` until its v3, and every pin on
 * the Brand page rewrote it. Nothing writes here now: the Brand page is where a person reads and
 * corrects the system, and `brand_get` is where an AI reads it. The guides already written were
 * removed once, at the worker's start (`retireBrandGuides` in `agents/src/db/indexes.js`).
 *
 * The path stays reserved the way `/sources` is — no other agent writes inside it, it cannot be
 * moved or deleted, and no chosen top-level folder may take its name — so a folder a person
 * already made under it keeps the protection it had.
 */

/** The folder everything about the brand's look sat under. */
export const BRAND_ROOT_PATH = "/brand";

/** The one agent the store lets write inside the brand folder, as a Library author. */
export const BRAND_WRITER_SLUG = DESIGN_SYSTEM_AGENT_SLUG;

/** Whether a path sits inside the brand folder at all. */
export function isBrandLayerPath(path) {
  return isWithinLibraryPath(path, BRAND_ROOT_PATH);
}
