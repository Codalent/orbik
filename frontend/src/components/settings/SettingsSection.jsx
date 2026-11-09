import { cn } from "@/lib/utils";

/**
 * One section of the Settings page: a heading with its icon and one line of what it is for, then
 * its panels. The panels, pills and lists inside are the shared ones in `components/ui`.
 */

/**
 * One section of Settings, the body of its own route.
 *
 * @param {object} props
 * @param {string} props.id the section's id, which names its heading for `aria-labelledby`
 * @param {import("react").ComponentType<{className?: string}>} props.icon
 * @param {string} props.title
 * @param {import("react").ReactNode} [props.description]
 * @param {import("react").ReactNode} [props.aside] something on the heading's right, such as a count
 */
export function SettingsSection({ id, icon: Icon, title, description, aside, children }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} data-settings-section className="min-w-0 scroll-mt-6 space-y-4">
      <header className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-orb-line bg-orb-raised/60 text-orb-lime">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={`${id}-title`} className="font-display text-lg font-bold leading-tight tracking-[-0.015em] text-orb-white">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-orb-gray">{description}</p>}
        </div>
        {aside}
      </header>
      {children}
    </section>
  );
}
