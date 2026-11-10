import { cn } from "@/lib/utils";

/**
 * Loading placeholders: a block that pulses where content will be, and the region that names them.
 *
 * Drawn in `orb-line` rather than shadcn's `bg-muted`, which is the raised surface — the very fill
 * a panel already has, so a placeholder inside a panel vanished into it. The line colour sits a
 * step above every surface in both themes, quietly, and the small radius matches the text and
 * fields it stands in for rather than the panel around it.
 *
 * A placeholder is shaped like what is coming (see docs/architecture/ui.md), so the page does not jump when the
 * read answers. Wrap a set of them in `SkeletonRegion`, which is what a screen reader hears: one
 * "Loading…" with a name, instead of a run of empty boxes.
 */
function Skeleton({ className, ...props }) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-orb-line/70 motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

/**
 * A loading region: `role="status"` with its name read out once, and whatever placeholders it holds.
 *
 * @param {object} props
 * @param {string} props.label what is loading, as a screen reader should hear it ("Loading members")
 */
function SkeletonRegion({ label = "Loading…", className, children, ...props }) {
  return (
    <div role="status" aria-busy="true" className={className} {...props}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

export { Skeleton, SkeletonRegion };
