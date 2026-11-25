import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Each tone's tile: a tinted outline and fill, the figure in the tone's colour and a dot of it by
 * the label, and a deeper tint under the pointer when the tile is a link. The tones mean what they
 * mean everywhere (docs/architecture/ui.md): lime done or healthy, cyan information, orange wants
 * a look, coral failed.
 */
const TILE_TONES = Object.freeze({
  good: { tile: "border-orb-lime/30 bg-orb-lime/6", hover: "hover:border-orb-lime/50 hover:bg-orb-lime/10", value: "text-orb-lime", dot: "bg-orb-lime" },
  info: { tile: "border-orb-cyan/30 bg-orb-cyan/6", hover: "hover:border-orb-cyan/50 hover:bg-orb-cyan/10", value: "text-orb-cyan", dot: "bg-orb-cyan" },
  attention: { tile: "border-orb-orange/35 bg-orb-orange/8", hover: "hover:border-orb-orange/55 hover:bg-orb-orange/12", value: "text-orb-orange", dot: "bg-orb-orange" },
  failed: { tile: "border-orb-coral/35 bg-orb-coral/8", hover: "hover:border-orb-coral/55 hover:bg-orb-coral/12", value: "text-orb-coral", dot: "bg-orb-coral" },
});

/**
 * One headline figure: what it counts, the number, one line of context, and — given `href` — the
 * page it opens. Its tone colours the whole tile, so a figure that wants a look is seen from
 * across the room: `good` (lime) done or healthy, `info` (cyan) worth knowing, `attention`
 * (orange) something waiting, `failed` (coral) something failed. `live` puts a pulsing lime dot by
 * the label while it is moving. Used on Home, the Agents page, Sources and at the top of an
 * agent's page, in a grid of two to five.
 */
export function StatTile({ href, icon: Icon, label, value, detail, live = false, tone = null, className }) {
  const toned = TILE_TONES[tone] ?? null;
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-xs font-medium text-orb-muted">
        {Icon && <Icon aria-hidden="true" className="size-3.5" />}
        <span className="truncate">{label}</span>
        {(live || toned) && (
          <span
            aria-hidden="true"
            className={cn("ml-auto size-1.5 shrink-0 rounded-full", live ? "bg-orb-lime motion-safe:animate-pulse" : toned.dot)}
          />
        )}
      </span>
      <span className={cn("mt-2 block font-display text-[2rem] font-bold leading-none tracking-[-0.03em] tabular-nums", toned?.value ?? "text-orb-white")}>{value}</span>
      {detail && <span className="mt-2 line-clamp-2 block pr-4 text-xs text-orb-gray">{detail}</span>}
      {href && <ArrowUpRight aria-hidden="true" className="absolute bottom-3.5 right-3 size-3.5 text-orb-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />}
    </>
  );
  const frame = cn("group relative min-w-0 rounded-xl border border-orb-line bg-orb-raised/40 px-4 pb-3.5 pt-3", toned?.tile);
  return href ? (
    <Link
      href={href}
      className={cn(
        frame,
        "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
        toned?.hover ?? "hover:border-orb-muted/50 hover:bg-orb-raised/70",
        className,
      )}
    >
      {body}
    </Link>
  ) : (
    <div className={cn(frame, className)}>{body}</div>
  );
}
