import { BRAND_LIMITS } from "@orbik/core";

import { CONSENT_SELECTORS } from "../../crawler/markdown.js";
import { readProbeStyle, samplePage } from "./inPage.js";

/**
 * What is not the site's own design, though it is on the site's pages.
 *
 * The consent banners the crawler already strips from content, and the chat widgets it never
 * needed to name because they carry no prose: each is another company's component in another
 * company's colours, and a palette that counted an Intercom blue would be wrong about the brand.
 */
const EXCLUDED = [
  CONSENT_SELECTORS,
  "#intercom-container, .intercom-lightweight-app, #hubspot-messages-iframe-container, #crisp-chatbox",
  ".drift-frame-controller, #drift-widget, #tidio-chat, #fc_frame, .tawk-min-container, #chat-widget-container",
  '[id^="zsiq"], [class*="cookie-consent" i], [class*="cookieconsent" i], [id*="cookie" i][role="dialog"], #CybotCookiebotDialog, .cc-window',
].join(", ");

/** How many elements one page's walk may visit. Past this a page is a data table, not a design. */
const MAX_ELEMENTS = 6000;

/** How many of each kind of component are cut out of the screenshots, across the whole run. */
const CLIP_BUDGET = Object.freeze({ button: 4, card: 2, input: 1, nav: 1, footer: 1, hero: 1, logo: 2 });

/** The largest clip kept, in pixels: a component, not a page. */
const MAX_CLIP = Object.freeze({ width: 1440, height: 900 });

/** How long a forced hover is left before it is read, so a transition has finished. */
const HOVER_SETTLE_MS = 380;

/** Screenshot encoding: small enough to keep sixty of, good enough to judge a design by. */
const SHOT = Object.freeze({ type: "webp", quality: 82 });

/**
 * Creates the counter that shares the run's clip allowance between its pages.
 *
 * The home page is rendered first and takes what it has; a later page fills only what is still
 * missing — which is how a contact page's form supplies the input the home page did not have.
 */
export function createClipBudget() {
  const taken = Object.fromEntries(Object.keys(CLIP_BUDGET).map((kind) => [kind, 0]));
  return {
    /** Claims one clip of a kind, or says there is no room for another. */
    claim(kind) {
      if (!(kind in CLIP_BUDGET) || taken[kind] >= CLIP_BUDGET[kind]) return false;
      taken[kind] += 1;
      return true;
    },
  };
}

/**
 * Reads everything one rendered desktop page has to say, while it is still open.
 *
 * Called as the `work` of a render, so the page is settled and will be closed afterwards. Four
 * things can only be had now: the sample, which marks the elements worth a second look; what
 * Chrome says about those elements that a stylesheet cannot — which font actually drew the text,
 * and how a button looks under a pointer; the pictures; and the image bytes the page itself
 * downloaded, which saves fetching them twice.
 *
 * @param {object} page the settled puppeteer page
 * @param {object} options
 * @param {Map<string, {buffer: Buffer, mimeType: string}>} options.responses the page's image responses
 * @param {ReturnType<typeof createClipBudget>} options.clips the run's clip allowance
 * @returns {Promise<object>} `{sample, shots, clips, responses}`
 */
export async function captureDesktop(page, { responses, clips }) {
  const sample = await page.evaluate(samplePage, { excluded: EXCLUDED, maxElements: MAX_ELEMENTS, light: false });
  const boxes = new Map(sample.probes.map((probe) => [probe.key, probe.box]));

  const inspected = await inspectProbes(page, sample).catch(() => ({ fonts: {}, hover: {} }));
  for (const style of sample.typography) {
    if (style.probe && inspected.fonts[style.probe]) style.rendered = inspected.fonts[style.probe];
  }
  for (const button of sample.components.buttons) {
    if (button.probe && inspected.hover[button.probe]) button.hover = inspected.hover[button.probe];
  }

  const shots = {
    viewport: await page.screenshot({ ...SHOT }),
    full: await page.screenshot({
      ...SHOT,
      quality: 74,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: sample.view.width, height: Math.min(sample.pageHeight, BRAND_LIMITS.fullPageHeight) },
    }).catch(() => null),
  };

  const cut = [];
  for (const [key, box] of boxes) {
    const kind = key.split("-")[0];
    if (kind === "type" || box.width < 8 || box.height < 8) continue;
    if (!clips.claim(kind)) continue;
    const pad = kind === "button" || kind === "input" ? 12 : 0;
    const clip = {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: Math.min(MAX_CLIP.width, box.width + pad * 2),
      height: Math.min(MAX_CLIP.height, box.height + pad * 2),
    };
    // A logo set in type is cut as PNG: it is small, and it is the one clip that is itself an asset
    // somebody will hand to another tool.
    const encoding = kind === "logo" ? { type: "png" } : SHOT;
    const buffer = await page.screenshot({ ...encoding, captureBeyondViewport: true, clip }).catch(() => null);
    if (buffer) cut.push({ key, kind, buffer, width: clip.width, height: clip.height, mimeType: kind === "logo" ? "image/png" : "image/webp" });
  }

  return { sample, shots, clips: cut, responses };
}

/**
 * Reads the reduced sample a page gives at the mobile width, and a picture of it.
 *
 * Reduced on purpose: the colours, components and imagery are the desktop page's, and what the
 * narrow width adds is how the type scale and the navigation bar change — which is what the
 * sampler keeps in its light mode.
 */
export async function captureMobile(page) {
  const sample = await page.evaluate(samplePage, { excluded: EXCLUDED, maxElements: MAX_ELEMENTS, light: true });
  return { sample, shots: { viewport: await page.screenshot({ ...SHOT }) } };
}

/**
 * Asks Chrome the two things about a marked element that computed styles do not say.
 *
 * **Which font drew it.** A computed `font-family` is a wish list; `CSS.getPlatformFontsForNode`
 * names the font that actually put glyphs on the screen, which is the only honest answer to "what
 * typeface does this site use" when the first family in the stack failed to load.
 *
 * **How it looks under a pointer.** `CSS.forcePseudoState` holds an element in `:hover` without
 * moving a mouse over a page that may move things in response.
 */
async function inspectProbes(page, sample) {
  const client = await page.createCDPSession();
  const fonts = {};
  const hover = {};
  try {
    await client.send("DOM.enable");
    await client.send("CSS.enable");
    const { root } = await client.send("DOM.getDocument", { depth: 0 });
    const nodeOf = async (key) => {
      const { nodeId } = await client.send("DOM.querySelector", { nodeId: root.nodeId, selector: `[data-orbik-probe="${key}"]` });
      return nodeId || null;
    };

    for (const style of sample.typography) {
      if (!style.probe) continue;
      const nodeId = await nodeOf(style.probe);
      if (!nodeId) continue;
      const answer = await client.send("CSS.getPlatformFontsForNode", { nodeId }).catch(() => null);
      const used = (answer?.fonts ?? []).sort((left, right) => right.glyphCount - left.glyphCount)[0];
      if (used) fonts[style.probe] = { family: used.familyName, postScriptName: used.postScriptName ?? null, webFont: used.isCustomFont === true };
    }

    for (const button of sample.components.buttons) {
      if (!button.probe) continue;
      const nodeId = await nodeOf(button.probe);
      if (!nodeId) continue;
      const atRest = await page.evaluate(readProbeStyle, button.probe);
      await client.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
      await new Promise((resolve) => setTimeout(resolve, HOVER_SETTLE_MS));
      const hovered = await page.evaluate(readProbeStyle, button.probe);
      await client.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
      if (!atRest || !hovered) continue;
      const changed = Object.fromEntries(Object.entries(hovered).filter(([field, value]) => JSON.stringify(value) !== JSON.stringify(atRest[field])));
      hover[button.probe] = Object.keys(changed).length ? changed : null;
    }
  } finally {
    await client.detach().catch(() => {});
  }
  return { fonts, hover };
}
