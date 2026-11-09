"use client";

import { useEffect } from "react";

import { getApiBaseUrl } from "@/lib/api/client";

const STORAGE_KEY = "orbik.devbar.key";

/**
 * Takes `?devbar=<key>` off the address, keeping it in this browser; `?devbar=off` forgets it.
 * Returns the key this browser holds, or null.
 */
function takeKey() {
  try {
    const url = new URL(window.location.href);
    const given = url.searchParams.get("devbar");
    if (given !== null) {
      if (/^[A-Za-z0-9_-]{24,}$/.test(given)) window.localStorage.setItem(STORAGE_KEY, given);
      else if (given === "off") window.localStorage.removeItem(STORAGE_KEY);
      url.searchParams.delete("devbar");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * devbar, the development toolbar, when the API has it on (ORBIK_DEVBAR in backend/.env) and this
 * browser was given its key (ORBIK_DEVBAR_KEY), by opening any page once with `?devbar=<key>`.
 *
 * Without a key it asks nothing. With one it asks /v1/devbar/api/health once and, only when that
 * answers, loads the widget (`@codalent/devbar/client`, its own chunk) and mounts it with the key. A wrong
 * key, or devbar off, is a 404 and nothing else is loaded.
 */
export function DevBarLoader() {
  useEffect(() => {
    const key = takeKey();
    if (!key) return undefined;
    const server = `${getApiBaseUrl()}/v1/devbar`;
    let cancelled = false;
    fetch(`${server}/api/health`, { cache: "no-store", headers: { "X-Devbar-Key": key } })
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        const { mount } = await import("@codalent/devbar/client");
        if (!cancelled) mount({ server, enabled: true, key });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return null;
}
