import { CircleAlert } from "lucide-react";

import { OrbikLogo } from "@/components/OrbikLogo";
import { OrbikMark } from "@/components/OrbikMark";
import { Label } from "@/components/ui/label";
import { Panel } from "@/components/ui/panel";
import { cn } from "@/lib/utils";

/**
 * Where the logo on these pages goes: Orbik's own site, the home page a person came from. A
 * deployment can point it elsewhere with `NEXT_PUBLIC_ORBIK_HOME_URL`.
 */
export const ORBIK_HOME_URL = process.env.NEXT_PUBLIC_ORBIK_HOME_URL || "https://orbik.io";

/**
 * The pages somebody reaches before they are inside a workspace — sign in, sign up, set up, an
 * invite, an AI app asking to connect, a new workspace — share one shape: the Orbik logo, one
 * panel in the middle of the screen, and nothing else to wander into. These pieces are that shape,
 * so each page only says its own words.
 */

/**
 * The page itself: the `main` landmark, the logo above the content (a link to orbik.io), and the brand's faint lime glow
 * and ringed planet behind it (the same touch as Home's header). The decoration sits under
 * everything and is hidden from screen readers.
 *
 * @param {object} props
 * @param {import("react").ReactNode} props.children usually one `AuthPanel`
 * @param {import("react").ReactNode} [props.footer] a quiet line under the panel
 */
export function AuthFrame({ children, footer }) {
  return (
    <main className="relative isolate flex min-h-screen flex-col items-center justify-center gap-7 overflow-hidden px-4 py-10 sm:p-6">
      <AuthBackdrop />
      <a
        href={ORBIK_HOME_URL}
        aria-label="Orbik home"
        className="shrink-0 rounded-md transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
      >
        <OrbikLogo className="h-5 w-auto text-orb-lime" />
      </a>
      {children}
      {footer && <div className="max-w-md text-center text-xs text-orb-muted">{footer}</div>}
    </main>
  );
}

/** A soft lime glow from the top and the planet drawn large and faint in a corner. */
function AuthBackdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10">
      <div className="absolute inset-0 bg-[radial-gradient(55%_45%_at_50%_0%,color-mix(in_oklab,var(--color-orb-lime)_9%,transparent),transparent_75%)]" />
      <OrbikMark className="absolute -bottom-24 -right-28 h-[26rem] w-auto text-orb-lime opacity-[0.04] sm:-bottom-16 sm:-right-16" />
    </div>
  );
}

/**
 * The one panel: an optional small label over the title ("Step 1 of 2"), the h1, a line under it,
 * and the body. The title is the page's only h1.
 *
 * @param {object} props
 * @param {import("react").ReactNode} props.title
 * @param {import("react").ReactNode} [props.description]
 * @param {import("react").ReactNode} [props.eyebrow] above the title
 * @param {"md"|"lg"} [props.size] md for a short form, lg for an invite or a consent
 */
export function AuthPanel({ title, description, eyebrow, size = "md", className, children, ...props }) {
  return (
    <Panel
      className={cn(
        "relative w-full bg-orb-raised/60 p-6 backdrop-blur-sm shadow-[0_24px_60px_-30px_color-mix(in_oklab,var(--color-orb-black)_80%,transparent)] sm:p-8",
        size === "lg" ? "max-w-lg" : "max-w-md",
        className,
      )}
      {...props}
    >
      {eyebrow && <div className="mb-4">{eyebrow}</div>}
      <h1 className="font-display text-title font-bold leading-tight tracking-[-0.02em] text-orb-white [overflow-wrap:anywhere]">{title}</h1>
      {description && <div className="mt-2 text-sm leading-relaxed text-orb-gray">{description}</div>}
      <div className="mt-6">{children}</div>
    </Panel>
  );
}

/**
 * A labelled field: the label, the control, and under it either the error or the hint, with the
 * identifiers the control's `aria-describedby` names. The error replaces the hint rather than
 * stacking with it, so the line under a field says one thing.
 *
 * @param {object} props
 * @param {string} props.htmlFor the control's id
 * @param {import("react").ReactNode} props.label
 * @param {string} [props.error] the message, when the field is wrong
 * @param {string} [props.errorId]
 * @param {import("react").ReactNode} [props.hint]
 * @param {string} [props.hintId]
 * @param {import("react").ReactNode} [props.aside] a quiet link at the end of the label's line ("Forgot password?")
 */
export function AuthField({ htmlFor, label, error, errorId, hint, hintId, aside, children }) {
  return (
    <div className="space-y-2">
      {aside
        ? <div className="flex items-baseline justify-between gap-3"><Label htmlFor={htmlFor} className="text-orb-white">{label}</Label>{aside}</div>
        : <Label htmlFor={htmlFor} className="text-orb-white">{label}</Label>}
      {children}
      {error
        ? <p id={errorId} className="text-xs text-orb-coral">{error}</p>
        : hint ? <p id={hintId} className="text-xs text-orb-muted">{hint}</p> : null}
    </div>
  );
}

/** A form's own failure, above its fields: coral, announced as soon as it appears. */
export function AuthError({ children, className }) {
  return (
    <div role="alert" className={cn("flex gap-2.5 rounded-lg border border-orb-coral/40 bg-orb-coral/10 px-3.5 py-3 text-sm text-orb-white", className)}>
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-orb-coral" />
      <div className="min-w-0 [overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}

/** The quiet line at the foot of a panel — "Need an account? Ask for an invite" — under a rule. */
export function AuthPanelFoot({ children, id }) {
  return (
    <p id={id} className="mt-6 border-t border-orb-line/70 pt-5 text-center text-sm text-orb-gray">
      {children}
    </p>
  );
}

/**
 * The link style the signed-out pages share: the strongest text, underlined. Not lime, which is a
 * page's one primary action, and these sit next to one.
 */
export const AUTH_LINK = "rounded-sm font-medium text-orb-white underline decoration-orb-muted/70 underline-offset-4 transition-colors hover:decoration-orb-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70";
