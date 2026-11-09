"use client";

import { Panel } from "@/components/ui/panel";
import { FONT_ROLES, TYPE_TOKENS } from "@/lib/brand/brand";
import { AssetImage } from "./AssetImage";
import { useBrand } from "./BrandContext";
import { FontSpecimen } from "./FontSpecimen";
import { PinField, SectionHeading, SourceBadge } from "./PinField";

/**
 * The type of the system: its families, its scale, and a picture of both as the site sets them.
 *
 * The picture is the specimen the agent drew on the site's own page, in the site's own fonts.
 * Orbik stores no font files — they are the site's to license — so this page cannot set a line in
 * the real typeface, and the specimen is how a person checks that the family named in the table
 * is the one they see on their site.
 */
export function TypographySection() {
  const { workspaceId, system, observation, assets } = useBrand();
  const typography = system.typography ?? {};
  const specimenId = observation?.sheets?.specimen ?? null;
  // Font files the person uploaded, each matched to the role whose family it is.
  const fonts = assets.filter((asset) => asset.kind === "font").map((font) => ({
    font,
    role: FONT_ROLES.find(({ role }) => sameFamily(typography.families?.[role]?.family, font.font?.family))?.role ?? null,
  }));

  return (
    <section aria-labelledby="brand-type" className="space-y-4">
      <SectionHeading id="brand-type" title="Typography" description="The typefaces your site sets, and the scale it sets them at. Sizes are in pixels at desktop width." />

      <ul className="grid gap-3 md:grid-cols-3">
        {FONT_ROLES.map(({ role, label }) => {
          const family = typography.families?.[role];
          return (
            <li key={role}>
              <Panel className="h-full p-4 sm:p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs uppercase tracking-[0.12em] text-orb-muted">{label}</p>
                  {family && <SourceBadge source={family.source} pointer={`/typography/families/${role}/family`} />}
                </div>
                <PinField pointer={`/typography/families/${role}/family`} value={family?.family ?? ""} kind="text" label={`${label} typeface`} className="mt-2">
                  <span className="font-display text-lg text-orb-white">{family?.family ?? <span className="text-sm font-normal text-orb-muted">None observed. Set one</span>}</span>
                </PinField>
                {family && (
                  <dl className="mt-2 space-y-1 text-xs text-orb-gray">
                    <div className="flex gap-2">
                      <dt className="w-16 shrink-0 text-orb-muted">Weights</dt>
                      <dd>
                        <PinField pointer={`/typography/families/${role}/weights`} value={family.weights} kind="numbers" label={`${label} weights`} format={(value) => value.join(", ")}>
                          <span className="tabular-nums">{family.weights.join(", ") || "not recorded"}</span>
                        </PinField>
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-16 shrink-0 text-orb-muted">Fallbacks</dt>
                      <dd>
                        <PinField pointer={`/typography/families/${role}/fallbacks`} value={family.fallbacks} kind="lines" label={`${label} fallbacks`} format={(value) => value.join(", ")}>
                          <span>{family.fallbacks.join(", ") || "none"}</span>
                        </PinField>
                      </dd>
                    </div>
                  </dl>
                )}
              </Panel>
            </li>
          );
        })}
      </ul>

      {fonts.length > 0 && (
        <div className="space-y-3">
          {fonts.map(({ font, role }) => (
            <FontSpecimen key={font.id} workspaceId={workspaceId} font={font} role={role} accent={system.colors?.primary?.value ?? null} />
          ))}
        </div>
      )}

      <Panel className="overflow-x-auto p-0 sm:p-0">
        <table className="w-full min-w-[42rem] text-left text-sm">
          <thead className="border-b border-orb-line text-xs uppercase tracking-[0.1em] text-orb-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Step</th>
              <th className="px-3 py-2 font-medium">Size</th>
              <th className="px-3 py-2 font-medium">Line height</th>
              <th className="px-3 py-2 font-medium">Weight</th>
              <th className="px-3 py-2 font-medium">Family</th>
              <th className="px-3 py-2 font-medium">Used for</th>
              <th className="px-3 py-2 font-medium">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-orb-line/60">
            {TYPE_TOKENS.map(({ token, label }) => {
              const step = typography.scale?.[token];
              const base = `/typography/scale/${token}`;
              if (!step) {
                return (
                  <tr key={token} className="text-orb-muted">
                    <td className="px-3 py-2">{label}</td>
                    <td className="px-3 py-2" colSpan={6}>
                      <PinField pointer={`${base}/px`} value="" kind="number" label={`${label} size in pixels`}>
                        <span className="text-xs">Not observed. Set a size</span>
                      </PinField>
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={token}>
                  <td className="px-3 py-2 text-orb-white">{label}</td>
                  <td className="px-3 py-2">
                    <PinField pointer={`${base}/px`} value={step.px} kind="number" label={`${label} size in pixels`} format={(value) => `${value}px`}>
                      <span className="tabular-nums text-orb-white">{step.px}px</span>
                    </PinField>
                  </td>
                  <td className="px-3 py-2">
                    <PinField pointer={`${base}/lineHeight`} value={step.lineHeight} kind="number" label={`${label} line height`}>
                      <span className="tabular-nums text-orb-gray">{step.lineHeight}</span>
                    </PinField>
                  </td>
                  <td className="px-3 py-2">
                    <PinField pointer={`${base}/weight`} value={step.weight} kind="number" label={`${label} weight`}>
                      <span className="tabular-nums text-orb-gray">{step.weight}{step.letterSpacing ? ` · ${step.letterSpacing}em` : ""}</span>
                    </PinField>
                  </td>
                  <td className="px-3 py-2 text-orb-gray">{typography.families?.[step.family]?.family ?? step.family}</td>
                  <td className="max-w-[18rem] px-3 py-2 text-xs text-orb-gray">{step.usedFor}</td>
                  <td className="px-3 py-2"><SourceBadge source={step.source} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>

      {typography.rules?.length > 0 && (
        <PinField pointer="/typography/rules" value={typography.rules} kind="lines" label="typography rules" inline={false} format={(value) => `${value.length} rules`}>
          <ul className="list-disc space-y-1 pl-5 text-sm text-orb-gray">
            {typography.rules.map((rule) => <li key={rule}>{rule}</li>)}
          </ul>
        </PinField>
      )}

      {specimenId && (
        <figure className="overflow-hidden rounded-xl border border-orb-line bg-white">
          <AssetImage workspaceId={workspaceId} assetId={specimenId} alt="Type specimen: the site's own fonts at the sizes it sets them" className="w-full" />
          <figcaption className="border-t border-orb-line bg-orb-space px-3 py-2 text-xs text-orb-muted">
            Drawn on your site, in its own fonts. Font files are not stored; this picture is how the typefaces look.
          </figcaption>
        </figure>
      )}
    </section>
  );
}

/** Whether two family names name the same face, ignoring case and spacing. */
function sameFamily(left, right) {
  const clean = (name) => String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return Boolean(clean(left)) && clean(left) === clean(right);
}
