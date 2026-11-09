import {
  BUTTON_VARIANTS,
  COLOR_ROLES,
  FONT_ROLES,
  PINNED_SOURCE,
  RADIUS_TOKENS,
  SHADOW_TOKENS,
  TYPE_TOKENS,
  safeShadow,
} from "@orbik/protocol";

import { normalizeHex } from "./color.js";

/**
 * Pins: the values of a design system a person set by hand, and which every later derivation
 * therefore leaves alone.
 *
 * They are to a design system what protected blocks are to a Library file, and they exist for the
 * same reason. An agent re-derives the system whenever the site's styling moves; a person who has
 * corrected the primary colour must not find it "corrected" back. So a correction is not an edit
 * to the agent's proposal — it is a separate record, addressed by where in the system it applies,
 * and it is laid over whatever the agent proposes, every time, after the agent has finished.
 *
 * A pin is addressed by a JSON pointer (`/colors/primary/value`). The system is keyed by role and
 * by token rather than by position for exactly this purpose: the third item of a list can be a
 * different thing after the next derivation, and `typography.scale.h2` cannot.
 *
 * Only what is listed in {@link RULES} can be pinned, and each has its own check. A pin is stored
 * and later written into CSS and handed to other people's AIs, so "any value at any path" is not
 * an interface this can offer.
 */

/** What a component recipe may name as its radius or shadow. */
const RADIUS_CHOICES = Object.freeze(["none", ...RADIUS_TOKENS]);
const SHADOW_CHOICES = Object.freeze(["none", ...SHADOW_TOKENS]);

/** What a pin's check answers with. */
const refuse = (message) => ({ ok: false, message });
const accept = (value) => ({ ok: true, value });

// ---- one check per kind of value

const colour = (value) => {
  const hex = normalizeHex(value);
  return hex ? accept(hex) : refuse("Enter a colour as #rrggbb.");
};

const colourReference = (value) => {
  if (value === null) return accept(null);
  if (typeof value === "string" && (value === "transparent" || COLOR_ROLES.includes(value))) return accept(value);
  const hex = normalizeHex(value);
  return hex ? accept(hex) : refuse("Enter a colour as #rrggbb, a role name such as primary, or transparent.");
};

const number = (min, max, { whole = false } = {}) => (value) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (whole && !Number.isInteger(value))) {
    return refuse(`Enter a ${whole ? "whole " : ""}number from ${min} to ${max}.`);
  }
  return accept(Math.round(value * 1000) / 1000);
};

const text = (max, { empty = false } = {}) => (value) => {
  if (typeof value !== "string") return refuse("Enter some text.");
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean && !empty) return refuse("Enter some text.");
  return clean.length > max ? refuse(`Keep it to ${max} characters.`) : accept(clean);
};

const textList = (items, each) => (value) => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return refuse("Enter a list of lines.");
  const clean = value.map((entry) => entry.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (clean.length > items) return refuse(`Keep it to ${items} lines.`);
  return clean.some((entry) => entry.length > each) ? refuse(`Keep each line to ${each} characters.`) : accept(clean);
};

const numberList = (min, max, items) => (value) => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry) || entry < min || entry > max)) {
    return refuse(`Enter a list of numbers from ${min} to ${max}.`);
  }
  return value.length > items ? refuse(`Keep it to ${items} values.`) : accept([...new Set(value)].sort((left, right) => left - right));
};

const choice = (choices) => (value) => (choices.includes(value) ? accept(value) : refuse(`Choose one of: ${choices.join(", ")}.`));

const shadow = (value) => {
  if (value === null || value === "" || value === "none") return accept(null);
  const safe = safeShadow(value);
  return safe ? accept(safe) : refuse("Enter a CSS box-shadow, such as 0 1px 2px rgba(0, 0, 0, 0.05).");
};

const assetId = (value) => (typeof value === "string" && /^[0-9a-f]{24}$/.test(value) ? accept(value) : refuse("Choose one of the stored logos."));

const roles = COLOR_ROLES.join("|");
const families = FONT_ROLES.join("|");
const tokens = TYPE_TOKENS.join("|");
const buttons = BUTTON_VARIANTS.join("|");

/**
 * Everything that can be pinned: a pattern for where, and the check for what.
 *
 * Read top to bottom; the first pattern a pointer matches decides its check.
 */
const RULES = Object.freeze([
  [new RegExp(`^/colors/(${roles})/value$`), colour],
  [new RegExp(`^/colors/(${roles})/usage$`), text(240, { empty: true })],
  [new RegExp(`^/typography/families/(${families})/family$`), text(80)],
  [new RegExp(`^/typography/families/(${families})/fallbacks$`), textList(6, 60)],
  [new RegExp(`^/typography/families/(${families})/weights$`), numberList(100, 900, 9)],
  [new RegExp(`^/typography/scale/(${tokens})/px$`), number(6, 400)],
  [new RegExp(`^/typography/scale/(${tokens})/lineHeight$`), number(0.8, 3)],
  [new RegExp(`^/typography/scale/(${tokens})/weight$`), number(100, 900, { whole: true })],
  [new RegExp(`^/typography/scale/(${tokens})/letterSpacing$`), number(-0.2, 0.5)],
  [new RegExp(`^/typography/scale/(${tokens})/family$`), choice(FONT_ROLES)],
  [new RegExp(`^/typography/scale/(${tokens})/usedFor$`), text(240, { empty: true })],
  [/^\/typography\/rules$/, textList(12, 240)],
  [/^\/spacing\/base\/value$/, number(1, 32)],
  [/^\/spacing\/scale\/value$/, numberList(0, 400, 16)],
  [/^\/spacing\/containerMaxWidth\/value$/, number(320, 2400)],
  [/^\/spacing\/sectionPadding\/value$/, number(0, 400)],
  [new RegExp(`^/shape/radius/(${RADIUS_TOKENS.join("|")})/value$`), number(0, 9999)],
  [/^\/shape\/borderWidth\/value$/, number(0, 16)],
  [new RegExp(`^/shape/shadows/(${SHADOW_TOKENS.join("|")})/value$`), shadow],
  [new RegExp(`^/components/button/(${buttons})/(background|color)$`), (value) => (value === null ? refuse("A button needs this colour.") : colourReference(value))],
  [new RegExp(`^/components/button/(${buttons})/(borderColor|hoverBackground|hoverColor)$`), colourReference],
  [new RegExp(`^/components/button/(${buttons})/(borderWidth|paddingX|paddingY|fontSize)$`), number(0, 400)],
  [new RegExp(`^/components/button/(${buttons})/fontWeight$`), number(100, 900, { whole: true })],
  [new RegExp(`^/components/button/(${buttons})/textTransform$`), choice(["none", "uppercase", "capitalize"])],
  [/^\/components\/(input|card|nav|footer)\/(background|color)$/, (value) => (value === null ? refuse("This needs a colour.") : colourReference(value))],
  [/^\/components\/(input|card|nav)\/borderColor$/, colourReference],
  [/^\/components\/(input|card)\/(borderWidth|paddingX|paddingY|padding|fontSize)$/, number(0, 400)],
  [/^\/components\/nav\/height$/, number(0, 400)],
  [/^\/components\/nav\/style$/, text(240, { empty: true })],
  [/^\/components\/footer\/columns$/, number(1, 12, { whole: true })],
  [new RegExp(`^/components/(button/(${buttons})|input|card|nav)/radius$`), choice(RADIUS_CHOICES)],
  [new RegExp(`^/components/(button/(${buttons})|card|nav)/shadow$`), choice(SHADOW_CHOICES)],
  [new RegExp(`^/components/(button/(${buttons})|input|card|nav|footer)/notes$`), text(240, { empty: true })],
  [/^\/personality\/summary$/, text(400)],
  [/^\/personality\/adjectives$/, textList(8, 40)],
  [/^\/rules$/, textList(12, 240)],
  [/^\/graphics\/description$/, text(1200)],
  [/^\/graphics\/(subjects|paletteUsage|strokeAndShading|perspective|composition|peopleDepiction|texture|mood)$/, text(400, { empty: true })],
  [/^\/graphics\/doNot$/, textList(6, 240)],
  [/^\/graphics\/imagePrompt\/stylePrefix$/, text(1200)],
  [/^\/graphics\/imagePrompt\/negative$/, text(400, { empty: true })],
  [/^\/logos\/primary$/, assetId],
]);

/** The fields that, once pinned, make their whole value a person's rather than the agent's. */
const DEFINING_FIELDS = Object.freeze(["value", "px", "family"]);

/**
 * Checks one pin: that the place can be pinned at all, and that the value fits it.
 *
 * @param {unknown} pointer where in the system, as a JSON pointer
 * @param {unknown} value what to set there
 * @returns {{ok: true, pointer: string, value: unknown} | {ok: false, message: string}}
 */
export function validatePin(pointer, value) {
  if (typeof pointer !== "string" || pointer.length > 200) return refuse("That is not a value that can be pinned.");
  const rule = RULES.find(([pattern]) => pattern.test(pointer));
  if (!rule) return refuse("That is not a value that can be pinned.");
  const checked = rule[1](value);
  return checked.ok ? { ok: true, pointer, value: checked.value } : checked;
}

/** Whether a pointer names something that can be pinned. */
export function isPinnable(pointer) {
  return typeof pointer === "string" && RULES.some(([pattern]) => pattern.test(pointer));
}

/** A pointer as its path segments. The system's keys carry no `/` or `~`, so there is nothing to unescape. */
function segmentsOf(pointer) {
  return pointer.split("/").slice(1);
}

/**
 * Reads the value at a pointer, or `undefined` when nothing is there.
 *
 * @param {object|null} target the system or the proposal
 * @param {string} pointer a JSON pointer
 */
export function readPointer(target, pointer) {
  let current = target;
  for (const segment of segmentsOf(pointer)) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * What an optional part of a system starts as when a person pins a value the agent left empty.
 *
 * A site that never shows a secondary colour has `colors.secondary: null`, and a person who knows
 * the brand has one should be able to say so. Components are not here on purpose: a recipe is a
 * dozen fields that only make sense together, and one pinned field cannot stand in for it.
 */
function emptyParent(segments) {
  if (segments[0] === "colors" && segments.length === 2) return { value: null, source: PINNED_SOURCE, observedFrom: [], usage: "" };
  if (segments[0] === "typography" && segments[1] === "families" && segments.length === 3) return { family: null, fallbacks: [], weights: [], source: PINNED_SOURCE };
  if (segments[0] === "typography" && segments[1] === "scale" && segments.length === 3) {
    return { px: null, lineHeight: 1.4, weight: 400, letterSpacing: 0, family: "body", usedFor: "", source: PINNED_SOURCE };
  }
  if (segments[0] === "logos" && segments.length === 1) return { primary: null };
  if (segments[0] === "graphics" && segments.length === 2 && segments[1] === "imagePrompt") return { stylePrefix: "", negative: "" };
  return null;
}

/**
 * Lays a person's pins over the agent's proposal and returns the system that results.
 *
 * The proposal is not changed: it stays what the agent said, which is what lets the page show
 * "the agent proposed this, you set that" and lets unpinning give the agent's value straight back
 * without a new run. On the result, a value somebody pinned says so — its `source` is `pinned` and
 * `pinned` names the fields that were — so nothing downstream mistakes a person's decision for an
 * observation of the site.
 *
 * A pin whose place no longer exists — a component the site stopped having — is skipped rather
 * than failing the derivation, and is still kept: it applies again if the place comes back.
 *
 * @param {object|null} proposal the system as the agent proposed it
 * @param {ReadonlyArray<{pointer: string, value: unknown}>} pins what a person set
 * @returns {object|null} the effective system, or null when there is no proposal to lay pins over
 */
export function applyPins(proposal, pins = []) {
  if (!proposal) return null;
  const system = structuredClone(proposal);
  for (const pin of pins) {
    if (!isPinnable(pin.pointer)) continue;
    const segments = segmentsOf(pin.pointer);
    const field = segments.at(-1);
    let parent = system;
    let reachable = true;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      if (parent[segment] === null || parent[segment] === undefined) {
        const created = emptyParent(segments.slice(0, index + 1));
        if (!created) {
          reachable = false;
          break;
        }
        parent[segment] = created;
      }
      if (typeof parent[segment] !== "object") {
        reachable = false;
        break;
      }
      parent = parent[segment];
    }
    if (!reachable) continue;

    parent[field] = pin.value;
    // Lists pinned whole (`/rules`) have no holder to mark; the pin record itself says they are.
    if (!Array.isArray(parent) && segments.length > 1) {
      parent.pinned = [...new Set([...(parent.pinned ?? []), field])];
      if (DEFINING_FIELDS.includes(field) && Object.hasOwn(parent, "source")) parent.source = PINNED_SOURCE;
    }
  }

  // An optional part created for a pin that did not give it its defining value — a usage note
  // pinned on a colour that has no colour — is not a part of the system yet.
  for (const role of COLOR_ROLES) {
    if (system.colors?.[role] && !system.colors[role].value) system.colors[role] = null;
  }
  for (const role of FONT_ROLES) {
    if (system.typography?.families?.[role] && !system.typography.families[role].family) system.typography.families[role] = null;
  }
  for (const token of TYPE_TOKENS) {
    if (system.typography?.scale?.[token] && typeof system.typography.scale[token].px !== "number") system.typography.scale[token] = null;
  }
  return system;
}
