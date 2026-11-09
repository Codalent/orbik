import { COLOR_ROLES } from "@orbik/protocol";

/**
 * Writes out what an image model needs to draw in a brand's style.
 *
 * An image model cannot read a design system. What it can take is a paragraph of style to put
 * before a subject, a list of what to avoid, a handful of colours, and a few pictures to imitate —
 * so that is what this is, in that order, as plain text a person pastes or an agent passes on. The
 * reference images are the ones marked as references on the Brand page, each as a link that works
 * for an hour: long enough to hand to a model, short enough not to be a permanent public address.
 *
 * @param {object} options
 * @param {object} options.system the effective system, pins applied
 * @param {string} options.host the site it was derived from
 * @param {object[]} [options.assets] the workspace's stored assets
 * @param {(asset: object) => string|null} [options.assetUrl] how an asset is linked in this text
 * @returns {string} the prompt kit
 */
export function renderImagePrompt({ system, host, assets = [], assetUrl = () => null }) {
  const graphics = system.graphics;
  const lines = [`Image style for ${host}`, ""];
  if (!graphics?.imagePrompt?.stylePrefix) {
    lines.push("No graphics language has been derived for this site yet, so there is no style to give an image model.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("STYLE — put this before your subject:", graphics.imagePrompt.stylePrefix, "");
  if (graphics.imagePrompt.negative) lines.push("AVOID:", graphics.imagePrompt.negative, "");

  const palette = COLOR_ROLES.filter((role) => system.colors?.[role]?.value).slice(0, 8).map((role) => `${role} ${system.colors[role].value}`);
  if (palette.length) lines.push("PALETTE:", palette.join(", "), "");

  const visible = assets.filter((asset) => asset.hidden !== true);
  const references = visible.filter((asset) => asset.isReference === true && asset.kind !== "logo").slice(0, 5);
  if (references.length) {
    lines.push("REFERENCE IMAGES — the brand's own, to imitate in style and not in subject:");
    references.forEach((asset, index) => {
      const url = assetUrl(asset);
      lines.push(`${index + 1}. ${asset.caption ?? asset.alt ?? asset.kind}${url ? `\n   ${url}` : ""}`);
    });
    lines.push("");
  }

  const primaryId = system.logos?.primary ?? null;
  const logo = visible.find((asset) => asset.kind === "logo" && String(asset._id ?? asset.id) === primaryId) ?? visible.find((asset) => asset.kind === "logo");
  if (logo) {
    const url = assetUrl(logo);
    lines.push("LOGO — use the file as it is; never ask a model to redraw it:", `${graphics.logo?.description ?? logo.label ?? "The brand's logo."}${url ? `\n   ${url}` : ""}`, "");
  }

  lines.push(
    "HOW TO USE:",
    "Give the image model the style paragraph, then your subject, then the reference images if it accepts images. Keep the avoid list as a negative prompt where the model has one, and as a closing sentence where it does not.",
  );
  return `${lines.join("\n")}\n`;
}
