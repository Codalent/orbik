"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/** Where the panel's open and wide states are remembered, so a reload keeps the panel as it was. */
const OPEN_KEY = "orbik.ask.open";
const WIDE_KEY = "orbik.ask.wide";

/** How the shortcut is written where it is shown. */
export const ASK_SHORTCUT = "⌘J";

const AskPanelContext = createContext(null);

/** Reads a remembered flag; storage that cannot be read (private mode, a quota) reads as off. */
function remembered(key) {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** Remembers a flag, quietly: a panel that does not reopen after a reload is not worth an error. */
function remember(key, value) {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Nothing to do: the panel still works for this visit.
  }
}

/**
 * The Ask panel's state, for every page of a workspace: whether it is open, whether it is wide, and
 * a question somebody else put in it.
 *
 * It lives in the workspace shell rather than in a page because the panel is meant to stay open
 * while the person moves around: they ask about a file, open what the answer cites, and carry on
 * the same conversation from the page they landed on. A page asks for the panel through
 * {@link useAskPanel} — the Library's quick switcher does, with what was typed into it — and the
 * shell renders it.
 *
 * ⌘J (Ctrl+J elsewhere) opens and closes it from anywhere. J rather than K or O, which the Library
 * already uses for its own search, and rather than I, which an editor uses for italics.
 */
export function AskPanelProvider({ children }) {
  // Read from storage on the first client render. Nothing that depends on them is in the server's
  // markup — the shell draws its chrome only once the workspace list has loaded in the browser — so
  // reading them here cannot make the first client render disagree with it.
  const [open, setOpenState] = useState(() => typeof window !== "undefined" && remembered(OPEN_KEY));
  const [wide, setWideState] = useState(() => typeof window !== "undefined" && remembered(WIDE_KEY));
  // A question put in the box by something other than the person typing — the Library's quick
  // switcher, an `/ask?q=` link. Carries a counter so asking for the same words twice still lands.
  const [draft, setDraft] = useState(null);

  const setOpen = useCallback((value) => {
    setOpenState((current) => {
      const next = typeof value === "function" ? value(current) : Boolean(value);
      remember(OPEN_KEY, next);
      return next;
    });
  }, []);

  const setWide = useCallback((value) => {
    setWideState((current) => {
      const next = typeof value === "function" ? value(current) : Boolean(value);
      remember(WIDE_KEY, next);
      return next;
    });
  }, []);

  const toggle = useCallback(() => setOpen((current) => !current), [setOpen]);

  /** Opens the panel with a question in the box, to be read and sent by the person, not sent. */
  const askAbout = useCallback((text) => {
    setDraft((current) => ({ text: String(text ?? "").slice(0, 1000), seq: (current?.seq ?? 0) + 1 }));
    setOpen(true);
  }, [setOpen]);

  // Files dropped somewhere on a page — the Brand page's sections — for the panel to upload and
  // send. Carries a counter, like the draft, so dropping the same file twice still lands.
  const [dropped, setDropped] = useState(null);

  /**
   * Hands files to the panel to upload and send at once, opening it. `section` says where on the
   * page they were dropped (logos, colours, type, images), which tells the chat what they are for.
   */
  const sendFiles = useCallback((files, section = null) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    setDropped((current) => ({ files: list, section, seq: (current?.seq ?? 0) + 1 }));
    setOpen(true);
  }, [setOpen]);

  useEffect(() => {
    function onKeyDown(event) {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        toggle();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [toggle]);

  const value = useMemo(
    () => ({ open, setOpen, toggle, wide, setWide, draft, askAbout, dropped, sendFiles }),
    [open, setOpen, toggle, wide, setWide, draft, askAbout, dropped, sendFiles],
  );
  return <AskPanelContext.Provider value={value}>{children}</AskPanelContext.Provider>;
}

/**
 * The Ask panel, from any component inside a workspace. Outside one there is no panel, and this
 * returns null rather than throwing, so a shared component can offer "Ask" only where it works.
 */
export function useAskPanel() {
  return useContext(AskPanelContext);
}
