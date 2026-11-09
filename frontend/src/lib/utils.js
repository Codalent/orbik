import { clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge, told about the named type sizes in globals.css (`text-2xs`, `text-compact`,
 * `text-title`). Without them it reads `text-compact` and `text-title` as colours, so a
 * `text-orb-white` beside one in the same `cn()` call silently removed the size.
 */
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["2xs", "compact", "title"] } } });

/** Combines conditional class names and resolves conflicting Tailwind utilities. */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
