"use client";

import { cn } from "@/lib/utils";

/**
 * An on/off switch with its words beside it, drawn as the Library's lock switch is: lime when on.
 * The whole row is the control, so the words are what a person clicks.
 *
 * @param {object} props
 * @param {boolean} props.checked
 * @param {(next: boolean) => void} props.onChange
 * @param {string} props.title what turning it on does
 * @param {import("react").ReactNode} [props.detail] a line on what that means
 */
export function Switch({ checked, onChange, title, detail, disabled = false, className }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn("flex w-full items-start gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-orb-lime/70 disabled:opacity-60", className)}
    >
      <span aria-hidden="true" className={cn("relative mt-0.5 h-[18px] w-8 shrink-0 rounded-full transition-colors", checked ? "bg-primary" : "bg-orb-line")}>
        <span className={cn("absolute top-0.5 size-3.5 rounded-full transition-all", checked ? "left-4 bg-primary-foreground" : "left-0.5 bg-orb-white")} />
      </span>
      <span>
        <span className="block text-sm font-medium text-orb-white">{title}</span>
        {detail && <span className="mt-0.5 block text-compact leading-[18px] text-orb-muted">{detail}</span>}
      </span>
    </button>
  );
}
