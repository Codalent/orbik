import { cn } from "@/lib/utils";

/**
 * A page's head: an optional icon tile, the h1, one line of what the page is for, status beside the
 * title, and actions on the right. Every page inside the workspace starts with one (docs/architecture/ui.md).
 *
 * @param {object} props
 * @param {import("react").ComponentType<{className?: string}>} [props.icon]
 * @param {import("react").ReactNode} props.title
 * @param {import("react").ReactNode} [props.description]
 * @param {import("react").ReactNode} [props.status] pills beside the title
 * @param {import("react").ReactNode} [props.meta] a quiet line under the description ("Last run 2 days ago · next in 5 days")
 * @param {import("react").ReactNode} [props.actions] buttons on the right
 * @param {string} [props.id] the h1's id, for a `<main aria-labelledby>`
 */
export function PageHeader({ icon: Icon, title, description, status, meta, actions, id, className, children }) {
  return (
    <header className={cn("flex flex-wrap items-start gap-x-4 gap-y-3", className)}>
      {Icon && (
        <span aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-orb-line bg-orb-raised/60 text-orb-lime">
          <Icon className="size-5" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 id={id} className="font-display text-title font-bold leading-tight tracking-[-0.02em] text-orb-white [overflow-wrap:anywhere]">{title}</h1>
          {status}
        </div>
        {description && <p className="mt-1 max-w-2xl text-sm text-orb-gray">{description}</p>}
        {meta && <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-orb-muted">{meta}</div>}
        {children}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/**
 * A heading inside a page, above a panel or a list: the h2, a quiet figure or note beside it, and
 * an action on the right.
 */
export function SectionHeading({ id, children, aside, action, className }) {
  return (
    <div className={cn("flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1", className)}>
      <h2 id={id} className="flex flex-wrap items-baseline gap-x-2 text-base font-semibold text-orb-white">
        {children}
        {aside && <span className="text-xs font-normal text-orb-muted">{aside}</span>}
      </h2>
      {action}
    </div>
  );
}
