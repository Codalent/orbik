"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useState } from "react";

import { THEME_PREFERENCES, THEME_STORAGE_KEY } from "./themeScript";

const LIGHT_QUERY = "(prefers-color-scheme: light)";

const ThemeContext = createContext({ preference: "dark", setPreference: () => {} });

function readPreference() {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return THEME_PREFERENCES.includes(stored) ? stored : "dark";
  } catch {
    return "dark";
  }
}

/** The theme a preference shows right now. Mirrors THEME_SCRIPT in ./themeScript.js. */
function resolveTheme(preference) {
  if (preference === "light") return "light";
  if (preference === "system" && window.matchMedia(LIGHT_QUERY).matches) return "light";
  return "dark";
}

function applyTheme(preference) {
  document.documentElement.setAttribute("data-theme", resolveTheme(preference));
}

/**
 * Holds the theme preference and keeps `data-theme` on <html> in step with it. The inline
 * script in the root layout sets the attribute before first paint; this takes over after
 * hydration — re-applying it after React's development remount resets <html>, following the
 * operating system while the preference is `system`, and following a change made in another tab.
 */
export function ThemeProvider({ children }) {
  // Read on the client from the start. Nothing this renders depends on it during hydration — the
  // top bar's ThemeSwitch that shows it renders only once the client has a session — so the
  // server's "dark" cannot cause a mismatch.
  const [preference, setPreferenceState] = useState(() => (typeof window === "undefined" ? "dark" : readPreference()));

  // A layout effect, so a remount's reset of <html> is undone before the browser paints.
  useLayoutEffect(() => {
    applyTheme(preference);
    if (preference !== "system") return undefined;
    const media = window.matchMedia(LIGHT_QUERY);
    const follow = () => applyTheme("system");
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, [preference]);

  useEffect(() => {
    const onStorage = (event) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      setPreferenceState(readPreference());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setPreference = useCallback((next) => {
    if (!THEME_PREFERENCES.includes(next)) return;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Private windows can refuse storage; the choice still holds for this page.
    }
    setPreferenceState(next);
    applyTheme(next);
  }, []);

  return <ThemeContext.Provider value={{ preference, setPreference }}>{children}</ThemeContext.Provider>;
}

/** The person's theme preference (`dark`, `light` or `system`) and a way to change it. */
export function useTheme() {
  return useContext(ThemeContext);
}
