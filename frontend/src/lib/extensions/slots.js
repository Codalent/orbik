"use client";

import * as extension from "@orbik/web-extensions";

import { apiFetch, apiFetchText } from "@/lib/api/client";
import { featureEnabled, useEdition } from "@/lib/api/edition";

/**
 * What an extension's components are handed to call the API with: the app's own client, so a
 * request carries the session, the CSRF token and the error envelope exactly as a core page's does.
 */
export const extensionApi = Object.freeze({ fetch: apiFetch, fetchText: apiFetchText });

// Every export is optional, so a deployment's package written before a slot existed still builds
// and simply fills none of it. Read by a computed name on purpose: `extension.banners` written out
// is checked by the bundler, and a missing export is a build error.
const exported = (name) => extension[name];
const list = (name) => (Array.isArray(exported(name)) ? exported(name) : []);
const record = (name) => {
  const value = exported(name);
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
};

const railItems = list("railItems");
const pages = record("pages");
const settingsSections = list("settingsSections");
const banners = list("banners");
const agentPages = record("agentPages");
const accountPages = record("accountPages");
const userMenuItems = list("userMenuItems");

/**
 * The extension slots this install shows: every entry of `@orbik/web-extensions` whose feature,
 * when it names one, the API's edition lists. In this repository the package is empty, so every
 * list here is empty and nothing renders.
 *
 * An entry that names a feature waits for the edition to load before it appears; one that names
 * none is shown at once.
 */
export function useExtensionSlots() {
  const { edition, error } = useEdition();
  const shown = (entry) => featureEnabled(edition, entry.feature);

  /**
   * One entry, as `{ status, entry }`: `ready` with it, `loading` while the edition that decides
   * it is read, or `missing`.
   */
  function lookup(entry) {
    if (!entry) return { status: "missing", entry: null };
    if (!entry.feature) return { status: "ready", entry };
    if (!edition && !error) return { status: "loading", entry: null };
    return shown(entry) ? { status: "ready", entry } : { status: "missing", entry: null };
  }
  const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : null);

  return {
    railItems: railItems.filter(shown),
    settingsSections: settingsSections.filter(shown),
    banners: banners.filter(shown),
    userMenuItems: userMenuItems.filter(shown),
    /** The agents an extension gives a place in the Agents overview, as `[slug, entry]` pairs. */
    agentPages: Object.entries(agentPages).filter(([, entry]) => shown(entry)),
    /**
     * The extension page at a path under the workspace, as `{ status, page }`: `ready` with the
     * page, `loading` while the edition that decides it is read, or `missing`.
     */
    page(path) {
      const { status, entry } = lookup(own(pages, path.join("/")) ?? own(pages, path[0]));
      return { status, page: entry };
    },
    /** The settings section with an id, as `{ status, section }`, decided the way {@link page} is. */
    settingsSection(id) {
      const { status, entry } = lookup(settingsSections.find((section) => section.id === id));
      return { status, section: entry };
    },
    /** An extension's entry for an agent, by slug, as `{ status, agent }`, decided the same way. */
    agentPage(slug) {
      const { status, entry } = lookup(own(agentPages, slug));
      return { status, agent: entry };
    },
    /** The account page at a path under /account, as `{ status, page }`, decided the same way. */
    accountPage(path) {
      const { status, entry } = lookup(own(accountPages, path.join("/")) ?? own(accountPages, path[0]));
      return { status, page: entry };
    },
  };
}
