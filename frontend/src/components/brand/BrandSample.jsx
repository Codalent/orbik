"use client";

import { BUTTON_VARIANTS, fontStack, resolveColor, resolveRadius, resolveShadow } from "@/lib/brand/brand";

/**
 * A few components drawn live from the system's tokens, so a person sees the proposal applied.
 *
 * Plain HTML styled from the system on screen and nothing else: a navigation bar, a heading with
 * its buttons, a card and a field, each built from its recipe. Change a pin anywhere on the page
 * and this changes with it, which is the quickest way to tell whether a correction did what was
 * meant.
 *
 * It is set in the fallback fonts. The site's font files are not stored, so the family named in
 * the system is asked for and the browser uses it only if this machine happens to have it — which
 * is said under the sample, because a heading in the wrong typeface would otherwise look like a
 * mistake in the proposal.
 *
 * @param {object} props
 * @param {object} props.system the effective system, pins applied
 */
export function BrandSample({ system }) {
  const colour = (reference, fallback = "transparent") => resolveColor(system, reference) ?? fallback;
  const families = system.typography?.families ?? {};
  const scale = system.typography?.scale ?? {};
  const components = system.components ?? {};
  const heading = scale.h2 ?? scale.h1;
  const body = scale.body;
  const nav = components.nav;
  const card = components.card;
  const input = components.input;

  const border = (recipe) => (recipe?.borderColor && recipe.borderWidth > 0 ? `${recipe.borderWidth}px solid ${colour(recipe.borderColor)}` : "0");
  const buttonStyle = (recipe) => ({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: colour(recipe.background),
    color: colour(recipe.color, "inherit"),
    border: border(recipe),
    borderRadius: resolveRadius(system, recipe.radius),
    padding: `${recipe.paddingY}px ${recipe.paddingX}px`,
    // A recipe read from a fixed-height button has no vertical padding of its own.
    minHeight: recipe.paddingY === 0 ? Math.round(recipe.fontSize * 2.4) : undefined,
    fontSize: recipe.fontSize,
    fontWeight: recipe.fontWeight,
    textTransform: recipe.textTransform,
    boxShadow: resolveShadow(system, recipe.shadow),
    fontFamily: fontStack(families.body),
    lineHeight: 1.2,
  });

  return (
    <div
      className="overflow-hidden rounded-xl border border-orb-line"
      style={{ background: colour("background", "#ffffff"), color: colour("text", "#111111"), fontFamily: fontStack(families.body), fontSize: body?.px ?? 16, lineHeight: body?.lineHeight ?? 1.5 }}
    >
      {nav && (
        <div style={{ padding: 12 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              minHeight: Math.min(nav.height || 56, 72),
              padding: "0 16px",
              background: colour(nav.background),
              color: colour(nav.color, "inherit"),
              border: nav.borderColor ? `1px solid ${colour(nav.borderColor)}` : "0",
              borderRadius: resolveRadius(system, nav.radius),
              boxShadow: resolveShadow(system, nav.shadow),
            }}
          >
            <span style={{ fontFamily: fontStack(families.heading), fontWeight: 600, color: colour("text") }}>Brand</span>
            <span style={{ display: "flex", gap: 18, fontSize: 14 }}><span>Services</span><span>Work</span><span>About</span></span>
            {components.button?.primary && <span style={{ ...buttonStyle(components.button.primary), padding: "0 14px", minHeight: 34, fontSize: 14 }}>Get in touch</span>}
          </div>
        </div>
      )}

      <div style={{ padding: "28px 24px 32px", display: "grid", gap: 20 }}>
        <div>
          {heading && (
            <p style={{ margin: 0, fontFamily: fontStack(families[heading.family] ?? families.heading), fontSize: Math.min(heading.px, 40), lineHeight: heading.lineHeight, fontWeight: heading.weight, letterSpacing: `${heading.letterSpacing ?? 0}em`, color: colour("text") }}>
              A heading in this system
            </p>
          )}
          <p style={{ margin: "10px 0 0", maxWidth: 520, color: colour("textMuted") }}>
            Body copy sits in the muted text colour at the body size, with <span style={{ color: colour("link"), textDecoration: "underline" }}>a link in the link colour</span>.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 18 }}>
            {BUTTON_VARIANTS.filter((variant) => components.button?.[variant]).map((variant) => (
              <span key={variant} style={buttonStyle(components.button[variant])}>{variant === "primary" ? "Primary action" : variant === "secondary" ? "Secondary" : "Ghost"}</span>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          {card && (
            <div style={{ background: colour(card.background), border: border(card), borderRadius: resolveRadius(system, card.radius), padding: card.padding, boxShadow: resolveShadow(system, card.shadow) }}>
              <p style={{ margin: 0, fontFamily: fontStack(families.heading), fontWeight: scale.h3?.weight ?? 600, fontSize: Math.min(scale.h3?.px ?? 20, 22), color: colour("text") }}>A card</p>
              <p style={{ margin: "8px 0 0", color: colour("textMuted"), fontSize: 14 }}>Its background, border, radius, padding and shadow come from the card recipe.</p>
            </div>
          )}
          {input && (
            <div style={{ background: colour("surface"), borderRadius: resolveRadius(system, "md"), padding: 16 }}>
              <span style={{ display: "block", fontSize: scale.label?.px ?? 14, marginBottom: 6, color: colour("text") }}>Email</span>
              <span style={{ display: "block", background: colour(input.background), color: colour("textMuted"), border: border(input), borderRadius: resolveRadius(system, input.radius), padding: `${input.paddingY}px ${input.paddingX}px`, fontSize: input.fontSize }}>
                you@example.com
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
