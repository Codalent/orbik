import { cn } from "@/lib/utils";

/**
 * Small marks of state: a pill (a word in a rounded outline) and a status dot.
 *
 * The tones carry fixed meanings across the app (docs/architecture/ui.md): lime is done, healthy or moving;
 * cyan is information and admins; orange wants a look (a choice to make); coral
 * is failure; neutral and muted are kinds and labels with no judgement.
 */

/** Each tone's outline, fill and text. */
export const PILL_TONES = Object.freeze({
  neutral: "border-orb-line bg-orb-space/60 text-orb-gray",
  lime: "border-orb-lime/40 bg-orb-lime/10 text-orb-lime",
  cyan: "border-orb-cyan/40 bg-orb-cyan/10 text-orb-cyan",
  orange: "border-orb-orange/40 bg-orb-orange/10 text-orb-orange",
  coral: "border-orb-coral/40 bg-orb-coral/10 text-orb-coral",
  muted: "border-orb-line bg-transparent text-orb-muted",
});

/** A short status or kind, in a rounded outline. `dot` puts a dot of its colour before it. */
export function Pill({ tone = "neutral", dot = false, pulse = false, className, children, ...props }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium leading-4", PILL_TONES[tone] ?? PILL_TONES.neutral, className)} {...props}>
      {dot && <span aria-hidden="true" className={cn("size-1.5 rounded-full bg-current", pulse && "motion-safe:animate-pulse")} />}
      {children}
    </span>
  );
}

/** Each dot tone's fill. "idle" is a hollow ring: nothing yet. */
const DOT_TONES = Object.freeze({
  lime: "bg-orb-lime",
  cyan: "bg-orb-cyan",
  orange: "bg-orb-orange",
  coral: "bg-orb-coral",
  neutral: "bg-orb-muted",
  idle: "border border-orb-muted",
});

/**
 * A status dot. Decorative unless given a `label`, which is read out instead. `pulse` while
 * something is moving.
 */
export function StatusDot({ tone = "neutral", pulse = false, label, className }) {
  return (
    <span className={cn("inline-block size-1.5 shrink-0 rounded-full", DOT_TONES[tone] ?? DOT_TONES.neutral, pulse && "motion-safe:animate-pulse", className)} aria-hidden={label ? undefined : "true"} role={label ? "img" : undefined} aria-label={label} />
  );
}
