import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * One headline figure: what it counts, the number, one line of context, and — given `href` — the
 * page it opens. Its tone marks a figure that wants a look: lime while it is moving (`live`),
 * orange with something waiting, coral when something failed. Used on Home, the Agents page and
 * at the top of an agent's page, in a grid of two to four.
 */
export function StatTile({ href, icon: Icon, label, value, detail, live = false, tone = null, className }) {
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-xs font-medium text-orb-muted">
        {Icon && <Icon aria-hidden="true" className="size-3.5" />}
        <span className="truncate">{label}</span>
        {(live || tone) && (
          <span
            aria-hidden="true"
            className={cn(
              "ml-auto size-1.5 shrink-0 rounded-full",
              live && "bg-orb-lime motion-safe:animate-pulse",
              !live && tone === "attention" && "bg-orb-orange",
              !live && tone === "failed" && "bg-orb-coral",
              !live && tone === "good" && "bg-orb-lime",
            )}
          />
        )}
      </span>
      <span className="mt-2 block font-display text-[2rem] font-bold leading-none tracking-[-0.03em] tabular-nums text-orb-white">{value}</span>
      {detail && <span className="mt-2 line-clamp-2 block pr-4 text-xs text-orb-gray">{detail}</span>}
      {href && <ArrowUpRight aria-hidden="true" className="absolute bottom-3.5 right-3 size-3.5 text-orb-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />}
    </>
  );
  const frame = "group relative min-w-0 rounded-xl border border-orb-line bg-orb-raised/40 px-4 pb-3.5 pt-3";
  return href ? (
    <Link href={href} className={cn(frame, "transition-colors hover:border-orb-muted/50 hover:bg-orb-raised/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70", className)}>
      {body}
    </Link>
  ) : (
    <div className={cn(frame, className)}>{body}</div>
  );
}
