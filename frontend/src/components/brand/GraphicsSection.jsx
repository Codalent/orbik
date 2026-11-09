"use client";

import { useState } from "react";
import { Eye, EyeOff, Star } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState, Panel, PanelTitle } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { GRAPHICS_FIELDS, IMAGE_KINDS } from "@/lib/brand/brand";
import { cn } from "@/lib/utils";
import { AssetImage } from "./AssetImage";
import { useBrand } from "./BrandContext";
import { CopyButton } from "./CopyButton";
import { PinField, SectionHeading } from "./PinField";

/** The kinds of asset that are the site's own imagery. */
const IMAGERY = Object.freeze(["illustration", "photo", "icon"]);

/**
 * The graphics language: what the brand's imagery is like, the images themselves, and what to
 * tell an image model so that it draws in the same style.
 *
 * Two things here are a person's to decide and the agent only suggests. Which images are
 * **references** — the handful an outside AI is shown as "draw like this" — and which are
 * **hidden**, because they are on the site and are not the brand's own: a customer's logo, a
 * review badge. The agent's verdict on each is its starting point; a toggle here is kept through
 * every later run.
 */
export function GraphicsSection() {
  const { workspaceId, system, assets, observation, updateAsset, busy, canEdit } = useBrand();
  const [showHidden, setShowHidden] = useState(false);
  const graphics = system?.graphics ?? null;
  const imagery = assets.filter((asset) => IMAGERY.includes(asset.kind));
  const visible = imagery.filter((asset) => !asset.hidden);
  const hidden = imagery.filter((asset) => asset.hidden);
  const references = visible.filter((asset) => asset.isReference);
  const contactSheetId = observation?.sheets?.contactSheet ?? null;
  if (!graphics && !imagery.length) return null;

  const prompt = graphics?.imagePrompt ?? null;
  return (
    <section aria-labelledby="brand-graphics" className="space-y-4">
      <SectionHeading id="brand-graphics" title="Graphics language" description="How your imagery looks, described so a designer or an image model can continue it.">
        {graphics?.medium && <Pill>Medium: {graphics.medium}</Pill>}
      </SectionHeading>

      {graphics ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <div className="space-y-3">
            <PinField pointer="/graphics/description" value={graphics.description} kind="paragraph" label="description of the graphics language" inline={false} format={() => "the agent's description"}>
              <p className="text-sm leading-relaxed text-orb-white">{graphics.description}</p>
            </PinField>
            <dl className="space-y-2 text-sm">
              {GRAPHICS_FIELDS.filter(({ field }) => graphics[field]).map(({ field, label }) => (
                <div key={field} className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2">
                  <dt className="text-xs uppercase tracking-[0.1em] text-orb-muted">{label}</dt>
                  <dd>
                    <PinField pointer={`/graphics/${field}`} value={graphics[field]} kind="paragraph" label={label.toLowerCase()} inline={false} format={() => "the agent's wording"}>
                      <span className="text-orb-gray">{graphics[field]}</span>
                    </PinField>
                  </dd>
                </div>
              ))}
              {graphics.iconography && (
                <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2">
                  <dt className="text-xs uppercase tracking-[0.1em] text-orb-muted">Icons</dt>
                  <dd className="text-orb-gray">{[graphics.iconography.style, graphics.iconography.strokeWeight, graphics.iconography.corner, graphics.iconography.fill].filter(Boolean).join(" ")}</dd>
                </div>
              )}
            </dl>
            {graphics.doNot?.length > 0 && (
              <div>
                <p className="text-xs uppercase tracking-[0.1em] text-orb-muted">Do not</p>
                <PinField pointer="/graphics/doNot" value={graphics.doNot} kind="lines" label="what to avoid" inline={false} format={(value) => `${value.length} lines`}>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-orb-gray">
                    {graphics.doNot.map((rule) => <li key={rule}>{rule}</li>)}
                  </ul>
                </PinField>
              </div>
            )}
          </div>

          {prompt?.stylePrefix && (
            <Panel className="space-y-3 self-start">
              <div>
                <PanelTitle aside={<CopyButton text={[prompt.stylePrefix, prompt.negative ? `Avoid: ${prompt.negative}` : null].filter(Boolean).join("\n\n")} label="Copy prompt" />}>
                  Image prompt
                </PanelTitle>
                <p className="-mt-2 text-xs text-orb-muted">Put this before any subject so an image model draws it in your style.</p>
              </div>
              <PinField pointer="/graphics/imagePrompt/stylePrefix" value={prompt.stylePrefix} kind="paragraph" label="image style prompt" inline={false} format={() => "the agent's prompt"}>
                <p className="text-sm leading-relaxed text-orb-gray">{prompt.stylePrefix}</p>
              </PinField>
              {prompt.negative && (
                <div>
                  <p className="text-xs uppercase tracking-[0.1em] text-orb-muted">Avoid</p>
                  <PinField pointer="/graphics/imagePrompt/negative" value={prompt.negative} kind="paragraph" label="what the image model should avoid" inline={false} format={() => "the agent's wording"}>
                    <p className="text-sm leading-relaxed text-orb-gray">{prompt.negative}</p>
                  </PinField>
                </div>
              )}
              <p className="text-xs text-orb-muted">
                {references.length ? `${references.length} reference image${references.length === 1 ? "" : "s"} go with it, marked below.` : "No reference images are marked. Mark a few below so an image model has something to imitate."}
              </p>
            </Panel>
          )}
        </div>
      ) : (
        <EmptyState>
          The images below were collected from your site, but their style has not been described yet.
        </EmptyState>
      )}

      {visible.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {visible.map((asset) => (
            <ImageCard key={asset.id} asset={asset} workspaceId={workspaceId} busy={busy} onUpdate={canEdit ? updateAsset : null} />
          ))}
        </ul>
      )}

      {hidden.length > 0 && (
        <div className="space-y-3">
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowHidden((open) => !open)} aria-expanded={showHidden}>
            {showHidden ? "Hide" : "Show"} {hidden.length} image{hidden.length === 1 ? "" : "s"} set aside as not your brand&apos;s own
          </Button>
          {showHidden && (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {hidden.map((asset) => (
                <ImageCard key={asset.id} asset={asset} workspaceId={workspaceId} busy={busy} onUpdate={canEdit ? updateAsset : null} />
              ))}
            </ul>
          )}
        </div>
      )}

      {contactSheetId && (
        <details className="overflow-hidden rounded-xl border border-orb-line bg-orb-raised/40">
          <summary className="cursor-pointer px-4 py-2.5 text-sm text-orb-gray hover:text-orb-white">The contact sheet the description was written from</summary>
          <div className="border-t border-orb-line bg-white">
            <AssetImage workspaceId={workspaceId} assetId={contactSheetId} alt="Contact sheet of every image collected from the site" className="w-full" />
          </div>
        </details>
      )}
    </section>
  );
}

/** One harvested image: what it is, and the two things a person decides about it. */
function ImageCard({ asset, workspaceId, busy, onUpdate }) {
  return (
    <li className={cn("flex flex-col overflow-hidden rounded-xl border bg-orb-raised/40", asset.isReference && !asset.hidden ? "border-orb-lime/50" : "border-orb-line", asset.hidden && "opacity-70")}>
      <div className={cn("flex items-center justify-center bg-white", asset.kind === "icon" ? "h-24 p-6" : "h-36 p-2")}>
        <AssetImage workspaceId={workspaceId} assetId={asset.id} alt={asset.caption ?? asset.alt ?? asset.kind} className="max-h-full w-auto object-contain" />
      </div>
      <div className="flex flex-1 flex-col gap-2 border-t border-orb-line p-3">
        <p className="text-xs leading-relaxed text-orb-gray">{asset.caption ?? asset.alt ?? "No caption yet."}</p>
        {onUpdate && <div className="mt-auto flex flex-wrap items-center gap-1">
          <Select
            items={IMAGE_KINDS.map(({ kind, label }) => ({ value: kind, label }))}
            value={asset.kind}
            disabled={busy}
            onValueChange={(next) => { if (next && next !== asset.kind) onUpdate(asset.id, { kind: next }); }}
          >
            <SelectTrigger size="xs" aria-label="What kind of image this is" className="text-orb-gray">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {IMAGE_KINDS.map(({ kind, label }) => <SelectItem key={kind} value={kind}>{label}</SelectItem>)}
            </SelectContent>
          </Select>
          {!asset.hidden && (
            <Button
              type="button"
              size="xs"
              variant={asset.isReference ? "secondary" : "ghost"}
              onClick={() => onUpdate(asset.id, { isReference: !asset.isReference })}
              disabled={busy}
              aria-pressed={asset.isReference}
              title={asset.isReference ? "A reference: handed to an image model as an example of your style" : "Use as a reference for image models"}
            >
              <Star className={cn(asset.isReference && "fill-current text-orb-lime")} /> Reference
            </Button>
          )}
          <Button type="button" size="xs" variant="ghost" onClick={() => onUpdate(asset.id, { hidden: !asset.hidden })} disabled={busy} title={asset.hidden ? "It is your brand's own: show it and hand it to your AI" : "Not your brand's own: hide it and keep it from your AI"}>
            {asset.hidden ? <><Eye /> Show</> : <><EyeOff /> Hide</>}
          </Button>
        </div>}
      </div>
    </li>
  );
}
