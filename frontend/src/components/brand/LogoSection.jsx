"use client";

import { AlertTriangle, Download, Eye, EyeOff, Star } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { brandAssetUrl } from "@/lib/api/brand";
import { formatBytes } from "@/lib/brand/brand";
import { cn } from "@/lib/utils";
import { AssetImage } from "./AssetImage";
import { useBrand } from "./BrandContext";
import { SectionHeading } from "./PinField";

/**
 * Below this width a raster logo from the website is too small to show sharply at the sizes a
 * slide, a page header or an image model will want it.
 */
const LOW_RESOLUTION_WIDTH = 400;

/** What each media type is called on a download. */
const FORMAT_LABELS = Object.freeze({ "image/svg+xml": "SVG", "image/png": "PNG", "image/webp": "WebP", "image/jpeg": "JPEG", "image/gif": "GIF" });

/**
 * The marks of the brand, each shown on light and on dark.
 *
 * Both backgrounds, always, because which one a mark was drawn for is the first thing somebody
 * placing it needs to know and the thing a single thumbnail hides: a white wordmark on a white
 * tile is an empty tile. One is the primary — the one an outside AI is handed first — and that
 * choice is a pin like any other.
 */
export function LogoSection() {
  const { workspaceId, system, assets, pin, updateAsset, busy, canEdit } = useBrand();
  // Uploads first: they are what the person gave, and usually what replaces the website's copies.
  const logos = assets
    .filter((asset) => asset.kind === "logo")
    .sort((left, right) => Number(right.origin === "upload") - Number(left.origin === "upload") || Number(left.hidden) - Number(right.hidden));
  const primaryId = system?.logos?.primary ?? null;
  if (!logos.length) {
    return (
      <section aria-labelledby="brand-logos" className="space-y-4">
        <SectionHeading id="brand-logos" title="Logos and marks" description="No logo yet. Drop your logo files here, or in the chat: an SVG stays sharp at any size." />
      </section>
    );
  }

  return (
    <section aria-labelledby="brand-logos" className="space-y-4">
      <SectionHeading id="brand-logos" title="Logos and marks" description={system?.graphics?.logo?.description ?? "The marks found in your site's header and footer, and the icon it gives a phone's home screen."} />

      <ul className="grid gap-3 md:grid-cols-2">
        {logos.map((logo) => {
          const primary = logo.id === primaryId;
          const uploaded = logo.origin === "upload";
          const lowResolution = !uploaded && logo.mimeType !== "image/svg+xml" && logo.width && logo.width < LOW_RESOLUTION_WIDTH;
          return (
            <li key={logo.id} className={cn("overflow-hidden rounded-xl border bg-orb-raised/40", primary ? "border-orb-lime/50" : "border-orb-line", logo.hidden && "opacity-60")}>
              <div className="grid grid-cols-2">
                <div className="flex h-28 items-center justify-center bg-white p-4">
                  <AssetImage workspaceId={workspaceId} assetId={logo.id} alt={`${logo.label ?? "Logo"} on a light background`} className="max-h-full w-auto object-contain" />
                </div>
                <div className="flex h-28 items-center justify-center bg-[#111827] p-4">
                  <AssetImage workspaceId={workspaceId} assetId={logo.id} alt={`${logo.label ?? "Logo"} on a dark background`} className="max-h-full w-auto object-contain" />
                </div>
              </div>
              <div className="space-y-2 border-t border-orb-line p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-orb-white">{logo.label ?? logo.alt ?? "Logo"}</p>
                  <span className="flex flex-wrap gap-1">
                    {primary && <Pill tone="lime">Primary</Pill>}
                    {logo.hidden && <Pill title="Not handed to anyone's AI">Set aside</Pill>}
                  </span>
                </div>
                <p className="text-xs text-orb-muted">{uploaded ? `Uploaded by you${logo.fileName ? ` · ${logo.fileName}` : ""}` : "From your website"}</p>
                <p className="text-xs text-orb-gray">
                  {[logo.variant, logo.tone ? `drawn for ${logo.tone === "on-dark" ? "dark" : "light"} backgrounds` : null, logo.width && logo.height ? `${logo.width}×${logo.height}` : null, FORMAT_LABELS[logo.mimeType] ?? null, formatBytes(logo.bytes)].filter(Boolean).join(" · ")}
                </p>
                {logo.caption && <p className="text-xs text-orb-muted">{logo.caption}</p>}
                {lowResolution && !logo.hidden && (
                  <p className="flex items-start gap-1.5 text-xs text-orb-orange">
                    <AlertTriangle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                    Low resolution: blurry above {logo.width} px wide. Drop an SVG or a large PNG here to replace it.
                  </p>
                )}
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {canEdit && !primary && !logo.hidden && (
                    <Button type="button" size="xs" variant="outline" onClick={() => pin("/logos/primary", logo.id)} disabled={busy}>
                      <Star /> Make primary
                    </Button>
                  )}
                  <a href={brandAssetUrl(workspaceId, logo.id)} target="_blank" rel="noreferrer" className="inline-flex h-6 items-center gap-1 rounded-4xl border border-orb-line px-2.5 text-xs text-orb-white hover:bg-orb-raised/60">
                    <Download className="size-3" /> Open
                  </a>
                  {canEdit && (
                    <Button type="button" size="xs" variant="ghost" onClick={() => updateAsset(logo.id, { hidden: !logo.hidden })} disabled={busy || primary} title={logo.hidden ? "Show it again, here and to your AI" : "Hide it: it is not handed to your AI"}>
                      {logo.hidden ? <><Eye /> Use again</> : <><EyeOff /> Set aside</>}
                    </Button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {system?.graphics?.logo?.usage?.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-orb-gray">
          {system.graphics.logo.usage.map((rule) => <li key={rule}>{rule}</li>)}
        </ul>
      )}
    </section>
  );
}
