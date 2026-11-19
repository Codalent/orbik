"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { X } from "lucide-react";

import { OrbikMark } from "@/components/OrbikLogo";
import { useAskPanel, useAskShortcut } from "@/lib/ask/askPanel";

/** Where the dot was last left, so a reload puts it back in the same corner. */
const CORNER_KEY = "orbik.ask.dot";
const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"];
const SIZE = 36;
const MARGIN = 20;
/** How far a press must travel before it is a drag rather than a click. */
const DRAG_THRESHOLD = 4;

function rememberedCorner() {
  try {
    const saved = window.localStorage.getItem(CORNER_KEY);
    return CORNERS.includes(saved) ? saved : "bottom-right";
  } catch {
    return "bottom-right";
  }
}

/** From this width up Ask is a column beside the app (Tailwind's `md`); below it, it covers the page. */
const COLUMN_FROM = 768;

/**
 * The part of the window the dot keeps to. With Ask open as a column the right-hand corners are the
 * framed app's, not the window's, so the dot never sits on the conversation's composer: the column
 * is 25rem (38rem wide) with the surround's 0.5rem padding and the 0.5rem gap beside it.
 */
function area(open, wide) {
  const viewport = document.documentElement.clientWidth || window.innerWidth;
  const height = document.documentElement.clientHeight || window.innerHeight;
  if (!open || viewport < COLUMN_FROM) return { width: viewport, height };
  const rem = parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
  return { width: viewport - (wide ? 38 : 25) * rem - rem, height };
}

/** The top-left point of the dot sitting in a corner of the area. */
function cornerPoint(corner, { width, height }) {
  return {
    x: corner.endsWith("left") ? MARGIN : width - MARGIN - SIZE,
    y: corner.startsWith("top") ? MARGIN : height - MARGIN - SIZE,
  };
}

/** The corner nearest to where the dot was let go: whichever quarter of the window its centre is in. */
function nearestCorner(x, y, { width, height }) {
  const vertical = y + SIZE / 2 < height / 2 ? "top" : "bottom";
  const horizontal = x + SIZE / 2 < width / 2 ? "left" : "right";
  return `${vertical}-${horizontal}`;
}

/**
 * Ask AI from a corner of the window: a small lime dot, drawn like devbar's, that opens and closes
 * the Ask column and does nothing else — no menu, no options. While the column is open it turns into
 * a cross. It can be dragged anywhere and, let go, springs to the nearest corner, which it keeps
 * across reloads; with the column open the corners are the framed app's, beside the column.
 */
export function AskLauncher() {
  const panel = useAskPanel();
  const shortcut = useAskShortcut();
  const [corner, setCorner] = useState(() => (typeof window === "undefined" ? "bottom-right" : rememberedCorner()));
  // Where the dot is drawn: its corner's point, or under the pointer while it is dragged.
  const [point, setPoint] = useState(null);
  const [dragging, setDragging] = useState(false);
  const press = useRef(null);
  // Set when a press turned into a drag, so the click that ends it does not open the column.
  const dragged = useRef(false);

  const open = Boolean(panel?.open);
  const wide = Boolean(panel?.wide);

  // The corner's point, now, whenever the window changes size, and as the column opens, closes or
  // widens: the dot rides along to the framed app's corner with the same spring it snaps with.
  useEffect(() => {
    const place = () => setPoint(cornerPoint(corner, area(open, wide)));
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [corner, open, wide]);

  const onPointerDown = useCallback((event) => {
    if (event.button !== 0 || !point) return;
    dragged.current = false;
    press.current = { startX: event.clientX, startY: event.clientY, offsetX: event.clientX - point.x, offsetY: event.clientY - point.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [point]);

  const onPointerMove = useCallback((event) => {
    const start = press.current;
    if (!start) return;
    if (!dragged.current) {
      if (Math.hypot(event.clientX - start.startX, event.clientY - start.startY) < DRAG_THRESHOLD) return;
      dragged.current = true;
      setDragging(true);
    }
    const width = document.documentElement.clientWidth || window.innerWidth;
    const height = document.documentElement.clientHeight || window.innerHeight;
    setPoint({
      x: Math.min(Math.max(event.clientX - start.offsetX, 0), width - SIZE),
      y: Math.min(Math.max(event.clientY - start.offsetY, 0), height - SIZE),
    });
  }, []);

  const onPointerUp = useCallback((event) => {
    if (!press.current) return;
    press.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!dragged.current) return;
    setDragging(false);
    const bounds = area(open, wide);
    const next = nearestCorner(point?.x ?? 0, point?.y ?? 0, bounds);
    try {
      window.localStorage.setItem(CORNER_KEY, next);
    } catch {
      // The dot still snaps; it just will not remember the corner after a reload.
    }
    setCorner(next);
    setPoint(cornerPoint(next, bounds));
  }, [point, open, wide]);

  if (!panel || !point) return null;

  const label = `${open ? "Close Ask AI" : "Ask AI"}${shortcut ? ` (${shortcut})` : ""}`;
  return (
    <button
      type="button"
      onClick={() => {
        if (dragged.current) {
          dragged.current = false;
          return;
        }
        panel.toggle();
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      aria-label={label}
      aria-expanded={open}
      title={dragging ? undefined : label}
      data-working={panel.working && !open ? "" : undefined}
      data-dragging={dragging ? "" : undefined}
      data-open={open ? "" : undefined}
      style={{ left: point.x, top: point.y }}
      className="ask-dot fixed z-50"
    >
      {/* The mark and the cross share the spot and turn past each other, as devbar's plus turns into its cross. */}
      <OrbikMark className="ask-dot-mark pointer-events-none col-start-1 row-start-1 size-[18px]" />
      <X aria-hidden="true" strokeWidth={2.5} className="ask-dot-close pointer-events-none col-start-1 row-start-1 size-4" />
    </button>
  );
}
