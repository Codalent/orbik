"use client";

import { BookOpen, Globe, Newspaper, Quote, SatelliteDish } from "lucide-react";

import { cn } from "@/lib/utils";

/** The icon of a source, by what it is: a review is a quote, documentation a book. */
export function sourceIcon(source) {
  if (!source) return SatelliteDish;
  if (source.purpose === "reviews" || source.purpose === "press") return Quote;
  if (source.purpose === "docs") return BookOpen;
  if (source.purpose === "blog") return Newspaper;
  return Globe;
}

/**
 * A source's icon in a ring, drawn the way the agents' are: lime with a dot travelling the ring
 * while it is being read, coral when the site refused it or the read failed.
 *
 * @param {object} props
 * @param {object} props.source a source from the API
 * @param {"sm"|"md"} [props.size]
 */
export function SourceGlyph({ source, size = "sm", className }) {
  const working = ["reading", "first-read"].includes(source?.state);
  const failed = ["refused", "rate-limited", "failed"].includes(source?.state);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative grid shrink-0 place-items-center rounded-full border",
        size === "md" ? "size-9" : "size-7",
        working ? "border-orb-lime/50 text-orb-lime" : failed ? "border-orb-coral/50 text-orb-coral" : "border-orb-line text-orb-gray",
        className,
      )}
    >
      <SourceIcon source={source} className={size === "md" ? "size-4" : "size-3.5"} />
      {working && (
        <span className="absolute inset-0 motion-safe:animate-[orbik-orbit_6s_linear_infinite]">
          <span className="absolute left-1/2 top-0 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-orb-lime" />
        </span>
      )}
    </span>
  );
}

/** A source's icon, by what it is. */
export function SourceIcon({ source, className }) {
  if (!source) return <SatelliteDish className={className} />;
  if (source.purpose === "reviews" || source.purpose === "press") return <Quote className={className} />;
  if (source.purpose === "docs") return <BookOpen className={className} />;
  if (source.purpose === "blog") return <Newspaper className={className} />;
  return <Globe className={className} />;
}
