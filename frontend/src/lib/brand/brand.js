/**
 * The Brand page's vocabulary: what the parts of a design system are called, and how a run of the
 * agent that derives one reads.
 *
 * Mirrors `@orbik/protocol` and `@orbik/core`, which the browser bundle does not import: the API
 * is the authority on what a system holds, and this is only how its parts are named on screen.
 */

/** The agent that derives the design system; also its route segment in the web app. */
export const DESIGN_SYSTEM_AGENT_SLUG = "design-system";

/** How many pages a person may choose for the agent to render. */
export const MAX_DESIGN_PAGES = 8;

/** The colour roles, in the order the page lists them, with how each is named. */
export const COLOR_ROLES = Object.freeze([
  { role: "primary", label: "Primary", required: true },
  { role: "secondary", label: "Secondary", required: false },
  { role: "accent", label: "Accent", required: false },
  { role: "background", label: "Background", required: true },
  { role: "surface", label: "Surface", required: true },
  { role: "text", label: "Text", required: true },
  { role: "textMuted", label: "Muted text", required: true },
  { role: "border", label: "Border", required: true },
  { role: "link", label: "Link", required: true },
  { role: "success", label: "Success", required: false },
  { role: "warning", label: "Warning", required: false },
  { role: "error", label: "Error", required: false },
]);

/** The roles a typeface can play. */
export const FONT_ROLES = Object.freeze([
  { role: "heading", label: "Headings" },
  { role: "body", label: "Body" },
  { role: "mono", label: "Monospace" },
]);

/** The steps of the type scale, largest first, with how each is named. */
export const TYPE_TOKENS = Object.freeze([
  { token: "display", label: "Display" },
  { token: "h1", label: "Heading 1" },
  { token: "h2", label: "Heading 2" },
  { token: "h3", label: "Heading 3" },
  { token: "h4", label: "Heading 4" },
  { token: "bodyLarge", label: "Body large" },
  { token: "body", label: "Body" },
  { token: "small", label: "Small" },
  { token: "caption", label: "Caption" },
  { token: "button", label: "Button" },
  { token: "label", label: "Label" },
]);

/** The radius and shadow tokens. */
export const RADIUS_TOKENS = Object.freeze(["sm", "md", "lg", "pill"]);
export const SHADOW_TOKENS = Object.freeze(["sm", "md", "lg"]);

/** The button variants a system describes. */
export const BUTTON_VARIANTS = Object.freeze(["primary", "secondary", "ghost"]);

/** The attributes of a graphics language, in the order they are listed. */
export const GRAPHICS_FIELDS = Object.freeze([
  { field: "subjects", label: "Subjects" },
  { field: "paletteUsage", label: "Colour" },
  { field: "strokeAndShading", label: "Line and shading" },
  { field: "perspective", label: "Perspective" },
  { field: "composition", label: "Composition" },
  { field: "peopleDepiction", label: "People" },
  { field: "texture", label: "Texture" },
  { field: "mood", label: "Mood" },
]);

/**
 * What each source means, in the words the page uses.
 *
 * The four are the point of the page: a reader has to be able to tell what the site does from
 * what was tidied, suggested, or set by them.
 */
export const SOURCE_LABELS = Object.freeze({
  observed: { label: "Observed", hint: "Seen on your site as it is." },
  derived: { label: "Derived", hint: "Normalised from several values seen on your site." },
  proposed: { label: "Proposed", hint: "Suggested to fill a gap your site leaves." },
  pinned: { label: "Pinned", hint: "Set by you. The agent leaves it alone." },
});

/** The kinds of image a person may say a harvested image is. */
export const IMAGE_KINDS = Object.freeze([
  { kind: "illustration", label: "Illustration" },
  { kind: "photo", label: "Photograph" },
  { kind: "icon", label: "Icon" },
  { kind: "logo", label: "Logo" },
]);

/** The stages of a derivation, in order, as the run rail shows them. */
const PHASES = Object.freeze([
  { id: "render", label: "Rendering", steps: ["prepare", "fingerprint", "render"] },
  { id: "sample", label: "Sampling", steps: ["sample", "assets"] },
  { id: "synthesise", label: "Synthesising", steps: ["synthesise"] },
  { id: "store", label: "Storing", steps: ["record"] },
]);

/**
 * Reads a run's events as the four stages a derivation goes through.
 *
 * The runtime names a step on every progress event, so where a run is can be read from the last
 * one rather than guessed from elapsed time. Rendering also says how far through its pages it is,
 * which is the one stage long enough to want a count.
 *
 * @param {Array<object>} events the run's progress events, oldest first
 * @param {boolean} complete whether the run has finished
 * @returns {Array<{id: string, label: string, state: "done"|"active"|"pending", detail: string|null}>}
 */
export function runPhases(events, complete) {
  const stepped = events.filter((event) => event.type === "progress" && event.step);
  const current = stepped.at(-1)?.step ?? null;
  const reached = PHASES.findIndex((phase) => phase.steps.includes(current));
  const rendering = stepped.filter((event) => event.step === "render").map((event) => /Rendering (\d+) of (\d+)/.exec(event.message ?? "")).filter(Boolean).at(-1);
  return PHASES.map((phase, index) => ({
    id: phase.id,
    label: phase.label,
    state: complete || index < reached ? "done" : index === reached ? "active" : "pending",
    detail: phase.id === "render" && rendering ? `${rendering[1]}/${rendering[2]}` : null,
  }));
}

/** The pin on one place of the system, or null. */
export function pinAt(pins, pointer) {
  return pins?.find((pin) => pin.pointer === pointer) ?? null;
}

/** Reads the value at a JSON pointer, or undefined. */
export function readPointer(target, pointer) {
  let current = target;
  for (const segment of pointer.split("/").slice(1)) {
    if (current === null || typeof current !== "object" || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** A pointer as a person reads it: `/typography/scale/h1/px` is "typography · scale · h1 · px". */
export function describePointer(pointer) {
  return pointer.split("/").slice(1).join(" · ");
}

/**
 * The colour a recipe names, as something a stylesheet can paint with.
 *
 * A recipe says `primary` rather than repeating a hex, which is what makes pinning the primary
 * change every button; this resolves the name against the system on screen.
 */
export function resolveColor(system, reference) {
  if (!reference) return null;
  if (reference === "transparent") return "transparent";
  if (system?.colors?.[reference]?.value) return system.colors[reference].value;
  return /^#[0-9a-f]{6}$/i.test(reference) ? reference : null;
}

/** The radius a recipe names, in pixels. */
export function resolveRadius(system, token) {
  return token === "none" ? 0 : system?.shape?.radius?.[token]?.value ?? 0;
}

/** The shadow a recipe names, as a CSS value, or `none`. */
export function resolveShadow(system, token) {
  return token === "none" ? "none" : system?.shape?.shadows?.[token]?.value ?? "none";
}

/** A family as a `font-family` value, falling back to what the browser has. */
export function fontStack(family) {
  if (!family?.family) return "inherit";
  return [family.family, ...(family.fallbacks ?? [])].map((name) => (/^[a-z-]+$/i.test(name) ? name : `"${name.replace(/"/g, "")}"`)).join(", ");
}

/** A number of bytes as a person reads one. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
