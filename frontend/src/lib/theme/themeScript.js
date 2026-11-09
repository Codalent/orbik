/**
 * The colour theme, as the person chose it in the account menu: `dark`, `light` or `system`
 * (follow the operating system). Kept in this browser's localStorage, so it is per device.
 * Nothing stored means dark, which is how Orbik looked before there was a choice.
 *
 * This file is plain JavaScript so the root layout, a server component, can inline the script.
 */
export const THEME_STORAGE_KEY = "orbik-theme";

export const THEME_PREFERENCES = ["dark", "light", "system"];

/**
 * Runs in <head> while the HTML is parsed, before anything is painted, and puts the resolved
 * theme on <html> as `data-theme`. Without it a light-mode page would flash dark on every load.
 * It mirrors `resolveTheme` in ./ThemeProvider.jsx; keep the two in step.
 */
export const THEME_SCRIPT = `(function(){try{var p=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});var l=p==="light"||(p==="system"&&matchMedia("(prefers-color-scheme: light)").matches);document.documentElement.setAttribute("data-theme",l?"light":"dark")}catch(e){}})()`;
