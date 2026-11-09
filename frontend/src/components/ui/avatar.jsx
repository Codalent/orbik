import { cn } from "@/lib/utils";

/** A round mark with a person's initial, tinted by their address so a list tells people apart. */
export function Avatar({ email, className }) {
  const letter = (String(email ?? "").match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
  const tints = ["bg-orb-lime/15 text-orb-lime", "bg-orb-cyan/15 text-orb-cyan", "bg-orb-orange/15 text-orb-orange", "bg-orb-gray/15 text-orb-white"];
  let hash = 0;
  for (const char of String(email ?? "")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (
    <span aria-hidden="true" className={cn("flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold", tints[hash % tints.length], className)}>
      {letter}
    </span>
  );
}
