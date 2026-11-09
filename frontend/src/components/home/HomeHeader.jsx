"use client";

import { ArrowUpRight, Search } from "lucide-react";

import { OrbikMark } from "@/components/OrbikMark";
import { Button } from "@/components/ui/button";
import { ASK_SHORTCUT, useAskPanel } from "@/lib/ask/askPanel";
import { plural } from "@/lib/home/home";
import { cn } from "@/lib/utils";

/**
 * The head of Home: the workspace's mark, name and site, how it is doing in a word, and a way to
 * ask the knowledge base a question.
 *
 * The status is worked out from the same Home read as everything under it, in order of what a
 * person would want to hear first: a failed run, then something moving, then that the site has
 * not been crawled, then that nothing is wrong. "All clear" means only that no agent's newest run
 * failed; it claims nothing else.
 *
 * The ask bar opens the Ask panel the shell already holds. Its starters are put in the box to be
 * read and sent by the person, never sent.
 *
 * @param {object} props
 * @param {object} props.home the Home read
 * @param {boolean} props.hidden whether the person hid the setup checklist
 * @param {() => void} props.onShowSetup brings the checklist back
 */
export function HomeHeader({ home, hidden, onShowSetup }) {
  const ask = useAskPanel();
  const { name, websiteUrl } = home.workspace;
  const host = hostOf(websiteUrl);
  const status = statusOf(home);
  const starters = [`What does ${name} offer?`, `Who is ${name} for?`, `What sets ${name} apart?`];

  return (
    <header className="relative isolate overflow-hidden rounded-2xl border border-orb-line bg-orb-raised/40 px-5 pb-5 pt-5 md:px-7 md:pb-6 md:pt-6">
      <OrbitBackdrop />

      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <span
          aria-hidden="true"
          className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-orb-lime font-display text-xl font-bold text-orb-black shadow-[0_0_0_4px_color-mix(in_oklab,var(--color-orb-lime)_14%,transparent)]"
        >
          {initialOf(name)}
        </span>
        <div className="min-w-0 flex-1">
          <h1 id="home-title" className="font-display text-title font-bold leading-tight tracking-[-0.02em] text-orb-white [overflow-wrap:anywhere]">
            {name}
          </h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            {host && (
              <a
                href={websiteUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 text-orb-gray underline-offset-4 hover:text-orb-white hover:underline"
              >
                {host}
                <ArrowUpRight aria-hidden="true" className="size-3.5" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            )}
            <StatusPill status={status} />
          </div>
        </div>
        {hidden && (
          <Button type="button" variant="ghost" size="sm" onClick={onShowSetup} className="text-orb-muted">
            Show setup
          </Button>
        )}
      </div>

      {ask && (
        <div className="mt-6 max-w-2xl">
          <button
            type="button"
            onClick={() => ask.setOpen(true)}
            className="group flex h-12 w-full min-w-0 items-center gap-3 rounded-xl border border-orb-line bg-orb-space/80 px-4 text-left text-sm text-orb-muted shadow-sm transition-colors hover:border-orb-muted/60 hover:text-orb-gray focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          >
            <Search aria-hidden="true" className="size-4 shrink-0 text-orb-lime" />
            <span className="min-w-0 flex-1 truncate">Ask anything about {name}…</span>
            <kbd className="hidden rounded-[5px] border border-orb-line px-1.5 font-sans text-2xs text-orb-muted sm:inline">{ASK_SHORTCUT}</kbd>
          </button>
          <ul aria-label="Questions to start with" className="mt-3 flex flex-wrap gap-2">
            {starters.map((question) => (
              <li key={question} className="min-w-0">
                <button
                  type="button"
                  onClick={() => ask.askAbout(question)}
                  className="max-w-full truncate rounded-full border border-orb-line bg-orb-space/60 px-3 py-1 text-xs text-orb-gray transition-colors hover:border-orb-lime/50 hover:text-orb-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                >
                  {question}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </header>
  );
}

/** How the workspace is doing, in a word and a colour. */
function statusOf(home) {
  const { website, library, attentionTotals, attention } = home.glance;
  const failed = attentionTotals?.failed ?? attention.filter((row) => row.failedRun).length;
  if (failed) return { tone: "failed", label: `${plural(failed, "agent")} failed on the last run` };
  if (website.crawling) return { tone: "live", label: "Crawling now" };
  if (library.writing) return { tone: "live", label: "Writing the Library" };
  if (!website.configured) return { tone: "idle", label: "Not crawled yet" };
  return { tone: "ok", label: "All clear" };
}

/** The status as a small pill with a dot, which pulses while something is moving. */
function StatusPill({ status }) {
  return (
    <span
      role="status"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        status.tone === "failed" && "border-orb-coral/40 bg-orb-coral/10 text-orb-coral",
        status.tone === "live" && "border-orb-lime/40 bg-orb-lime/10 text-orb-lime",
        status.tone === "ok" && "border-orb-line bg-orb-space/60 text-orb-gray",
        status.tone === "idle" && "border-orb-line bg-orb-space/60 text-orb-muted",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          status.tone === "failed" && "bg-orb-coral",
          status.tone === "live" && "bg-orb-lime motion-safe:animate-pulse",
          status.tone === "ok" && "bg-orb-lime",
          status.tone === "idle" && "border border-orb-muted",
        )}
      />
      {status.label}
    </span>
  );
}

/**
 * Orbik's ringed planet, drawn large and faint in the corner of the head, over a lime glow.
 * Decoration only, under the content and hidden from screen readers.
 */
function OrbitBackdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
      <div className="absolute inset-0 bg-[radial-gradient(60%_90%_at_100%_0%,color-mix(in_oklab,var(--color-orb-lime)_10%,transparent),transparent_70%)]" />
      <OrbikMark className="absolute -right-10 -top-6 h-52 w-auto text-orb-lime opacity-[0.045] md:right-8" />
    </div>
  );
}

/** The first letter or digit of a name, for the workspace's mark. */
function initialOf(name) {
  const match = String(name ?? "").match(/[\p{L}\p{N}]/u);
  return match ? match[0].toUpperCase() : "·";
}

/** The hostname of an address without "www.", or null. */
function hostOf(url) {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}
