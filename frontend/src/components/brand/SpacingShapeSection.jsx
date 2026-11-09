"use client";

import { Panel } from "@/components/ui/panel";
import { RADIUS_TOKENS, SHADOW_TOKENS } from "@/lib/brand/brand";
import { useBrand } from "./BrandContext";
import { PinField, SectionHeading, SourceBadge } from "./PinField";

/**
 * Spacing and shape: the unit and steps things are spaced by, how round corners are, how heavy
 * shadows are.
 *
 * Each value is drawn as the thing it measures — a bar as long as the step, a square with the
 * radius, a tile under the shadow — because "16" and "24" are hard to tell apart as numbers and
 * easy as lengths.
 */
export function SpacingShapeSection() {
  const { system } = useBrand();
  const spacing = system.spacing ?? {};
  const shape = system.shape ?? {};
  const scale = spacing.scale?.value ?? [];
  const longest = Math.max(1, ...scale);

  return (
    <section aria-labelledby="brand-spacing" className="space-y-4">
      <SectionHeading id="brand-spacing" title="Spacing and shape" description="The unit your layout is spaced by, the steps it uses, and how corners and shadows are drawn." />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="space-y-3">
          <dl className="grid grid-cols-3 gap-3 text-sm">
            <Measure label="Base unit" holder={spacing.base} pointer="/spacing/base/value" />
            <Measure label="Container" holder={spacing.containerMaxWidth} pointer="/spacing/containerMaxWidth/value" />
            <Measure label="Section padding" holder={spacing.sectionPadding} pointer="/spacing/sectionPadding/value" />
          </dl>
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.1em] text-orb-muted">Scale</p>
              {spacing.scale && <SourceBadge source={spacing.scale.source} />}
            </div>
            <PinField pointer="/spacing/scale/value" value={scale} kind="numbers" label="spacing scale in pixels" inline={false} format={(value) => value.join(", ")}>
              <ul className="space-y-1">
                {scale.map((step) => (
                  <li key={step} className="flex items-center gap-2 text-xs">
                    <span className="w-10 shrink-0 text-right tabular-nums text-orb-gray">{step}px</span>
                    <span aria-hidden="true" className="h-2 rounded-sm bg-orb-lime/70" style={{ width: `${Math.max(2, (step / longest) * 100)}%` }} />
                  </li>
                ))}
              </ul>
            </PinField>
          </div>
        </Panel>

        <Panel className="space-y-4">
          <div>
            <p className="mb-2 text-xs uppercase tracking-[0.1em] text-orb-muted">Radius</p>
            <ul className="grid grid-cols-4 gap-3">
              {RADIUS_TOKENS.map((token) => {
                const radius = shape.radius?.[token];
                if (!radius) return null;
                return (
                  <li key={token} className="space-y-1.5 text-center">
                    <span aria-hidden="true" className="mx-auto block size-12 border border-orb-lime/60 bg-orb-lime/10" style={{ borderRadius: Math.min(radius.value, 24) }} />
                    <p className="text-xs text-orb-white">{token}</p>
                    <PinField pointer={`/shape/radius/${token}/value`} value={radius.value} kind="number" label={`${token} radius in pixels`} format={(value) => `${value}px`}>
                      <span className="text-xs tabular-nums text-orb-gray">{radius.value}px</span>
                    </PinField>
                    <SourceBadge source={radius.source} />
                  </li>
                );
              })}
            </ul>
          </div>
          <div>
            <p className="mb-2 text-xs uppercase tracking-[0.1em] text-orb-muted">Shadows</p>
            <ul className="space-y-2">
              {SHADOW_TOKENS.map((token) => {
                const shadow = shape.shadows?.[token];
                if (!shadow) return null;
                return (
                  <li key={token} className="flex items-center gap-3">
                    <span aria-hidden="true" className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-white text-2xs text-neutral-500" style={{ boxShadow: shadow.value ?? "none" }}>{token}</span>
                    <div className="min-w-0 flex-1">
                      <PinField pointer={`/shape/shadows/${token}/value`} value={shadow.value ?? ""} kind="text" label={`${token} shadow as a CSS box-shadow`}>
                        <span className="break-all font-mono text-2xs text-orb-gray">{shadow.value ?? "none"}</span>
                      </PinField>
                    </div>
                    <SourceBadge source={shadow.source} />
                  </li>
                );
              })}
            </ul>
          </div>
          <dl className="grid grid-cols-3 gap-3 text-sm">
            <Measure label="Border width" holder={shape.borderWidth} pointer="/shape/borderWidth/value" />
          </dl>
        </Panel>
      </div>
    </section>
  );
}

/** One length of the system: its value, its source, and the way to correct it. */
function Measure({ label, holder, pointer }) {
  const has = typeof holder?.value === "number";
  return (
    <div>
      <dt className="text-xs uppercase tracking-[0.1em] text-orb-muted">{label}</dt>
      <dd className="mt-1 space-y-1">
        <PinField pointer={pointer} value={has ? holder.value : ""} kind="number" label={`${label.toLowerCase()} in pixels`} format={(value) => `${value}px`}>
          <span className="tabular-nums text-orb-white">{has ? `${holder.value}px` : <span className="text-xs text-orb-muted">not observed</span>}</span>
        </PinField>
        {has && <SourceBadge source={holder.source} />}
      </dd>
    </div>
  );
}
