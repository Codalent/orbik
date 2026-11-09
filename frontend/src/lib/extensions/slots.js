"use client";

import { banners, pages, railItems, settingsSections } from "@orbik/web-extensions";

import { apiFetch, apiFetchText } from "@/lib/api/client";
import { featureEnabled, useEdition } from "@/lib/api/edition";

/**
 * What an extension's components are handed to call the API with: the app's own client, so a
 * request carries the session, the CSRF token and the error envelope exactly as a core page's does.
 */
export const extensionApi = Object.freeze({ fetch: apiFetch, fetchText: apiFetchText });

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
  return {
    railItems: railItems.filter(shown),
    settingsSections: settingsSections.filter(shown),
    banners: banners.filter(shown),
    /**
     * The extension page at a path under the workspace, as `{ status, page }`: `ready` with the
     * page, `loading` while the edition that decides it is read, or `missing`.
     */
    page(path) {
      const own = (key) => (Object.hasOwn(pages, key) ? pages[key] : null);
      const entry = own(path.join("/")) ?? own(path[0]);
      if (!entry) return { status: "missing", page: null };
      if (!entry.feature) return { status: "ready", page: entry };
      if (!edition && !error) return { status: "loading", page: null };
      return shown(entry) ? { status: "ready", page: entry } : { status: "missing", page: null };
    },
    /**
     * The settings section with an id, as `{ status, section }`, decided the way {@link page} is:
     * `ready` with the section, `loading` while the edition that decides it is read, or `missing`.
     */
    settingsSection(id) {
      const entry = settingsSections.find((section) => section.id === id);
      if (!entry) return { status: "missing", section: null };
      if (!entry.feature) return { status: "ready", section: entry };
      if (!edition && !error) return { status: "loading", section: null };
      return shown(entry) ? { status: "ready", section: entry } : { status: "missing", section: null };
    },
  };
}
