"use client";

import { createContext, useContext } from "react";

/**
 * What every part of the Library page shares: the Library as last read, the agent's state, and
 * the actions that write to it or move between files.
 *
 * Held in one context rather than handed down, because the page is a workspace of panes, tabs and
 * views several levels deep, and nearly every one of them can open a file, start an edit or ask
 * for a file's title. The workspace component owns all of it; everything below only reads.
 */
export const LibraryContext = createContext(null);

/** The Library page's shared state and actions. Only inside `LibraryWorkspace`. */
export function useLibrary() {
  const value = useContext(LibraryContext);
  if (!value) throw new Error("useLibrary is only available inside the Library workspace.");
  return value;
}

/**
 * Where a click asks for something to open, from the keys held while making it.
 *
 * Shift opens it in the pane to the right, so it can be read beside what is open; Cmd, Ctrl, Alt
 * or the middle button open it in a new tab; a plain click opens it in place, as a link does.
 *
 * @param {MouseEvent|KeyboardEvent|undefined} event
 * @returns {"current"|"tab"|"right"}
 */
export function targetOf(event) {
  if (event?.shiftKey) return "right";
  if (event?.metaKey || event?.ctrlKey || event?.altKey || event?.button === 1) return "tab";
  return "current";
}
