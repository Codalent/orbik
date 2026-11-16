"use client";

import { useSyncExternalStore } from "react";

/**
 * Keyboard shortcuts as each platform writes them: ⌘J on Apple devices, Ctrl+J on Windows and
 * Linux. Every handler in the app accepts either modifier (`event.metaKey || event.ctrlKey`); this
 * is only about the glyph a person is shown.
 *
 * Which platform it is can only be known in the browser, so the server's markup carries no glyph
 * and the first client render agrees with it: `useSyncExternalStore` renders the server snapshot
 * (nothing) while hydrating and the browser's answer straight after, with no mismatch.
 */

/** Whether this browser runs on an Apple device. iPadOS calls itself a Mac, which is right here. */
function appleDevice() {
  const nav = window.navigator;
  const platform = nav.userAgentData?.platform || nav.platform || "";
  return /mac|iphone|ipad|ipod/i.test(platform) || (!platform && /Mac OS X|iPhone|iPad/.test(nav.userAgent ?? ""));
}

/** The platform never changes while a page is open, so there is nothing to subscribe to. */
function subscribe() {
  return () => {};
}

/** Null on the server and while hydrating; then whether this is an Apple device. */
export function useAppleDevice() {
  return useSyncExternalStore(subscribe, appleDevice, () => null);
}

/** Keys written after the modifier, in each platform's own spelling. */
const KEY_NAMES = Object.freeze({ Enter: { apple: "↵", other: "Enter" } });

/**
 * A shortcut with the platform's command modifier: "⌘J" on Apple, "Ctrl+J" elsewhere.
 *
 * @param {boolean} apple
 * @param {string} key the key after the modifier: a letter, or "Enter"
 */
export function formatShortcut(apple, key) {
  const name = KEY_NAMES[key]?.[apple ? "apple" : "other"] ?? key.toUpperCase();
  return apple ? `⌘${name}` : `Ctrl+${name}`;
}

/**
 * The shortcut for the command modifier and `key`, as this platform writes it, or an empty string
 * until the browser has said which platform it is (show nothing rather than the wrong glyph).
 *
 * @param {string} key
 */
export function useShortcut(key) {
  const apple = useAppleDevice();
  return apple === null ? "" : formatShortcut(apple, key);
}
