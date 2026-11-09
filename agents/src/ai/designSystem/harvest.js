import { createHash } from "node:crypto";

import { sanitiseSvg } from "@orbik/assets";
import { BRAND_ASSET_KINDS, BRAND_LIMITS } from "@orbik/core";
import { isHexColor, relativeLuminance } from "@orbik/design-system";

import { crawlerUserAgent } from "../../crawler/siteConfig.js";
import { rasterise } from "./inPage.js";

/** The largest original image read, in bytes. A larger one is a download, not a web image. */
const MAX_ORIGINAL_BYTES = 8 * 1024 * 1024;

/** How long one image request may take. */
const FETCH_TIMEOUT_MS = 15_000;

/** A raster logo this small is kept exactly as the site serves it. */
const LOGO_AS_IS_BYTES = 512 * 1024;

/** Formats a raster logo may be kept in without re-encoding. */
const WEB_RASTERS = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);

/** At or under this many pixels on its longest edge, an image is an icon. */
const ICON_EDGE = 96;

/**
 * How many distinct colours make a photograph, counted on the sampler's small copy.
 *
 * A flat illustration has a few dozen however large it is drawn; a photograph, or a rendered 3D
 * scene, has hundreds. The line is a working figure and a person can overrule it per image.
 */
const PHOTO_COLOURS = 110;

/** Where a site keeps the icon it gives to a phone's home screen, when its pages do not say. */
const ICON_FALLBACKS = Object.freeze(["/apple-touch-icon.png", "/icon.svg", "/favicon.svg", "/favicon.ico"]);

/**
 * Creates the collector that turns what the pages showed into stored assets.
 *
 * Three sources of bytes, tried in that order: what the page itself downloaded while it rendered
 * (so most images cost no second request), a plain fetch behind the public-address check, and —
 * for a logo set in type, which has no file at all — a piece cut out of the screenshot.
 *
 * **Chrome does the image work.** Decoding, resizing and re-encoding happen on a blank tab of
 * Orbik's own, on bytes the worker already holds, so every format a browser can show is handled
 * and no native image library is added to the worker. Vector images are kept as source rather
 * than flattened: an SVG is the one image format an outside AI can read, restyle and reuse.
 *
 * **Other companies' marks are not this brand's.** A wall of customer logos or a row of review
 * badges is on the page and is left out here, by the sampler's own marking: stored and served
 * over MCP as "the brand's imagery", they would be the opposite.
 *
 * @param {object} options collaborators
 * @param {object} options.session the browser session, for a blank tab to rasterise on
 * @param {ReturnType<import("@orbik/assets").createAssetStore>} options.store where assets go
 * @param {unknown} options.workspaceId owning workspace
 * @param {unknown} options.runId the run doing the harvesting
 * @param {string} options.origin the site's origin
 * @param {(url: string) => Promise<void>} options.assertPublicAddress refuses a non-public address
 * @param {AbortSignal} [options.signal] cancellation
 * @param {(level: string, message: string, context?: object) => void} [options.logger]
 * @param {typeof fetch} [options.fetchImpl] the request function
 */
export function createHarvester({ session, store, workspaceId, runId, origin, assertPublicAddress, signal, logger = () => {}, fetchImpl = fetch }) {
  /** Bytes the pages downloaded, by address, for the images worth keeping. */
  const held = new Map();
  /** Hashes stored by this run, so one picture found twice is counted once. */
  const stored = new Map();
  let tool = null;

  /** The blank tab images are measured and resized on, opened when first needed. */
  async function toolPage() {
    tool = tool ?? (await session.blank());
    return tool;
  }

  /** The bytes behind an address: held from a page's own load, or fetched now. */
  async function bytesOf(url) {
    if (!url) return null;
    if (held.has(url)) return held.get(url);
    if (url.startsWith("data:")) {
      const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
      if (!match) return null;
      const buffer = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8");
      return { buffer, mimeType: match[1] ?? "application/octet-stream" };
    }
    try {
      await assertPublicAddress(url);
      const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      const response = await fetchImpl(url, {
        headers: { Accept: "image/*,*/*;q=0.5", "User-Agent": crawlerUserAgent() },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok || Number(response.headers.get("content-length") ?? 0) > MAX_ORIGINAL_BYTES) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > MAX_ORIGINAL_BYTES) return null;
      return { buffer, mimeType: String(response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() };
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    }
  }

  /** Decodes an image in Chrome and returns its measure, and its bytes re-encoded unless `keep`. */
  async function measure(buffer, mimeType, { maxEdge = BRAND_LIMITS.rasterEdge, format = "webp", keep = false } = {}) {
    const page = await toolPage();
    const dataUrl = `data:${mimeType || "application/octet-stream"};base64,${buffer.toString("base64")}`;
    const result = await page.evaluate(rasterise, { dataUrl, maxEdge, quality: 0.86, format, keep }).catch(() => ({ ok: false }));
    return result?.ok ? result : null;
  }

  /** Stores one asset, once per picture per run, and returns how it is referred to afterwards. */
  async function keep({ kind, buffer, mimeType, meta }) {
    if (!buffer?.length || buffer.length > BRAND_LIMITS.assetBytes) return null;
    const hash = createHash("sha256").update(buffer).digest("hex");
    if (stored.has(hash)) return stored.get(hash);
    const { id, asset } = await store.put({ workspaceId, runId, kind, bytes: buffer, mimeType, meta });
    const reference = {
      id: id.toHexString(),
      // A person may have reclassified it; what the row says now is what the observation records.
      kind: asset.kind,
      mimeType,
      bytes: buffer.length,
      width: meta.width ?? null,
      height: meta.height ?? null,
      alt: meta.alt ?? null,
      label: meta.label ?? null,
      position: meta.position ?? null,
      pageUrl: meta.pageUrl ?? null,
      sourceUrl: meta.sourceUrl ?? null,
      variant: meta.variant ?? null,
      tone: meta.tone ?? null,
      dominantColors: meta.dominantColors ?? [],
      hidden: asset.hidden === true,
    };
    stored.set(hash, reference);
    return reference;
  }

  /** Stores a vector image as its own source, measured by drawing it once. */
  async function keepSvg({ kind, source, meta }) {
    const clean = sanitiseSvg(source);
    const buffer = Buffer.from(clean, "utf8");
    const measured = await measure(buffer, "image/svg+xml", { keep: true });
    // A vector that draws nothing visible — a spacer, a clipping mask, a grid of hairlines at two
    // per cent opacity — is on the page and is not imagery.
    if (!measured || measured.transparent > 0.985 || measured.colorCount === 0) return null;
    return keep({
      kind,
      buffer,
      mimeType: "image/svg+xml",
      meta: { ...meta, width: meta.width ?? measured.naturalWidth, height: meta.height ?? measured.naturalHeight, dominantColors: measured.dominantColors, colorCount: measured.colorCount },
    });
  }

  return {
    /**
     * Keeps the image bytes a page downloaded that something in its sample refers to.
     *
     * Called as each page closes. Everything else the page loaded — tracking pixels, other
     * companies' logos — is let go with it, which is what keeps eight pages of images from being
     * eight pages of images in memory.
     */
    hold(sample, responses) {
      const wanted = new Set([...sample.images.filter((image) => !image.foreign).map((image) => image.src), ...sample.logos.map((logo) => logo.src).filter(Boolean)]);
      for (const url of wanted) {
        const response = responses.get(url);
        if (response && !held.has(url)) held.set(url, response);
      }
    },

    /** Stores a picture Orbik took itself: a screenshot, a clip, a sheet. */
    keepCapture({ kind, buffer, mimeType = "image/webp", meta }) {
      return keep({ kind, buffer, mimeType, meta });
    },

    /**
     * Stores the site's own marks, the most certainly-a-logo first.
     *
     * @param {Array<{page: object, sample: object, clips: object[]}>} pages the rendered pages
     * @param {object|null} documentInfo the home page's document facts
     * @returns {Promise<object[]>} what was stored
     */
    async logos(pages, documentInfo) {
      const candidates = [];
      const seen = new Set();
      for (const { page, sample, clips } of pages) {
        for (const logo of sample.logos) {
          const identity = logo.src ?? logo.source ?? `text:${logo.text}`;
          if (seen.has(identity)) continue;
          seen.add(identity);
          candidates.push({ ...logo, pageUrl: page.url, clip: logo.probe ? clips.find((clip) => clip.key === logo.probe) ?? null : null });
        }
      }
      candidates.sort((left, right) => right.score - left.score || left.y - right.y);

      const kept = [];
      for (const logo of candidates) {
        if (kept.length >= BRAND_LIMITS.logos - 1) break;
        const shape = { width: logo.width, height: logo.height, alt: logo.alt || logo.text || null, pageUrl: logo.pageUrl, position: logo.reason, variant: variantOf(logo.width, logo.height) };
        let reference = null;
        if (logo.clip) {
          // Set in type: cut from the page. The label says so, because nobody can ask the site
          // for a file it does not have.
          reference = await keep({
            kind: BRAND_ASSET_KINDS.logo,
            buffer: logo.clip.buffer,
            mimeType: "image/png",
            meta: { ...shape, width: logo.clip.width, height: logo.clip.height, variant: "wordmark", tone: toneOn(logo.under), label: `Text wordmark “${logo.text}”`, dominantColors: logo.type?.color ? [logo.type.color] : [] },
          });
          if (reference) reference.type = logo.type ?? null;
        } else if (logo.source) {
          reference = await keepSvg({ kind: BRAND_ASSET_KINDS.logo, source: logo.source, meta: { ...shape, tone: toneOn(logo.under) } });
        } else {
          const original = await bytesOf(logo.src);
          if (!original) continue;
          if (isSvg(original, logo.src)) {
            reference = await keepSvg({ kind: BRAND_ASSET_KINDS.logo, source: original.buffer.toString("utf8"), meta: { ...shape, sourceUrl: logo.src, tone: toneOn(logo.under) } });
          } else {
            const asIs = WEB_RASTERS.has(original.mimeType) && original.buffer.length <= LOGO_AS_IS_BYTES;
            const measured = await measure(original.buffer, original.mimeType, { format: "png", keep: asIs });
            if (!measured) continue;
            reference = await keep({
              kind: BRAND_ASSET_KINDS.logo,
              buffer: asIs ? original.buffer : Buffer.from(measured.data, "base64"),
              mimeType: asIs ? original.mimeType : "image/png",
              meta: { ...shape, sourceUrl: logo.src, width: measured.naturalWidth, height: measured.naturalHeight, variant: variantOf(measured.naturalWidth, measured.naturalHeight), tone: toneOn(logo.under), dominantColors: measured.dominantColors, colorCount: measured.colorCount },
            });
          }
        }
        if (reference) kept.push(reference);
      }

      // The icon a phone would put on its home screen: usually the symbol on its own, which is the
      // one form of a logo a wordmark in the header never shows.
      const declared = (documentInfo?.icons ?? [])
        .map((icon) => ({ ...icon, edge: Number.parseInt(String(icon.sizes ?? "").split("x")[0], 10) || (/apple-touch/.test(icon.rel) ? 180 : /svg/.test(icon.type ?? icon.href) ? 512 : 32) }))
        .sort((left, right) => right.edge - left.edge)
        .map((icon) => icon.href);
      for (const url of [...declared, documentInfo?.organizationLogo, ...ICON_FALLBACKS.map((path) => `${origin}${path}`)].filter(Boolean).slice(0, 8)) {
        const original = await bytesOf(url);
        if (!original) continue;
        const reference = isSvg(original, url)
          ? await keepSvg({ kind: BRAND_ASSET_KINDS.logo, source: original.buffer.toString("utf8"), meta: { sourceUrl: url, position: "app-icon", variant: "symbol", label: "App icon" } })
          : await (async () => {
              const measured = await measure(original.buffer, original.mimeType, { maxEdge: 512, format: "png" });
              if (!measured || Math.max(measured.naturalWidth, measured.naturalHeight) < 32) return null;
              return keep({
                kind: BRAND_ASSET_KINDS.logo,
                buffer: Buffer.from(measured.data, "base64"),
                mimeType: "image/png",
                meta: { sourceUrl: url, position: "app-icon", variant: variantOf(measured.width, measured.height), label: "App icon", width: measured.width, height: measured.height, dominantColors: measured.dominantColors, colorCount: measured.colorCount },
              });
            })();
        if (reference) {
          kept.push(reference);
          break;
        }
      }
      return kept;
    },

    /**
     * Stores the site's own imagery: its largest pictures, and its icons and vector drawings.
     *
     * Two allowances, because they are two different things to a reader. The larger images are
     * what the brand's photography or illustration looks like, and twelve of the biggest say it.
     * The small vectors are the icon set, where what matters is that there are enough to see
     * the stroke and the corner they share.
     *
     * @param {Array<{page: object, sample: object}>} pages the rendered pages
     * @param {object|null} documentInfo the home page's document facts
     * @param {Set<string>} logoSources addresses and sources already kept as logos
     * @returns {Promise<{images: object[], icons: object[], seen: {images: number, vectors: number, foreign: number}}>}
     */
    async imagery(pages, documentInfo, logoSources) {
      const files = new Map();
      const vectors = new Map();
      let foreign = 0;
      for (const { page, sample } of pages) {
        for (const image of sample.images) {
          if (image.foreign) {
            foreign += 1;
            continue;
          }
          if (logoSources.has(image.src) || Math.max(image.width, image.height) < 24) continue;
          const area = image.width * image.height;
          const current = files.get(image.src);
          if (!current || area > current.area) files.set(image.src, { ...image, area, pageUrl: page.url, viewHeight: sample.view.height });
        }
        for (const svg of sample.svgs) {
          if (logoSources.has(svg.source) || svg.homeLink) continue;
          const key = createHash("sha256").update(svg.source.replace(/\s(width|height|style)="[^"]*"/g, "")).digest("hex");
          const current = vectors.get(key);
          if (current) current.count += svg.count;
          else vectors.set(key, { ...svg, pageUrl: page.url });
        }
      }
      // The picture a site gives a social network to stand for it, when it is not already on a page.
      if (documentInfo?.ogImage && !files.has(documentInfo.ogImage)) {
        files.set(documentInfo.ogImage, { src: documentInfo.ogImage, type: "social-card", alt: "", width: 600, height: 315, area: 0, y: 0, region: null, pageUrl: null, viewHeight: 0 });
      }

      const images = [];
      const small = [];
      const ranked = [...files.values()].sort((left, right) => right.area - left.area);
      for (const image of ranked) {
        if (images.length >= BRAND_LIMITS.images && small.length >= BRAND_LIMITS.icons) break;
        const icon = Math.max(image.width, image.height) <= ICON_EDGE;
        if ((icon && small.length >= BRAND_LIMITS.icons) || (!icon && images.length >= BRAND_LIMITS.images)) continue;
        const original = await bytesOf(image.src);
        if (!original) continue;
        const meta = {
          sourceUrl: image.src.startsWith("data:") ? null : image.src,
          pageUrl: image.pageUrl,
          alt: image.alt || null,
          position: image.type === "social-card" ? "social-card" : positionOf(image),
        };
        let reference = null;
        if (isSvg(original, image.src)) {
          // Measured as the page drew it: a vector file often declares no size of its own, and
          // the size Chrome then invents for it says nothing about the picture.
          reference = await keepSvg({
            kind: icon ? BRAND_ASSET_KINDS.icon : BRAND_ASSET_KINDS.illustration,
            source: original.buffer.toString("utf8"),
            meta: image.type === "social-card" ? meta : { ...meta, width: image.width, height: image.height },
          });
        } else {
          const measured = await measure(original.buffer, original.mimeType);
          if (!measured || Math.max(measured.naturalWidth, measured.naturalHeight) < 24) continue;
          reference = await keep({
            kind: icon ? BRAND_ASSET_KINDS.icon : measured.colorCount >= PHOTO_COLOURS ? BRAND_ASSET_KINDS.photo : BRAND_ASSET_KINDS.illustration,
            buffer: Buffer.from(measured.data, "base64"),
            mimeType: "image/webp",
            meta: { ...meta, width: measured.width, height: measured.height, dominantColors: measured.dominantColors, colorCount: measured.colorCount },
          });
        }
        if (reference) (icon ? small : images).push(reference);
      }

      // Inline vectors: the commonest first, since an icon used on every page is more the site's
      // icon than one used once; then the larger, which are its drawings.
      const drawn = [...vectors.values()].sort((left, right) => right.count - left.count || right.width * right.height - left.width * left.height);
      for (const svg of drawn) {
        if (small.length >= BRAND_LIMITS.icons) break;
        const icon = Math.max(svg.width, svg.height) <= ICON_EDGE;
        const reference = await keepSvg({
          kind: icon ? BRAND_ASSET_KINDS.icon : BRAND_ASSET_KINDS.illustration,
          source: svg.source,
          meta: { pageUrl: svg.pageUrl, alt: svg.label || null, width: svg.width, height: svg.height, position: icon ? (svg.inButton ? "button-icon" : svg.region ? `${svg.region}-icon` : "icon") : positionOf(svg) },
        });
        if (reference) small.push(reference);
      }

      return { images, icons: small, seen: { images: files.size, vectors: vectors.size, foreign } };
    },

    /** Decodes and measures on the tool tab; exposed for the sheets, which are laid out there too. */
    toolPage,

    /** Closes the tool tab. */
    async close() {
      await tool?.close().catch(() => {});
      tool = null;
      held.clear();
      logger("info", "design_system.harvest_closed", { stored: stored.size });
    },
  };
}

/** Whether some bytes are an SVG, by what they say, their type or their name. */
function isSvg(original, url) {
  if (original.mimeType.includes("svg")) return true;
  if (/\.svg(\?|#|$)/i.test(String(url ?? "")) && !original.mimeType.startsWith("image/")) return true;
  return /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(original.buffer.subarray(0, 600).toString("utf8"));
}

/** What form of logo a shape is: a symbol is about square, a wordmark is long, a lockup between. */
function variantOf(width, height) {
  const ratio = width / Math.max(1, height);
  if (ratio <= 1.4) return "symbol";
  return ratio > 3.2 ? "wordmark" : "lockup";
}

/** Which kind of background a mark was seen on, which is the kind it was drawn for. */
function toneOn(under) {
  if (!isHexColor(under)) return null;
  return relativeLuminance(under) >= 0.4 ? "on-light" : "on-dark";
}

/** Where on a page an image sat, in the terms a designer would use. */
function positionOf(image) {
  if (image.region === "nav" || image.region === "footer") return image.region;
  if (Math.max(image.width, image.height) <= ICON_EDGE) return "icon";
  if (image.y < (image.viewHeight || 900) && image.width * image.height >= 120_000) return "hero";
  return image.type === "background" ? "background" : "section";
}
