import { cn } from "@/lib/utils";

/**
 * Orbik's boxes: the panel content sits in, its small heading, and the divided list inside one.
 *
 * Every bordered box on a page is a Panel (or a Card, drawn the same), so a page never invents its
 * own border, radius or fill. See docs/ui.md.
 */

/** The bordered box a section's content sits in. */
export function Panel({ className, children, ...props }) {
  return (
    <div className={cn("min-w-0 rounded-xl border border-orb-line bg-orb-raised/40 p-4 sm:p-5", className)} {...props}>
      {children}
    </div>
  );
}

/** A panel's small heading — "Invite someone", "Connected" — with something on its right. */
export function PanelTitle({ children, aside, as: Heading = "h3" }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <Heading className="text-sm font-semibold text-orb-white">{children}</Heading>
      {aside}
    </div>
  );
}

/** A divided list inside a panel: people, tokens, invites. Each child is an `<li>`. */
export function RowList({ className, children, ...props }) {
  return (
    <ul className={cn("divide-y divide-orb-line/70 overflow-hidden rounded-lg border border-orb-line bg-orb-space/50", className)} {...props}>
      {children}
    </ul>
  );
}

/**
 * What an empty list or panel says will appear, and when, in a dashed box. Optional icon in the
 * accent, optional action under it.
 */
export function EmptyState({ icon: Icon, children, action, className }) {
  return (
    <div className={cn("flex flex-col items-center gap-2 rounded-lg border border-dashed border-orb-line px-4 py-6 text-center", className)}>
      {Icon && <Icon aria-hidden="true" className="size-5 text-orb-muted" />}
      <p className="max-w-md text-sm leading-relaxed text-orb-muted">{children}</p>
      {action}
    </div>
  );
}
