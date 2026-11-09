"use client";

import { BUTTON_VARIANTS, RADIUS_TOKENS, SHADOW_TOKENS, resolveColor } from "@/lib/brand/brand";
import { AssetImage } from "./AssetImage";
import { useBrand } from "./BrandContext";
import { BrandSample } from "./BrandSample";
import { PinField, SectionHeading, SourceBadge } from "./PinField";

/** The radius and shadow a recipe may name, as choices. */
const RADIUS_CHOICES = Object.freeze(["none", ...RADIUS_TOKENS].map((token) => ({ value: token, label: token })));
const SHADOW_CHOICES = Object.freeze(["none", ...SHADOW_TOKENS].map((token) => ({ value: token, label: token })));

/** Which fields each kind of component is described by, and which editor each takes. */
const RECIPE_FIELDS = Object.freeze({
  button: [["background", "Background", "colorRef"], ["color", "Text", "colorRef"], ["borderColor", "Border", "colorRef"], ["radius", "Radius", "radius"], ["paddingY", "Padding Y", "px"], ["paddingX", "Padding X", "px"], ["fontSize", "Font size", "px"], ["fontWeight", "Weight", "number"], ["shadow", "Shadow", "shadow"], ["hoverBackground", "Hover", "colorRef"]],
  input: [["background", "Background", "colorRef"], ["color", "Text", "colorRef"], ["borderColor", "Border", "colorRef"], ["radius", "Radius", "radius"], ["paddingY", "Padding Y", "px"], ["paddingX", "Padding X", "px"], ["fontSize", "Font size", "px"]],
  card: [["background", "Background", "colorRef"], ["borderColor", "Border", "colorRef"], ["radius", "Radius", "radius"], ["padding", "Padding", "px"], ["shadow", "Shadow", "shadow"]],
  nav: [["background", "Background", "colorRef"], ["color", "Text", "colorRef"], ["borderColor", "Border", "colorRef"], ["height", "Height", "px"], ["radius", "Radius", "radius"], ["shadow", "Shadow", "shadow"]],
  footer: [["background", "Background", "colorRef"], ["color", "Text", "colorRef"], ["columns", "Columns", "number"]],
});

/**
 * The components, two ways at once: as your site draws them, and as the proposal would.
 *
 * On the left of each row is a piece cut out of a screenshot of the site. Above them all is a
 * sample drawn live from the tokens. The two side by side are the fastest check there is on a
 * derived system — if the sample's button is not the site's button, the recipe is wrong, and
 * every field of it can be corrected underneath.
 */
export function ComponentsSection() {
  const { workspaceId, system, assets } = useBrand();
  const components = system.components ?? {};
  const clips = assets.filter((asset) => asset.kind === "clip");
  const clipsOf = (position) => clips.filter((clip) => clip.position === position);

  const rows = [
    ...BUTTON_VARIANTS.map((variant) => ({ key: `button-${variant}`, title: `Button, ${variant}`, pointer: `/components/button/${variant}`, recipe: components.button?.[variant], kind: "button", clips: variant === "primary" ? clipsOf("button") : [] })),
    { key: "input", title: "Input", pointer: "/components/input", recipe: components.input, kind: "input", clips: clipsOf("input") },
    { key: "card", title: "Card", pointer: "/components/card", recipe: components.card, kind: "card", clips: clipsOf("card") },
    { key: "nav", title: "Navigation bar", pointer: "/components/nav", recipe: components.nav, kind: "nav", clips: clipsOf("nav") },
    { key: "footer", title: "Footer", pointer: "/components/footer", recipe: components.footer, kind: "footer", clips: clipsOf("footer") },
  ].filter((row) => row.recipe);

  return (
    <section aria-labelledby="brand-components" className="space-y-4">
      <SectionHeading id="brand-components" title="Components" description="Your site's own components beside the same ones drawn from the tokens. Each recipe names colours by role, so changing a colour above changes it here." />

      <div className="space-y-2">
        <BrandSample system={system} />
        <p className="text-xs text-orb-muted">
          Drawn live from the tokens, in fallback fonts: your site&apos;s font files are not stored, so this shows the right sizes and weights in whatever typeface this browser has.
        </p>
      </div>

      <ul className="space-y-3">
        {rows.map((row) => (
          <li key={row.key} className="grid gap-4 rounded-xl border border-orb-line bg-orb-raised/40 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold capitalize text-orb-white">{row.title}</h3>
                <SourceBadge source={row.recipe.source} />
              </div>
              {row.recipe.notes && <p className="text-xs leading-relaxed text-orb-gray">{row.recipe.notes}</p>}
              {row.recipe.style && <p className="text-xs leading-relaxed text-orb-gray">{row.recipe.style}</p>}
              {row.clips.length > 0 && (
                <div className="flex flex-wrap items-start gap-2 rounded-xl bg-white p-2" aria-label="As your site draws it">
                  {row.clips.map((clip) => (
                    <AssetImage key={clip.id} workspaceId={workspaceId} assetId={clip.id} alt={`${row.title} as your site draws it`} className={row.kind === "button" || row.kind === "input" ? "max-h-16 w-auto" : "max-h-56 w-auto"} />
                  ))}
                </div>
              )}
            </div>
            <dl className="grid grid-cols-2 content-start gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
              {RECIPE_FIELDS[row.kind].map(([field, label, editor]) => (
                <RecipeField key={field} system={system} pointer={`${row.pointer}/${field}`} label={label} value={row.recipe[field]} editor={editor} />
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One field of a recipe: its value, resolved where it names a token, and the way to correct it. */
function RecipeField({ system, pointer, label, value, editor }) {
  const empty = value === null || value === undefined;
  let shown = String(value);
  let swatch = null;
  if (editor === "colorRef") {
    swatch = resolveColor(system, value);
    shown = empty ? "none" : value;
  } else if (editor === "px") {
    shown = `${value}px`;
  }
  const kind = editor === "colorRef" ? "text" : editor === "radius" || editor === "shadow" ? "choice" : "number";
  const choices = editor === "radius" ? RADIUS_CHOICES : editor === "shadow" ? SHADOW_CHOICES : undefined;

  return (
    <div className="min-w-0">
      <dt className="text-2xs uppercase tracking-[0.08em] text-orb-muted">{label}</dt>
      <dd>
        <PinField pointer={pointer} value={empty ? "" : value} kind={kind} choices={choices} label={`${label.toLowerCase()}${editor === "colorRef" ? " (a role name, transparent, or #rrggbb)" : ""}`}>
          <span className="inline-flex min-w-0 items-center gap-1.5 text-orb-white">
            {swatch && swatch !== "transparent" && <span aria-hidden="true" className="inline-block size-3 shrink-0 rounded-sm border border-orb-line" style={{ backgroundColor: swatch }} />}
            <span className="truncate">{shown}</span>
          </span>
        </PinField>
      </dd>
    </div>
  );
}
