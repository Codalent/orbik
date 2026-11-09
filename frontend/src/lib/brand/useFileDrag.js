"use client";

import { useEffect, useState } from "react";

/** Whether a drag carries files, rather than text or a link being moved within the page. */
export function carriesFiles(event) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/**
 * Whether files are being dragged anywhere over the window, so drop zones can show themselves
 * only while there is something to drop.
 *
 * Counted, because `dragenter` and `dragleave` fire for every element crossed on the way: the drag
 * has left the window only when they balance. A drop anywhere, or the drag ending outside, resets
 * it. A drop that lands outside every drop zone is swallowed, so the browser does not navigate
 * away to show the file.
 *
 * @param {boolean} [enabled] off for a person who cannot add files
 * @returns {boolean}
 */
export function useFileDrag(enabled = true) {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!enabled) return undefined;
    let depth = 0;
    const enter = (event) => {
      if (!carriesFiles(event)) return;
      depth += 1;
      setDragging(true);
    };
    const leave = (event) => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (event) => {
      if (carriesFiles(event)) event.preventDefault();
    };
    const end = (event) => {
      depth = 0;
      setDragging(false);
      if (event.type === "drop" && carriesFiles(event)) event.preventDefault();
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", end);
    window.addEventListener("dragend", end);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", end);
      window.removeEventListener("dragend", end);
    };
  }, [enabled]);

  return enabled && dragging;
}
