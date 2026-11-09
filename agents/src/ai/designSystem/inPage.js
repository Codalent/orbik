/**
 * The functions that run inside the page, in Chrome.
 *
 * Each is handed to `page.evaluate`, which sends its source text to the browser: so each is
 * self-contained, closes over nothing in this module, and takes and returns plain JSON. What they
 * measure is what was *rendered* — computed styles and painted rectangles — never stylesheet
 * text, because a design system is what a visitor sees and a stylesheet is only what somebody
 * wrote in the hope of it.
 *
 * Everything a page returns is untrusted. It is counted, clipped and stored as data here, and
 * where any of it later reaches a model it is labelled as such.
 */

// These functions execute in Chrome, not in Node, so the names below are the browser's.
/* global document, window, location, getComputedStyle, CSS, XMLSerializer, Image, requestAnimationFrame */

/**
 * Samples one rendered page: its colours by how much each paints, its type, spacing, shape,
 * components, logos and imagery.
 *
 * One walk of the tree, carrying the background each element sits on, so a translucent overlay is
 * recorded as the colour it produces rather than as the tint it was written as, and a child that
 * repeats its parent's background is not counted as painting anything.
 *
 * It also marks a few representative elements with `data-orbik-probe`, which is how the caller
 * finds them again — to ask Chrome which font actually drew them, to force a hover, and to cut
 * them out of a screenshot.
 *
 * @param {object} options
 * @param {string} options.excluded selectors of things that are not the site's own design:
 *   consent banners, chat widgets
 * @param {number} options.maxElements how many elements the walk may visit
 * @param {boolean} options.light true for the reduced sample taken at the mobile viewport
 * @returns {object} the page's sample
 */
export function samplePage({ excluded, maxElements, light }) {
  const doc = document;
  const root = doc.documentElement;
  const view = { width: window.innerWidth, height: window.innerHeight };
  const pageHeight = Math.max(root.scrollHeight, doc.body ? doc.body.scrollHeight : 0, view.height);
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  // ---------------------------------------------------------------------------------------------
  // Colours. Resolved by painting them: whatever syntax the site used — oklch(), color-mix(), a
  // named colour — one pixel on a canvas says what sRGB colour it is.
  const canvas = doc.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const resolved = new Map();

  /** A CSS colour as `{r, g, b, a}`, or null when it paints nothing. */
  function resolveColour(value) {
    if (!value || value === "transparent" || value === "none") return null;
    if (resolved.has(value)) return resolved.get(value);
    let colour = null;
    try {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "rgba(0, 0, 0, 0)";
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      if (a > 0) colour = { r, g, b, a: a / 255 };
    } catch {
      colour = null;
    }
    resolved.set(value, colour);
    return colour;
  }

  /** One colour laid over another, as the opaque colour that results. */
  function composite(top, under) {
    if (!top) return under;
    if (top.a >= 0.995 || !under) return { r: top.r, g: top.g, b: top.b, a: 1 };
    const mix = (above, below) => Math.round(above * top.a + below * (1 - top.a));
    return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 };
  }

  const hexOf = (colour) =>
    `#${[colour.r, colour.g, colour.b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

  const colours = new Map();

  /** Counts a colour toward a role: by painted area for surfaces, by text area for type. */
  function countColour(colour, role, weight, kind) {
    if (!colour || weight <= 0) return;
    const hex = hexOf(colour);
    let entry = colours.get(hex);
    if (!entry) {
      entry = { hex, area: 0, textArea: 0, roles: {} };
      colours.set(hex, entry);
    }
    if (kind === "text") entry.textArea += weight;
    else entry.area += weight;
    entry.roles[role] = (entry.roles[role] || 0) + weight;
  }

  // ---------------------------------------------------------------------------------------------
  // Small helpers.
  const px = (value) => {
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
  };
  const tally = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
  const top = (map, count) =>
    [...map.entries()].sort((left, right) => right[1] - left[1]).slice(0, count).map(([value, weight]) => ({ value, weight: Math.round(weight) }));
  const clean = (text, max) => String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
  const absolute = (url) => {
    if (!url) return null;
    try {
      return new URL(url, doc.baseURI).href;
    } catch {
      return null;
    }
  };

  /**
   * A box shadow as written, without the layers that draw nothing.
   *
   * Utility frameworks compose a shadow from several layers and leave the unused ones in as fully
   * transparent placeholders; reported whole, every shadow on such a site would look different
   * from every other and none would look like what is on the page.
   */
  function shadowOf(value) {
    if (!value || value === "none") return null;
    const layers = value
      .split(/,(?![^(]*\))/)
      .map((layer) => layer.trim())
      .filter((layer) => {
        const colour = layer.match(/(rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8})/i);
        return !colour || resolveColour(colour[0]) !== null;
      });
    return layers.length ? clean(layers.join(", "), 200) : null;
  }

  /** A font stack as its family names, quotes removed. */
  function familiesOf(stack) {
    return String(stack || "")
      .split(",")
      .map((name) => name.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }

  /** A rectangle in page coordinates, clipped to the page, with its visible area. */
  function boxOf(element) {
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left + scrollX);
    const right = Math.min(Math.max(view.width, root.scrollWidth), rect.right + scrollX);
    const topEdge = Math.max(0, rect.top + scrollY);
    const bottom = Math.min(pageHeight, rect.bottom + scrollY);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - topEdge);
    return { x: Math.round(left), y: Math.round(topEdge), width: Math.round(width), height: Math.round(height), area: width * height };
  }

  let probes = 0;
  const marked = [];

  /** Marks an element so the caller can find it again, and remembers where it is. */
  function mark(element, key, box) {
    if (!element || element.hasAttribute("data-orbik-probe")) return null;
    element.setAttribute("data-orbik-probe", key);
    probes += 1;
    marked.push({ key, box: box || boxOf(element) });
    return key;
  }

  // ---------------------------------------------------------------------------------------------
  // SVG, serialised so it still looks right outside the page it came from.
  /**
   * An inline SVG as standalone source.
   *
   * An icon on a page is often three lines that say `fill="currentColor"` and reference a sprite
   * elsewhere in the document: lifted out as written it would be an empty black square. So the
   * copy gets the colour it inherited, the fills and strokes its shapes were actually drawn with,
   * and the symbols it pointed at.
   */
  function serialiseSvg(svg, limit) {
    try {
      const rect = svg.getBoundingClientRect();
      const copy = svg.cloneNode(true);
      const shapes = svg.querySelectorAll("path,circle,rect,ellipse,line,polyline,polygon,text,g,use");
      const copies = copy.querySelectorAll("path,circle,rect,ellipse,line,polyline,polygon,text,g,use");
      if (shapes.length === copies.length && shapes.length <= 300) {
        shapes.forEach((shape, index) => {
          const style = getComputedStyle(shape);
          const target = copies[index];
          if (shape.tagName.toLowerCase() === "g" || shape.tagName.toLowerCase() === "use") return;
          for (const property of ["fill", "stroke"]) {
            const colour = style[property] === "none" ? null : resolveColour(style[property]);
            target.setAttribute(property, colour ? (colour.a < 0.995 ? `rgba(${colour.r},${colour.g},${colour.b},${Math.round(colour.a * 100) / 100})` : hexOf(colour)) : "none");
          }
          if (style.strokeWidth && style.stroke !== "none") target.setAttribute("stroke-width", String(px(style.strokeWidth)));
          target.removeAttribute("class");
          target.removeAttribute("style");
        });
      }
      // Symbols referenced from a sprite elsewhere in the document come along.
      const defs = doc.createElementNS("http://www.w3.org/2000/svg", "defs");
      const taken = new Set();
      copy.querySelectorAll("use").forEach((use) => {
        const href = use.getAttribute("href") || use.getAttribute("xlink:href") || "";
        if (!href.startsWith("#") || taken.has(href)) return;
        const target = doc.getElementById(href.slice(1));
        if (target && !copy.querySelector(`[id="${href.slice(1).replace(/"/g, "")}"]`)) {
          taken.add(href);
          defs.appendChild(target.cloneNode(true));
        }
      });
      if (defs.childNodes.length) copy.insertBefore(defs, copy.firstChild);

      const inherited = resolveColour(getComputedStyle(svg).color);
      copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      copy.removeAttribute("class");
      copy.removeAttribute("data-orbik-probe");
      copy.setAttribute("style", inherited ? `color:${hexOf(inherited)}` : "");
      if (!copy.getAttribute("viewBox") && rect.width && rect.height) {
        copy.setAttribute("viewBox", `0 0 ${Math.round(rect.width)} ${Math.round(rect.height)}`);
      }
      copy.setAttribute("width", String(Math.round(rect.width)));
      copy.setAttribute("height", String(Math.round(rect.height)));
      copy.querySelectorAll("script,foreignObject").forEach((node) => node.remove());
      const source = new XMLSerializer().serializeToString(copy);
      return source.length <= limit ? source : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // The document itself.
  const documentInfo = {
    title: clean(doc.title, 200),
    lang: root.getAttribute("lang") || null,
    themeColor: (doc.querySelector('meta[name="theme-color"]') || {}).content || null,
    ogImage: absolute((doc.querySelector('meta[property="og:image"]') || {}).content || ""),
    manifest: absolute((doc.querySelector('link[rel~="manifest"]') || {}).href || ""),
    icons: [...doc.querySelectorAll('link[rel~="icon"], link[rel~="apple-touch-icon"], link[rel~="mask-icon"]')]
      .slice(0, 12)
      .map((link) => ({ rel: link.rel, href: absolute(link.href), sizes: link.getAttribute("sizes") || null, type: link.type || null }))
      .filter((icon) => icon.href),
    organizationLogo: null,
  };
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    if (documentInfo.organizationLogo) break;
    try {
      const queue = [JSON.parse(script.textContent || "null")];
      for (let index = 0; index < queue.length && index < 200; index += 1) {
        const node = queue[index];
        if (!node || typeof node !== "object") continue;
        if (Array.isArray(node)) {
          queue.push(...node);
          continue;
        }
        const types = [].concat(node["@type"] || []);
        if (types.some((type) => /Organization|Corporation|LocalBusiness|Brand/.test(String(type))) && node.logo) {
          const logo = typeof node.logo === "string" ? node.logo : node.logo.url || node.logo.contentUrl;
          if (typeof logo === "string") {
            documentInfo.organizationLogo = absolute(logo);
            break;
          }
        }
        if (node["@graph"]) queue.push(node["@graph"]);
      }
    } catch {
      // Not JSON; nothing to read.
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Fonts: what loaded, and where it came from.
  const loadedFamilies = new Set();
  const declaredFamilies = new Set();
  const fontFaces = [];
  try {
    for (const face of doc.fonts) {
      const family = String(face.family).replace(/^["']|["']$/g, "");
      declaredFamilies.add(family);
      if (face.status !== "loaded") continue;
      loadedFamilies.add(family);
      fontFaces.push({ family, weight: String(face.weight), style: face.style });
    }
  } catch {
    // A page without the font loading API simply reports no web fonts.
  }

  const fontSources = [];
  const customProperties = new Map();
  let reducedMotion = null;
  let readableSheets = 0;
  for (const sheet of doc.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      // Another origin's stylesheet, served without permission to read it.
      continue;
    }
    readableSheets += 1;
    const visit = (list, depth) => {
      for (const rule of list) {
        if (rule.type === 5 && fontSources.length < 80) {
          const urls = [...String(rule.style.getPropertyValue("src")).matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((match) => match[1]);
          fontSources.push({
            family: String(rule.style.getPropertyValue("font-family")).replace(/^["']|["']$/g, ""),
            weight: rule.style.getPropertyValue("font-weight") || null,
            style: rule.style.getPropertyValue("font-style") || null,
            url: urls.length ? absolute(new URL(urls[0], sheet.href || doc.baseURI).href) : null,
          });
        } else if (rule.type === 1) {
          if (/^(:root|html|body|:root\s*,\s*:host|html\s*,\s*body)$/i.test(rule.selectorText.trim())) {
            for (const name of rule.style) {
              if (name.startsWith("--") && customProperties.size < 400) customProperties.set(name, rule.selectorText);
            }
          }
        } else if (rule.cssRules && depth < 3) {
          if (rule.type === 4 && /prefers-reduced-motion/.test(rule.conditionText || rule.media?.mediaText || "")) reducedMotion = true;
          visit(rule.cssRules, depth + 1);
        }
      }
    };
    try {
      visit(rules, 0);
    } catch {
      // A rule the engine could not expose; the rest of the sheets still count.
    }
  }
  if (reducedMotion === null && readableSheets > 0) reducedMotion = false;

  const rootStyle = getComputedStyle(root);
  const bodyStyle = doc.body ? getComputedStyle(doc.body) : rootStyle;
  const properties = [];
  for (const name of customProperties.keys()) {
    const value = clean(bodyStyle.getPropertyValue(name) || rootStyle.getPropertyValue(name), 160);
    if (!value) continue;
    let kind = "other";
    let hex = null;
    if (/^-?\d*\.?\d+(px|rem|em|%|vh|vw|ms|s)?$/.test(value)) kind = "length";
    else if (/font|family/i.test(name) && /[a-z]/i.test(value)) kind = "font";
    else if (CSS.supports("color", value)) {
      const colour = resolveColour(value);
      if (colour) {
        kind = "colour";
        hex = hexOf(composite(colour, { r: 255, g: 255, b: 255, a: 1 }));
      }
    }
    properties.push({ name, value, kind, hex });
  }
  // Tokens first, then whatever room is left: a site's own names for its colours are the most
  // useful thing a stylesheet can say about its design.
  const kindOrder = { colour: 0, font: 1, length: 2, other: 3 };
  properties.sort((left, right) => kindOrder[left.kind] - kindOrder[right.kind]);

  // ---------------------------------------------------------------------------------------------
  // The walk.
  const typography = new Map();
  const spacing = { containers: new Map(), sectionPadding: new Map(), gutters: new Map(), gaps: new Map(), margins: new Map(), paddings: new Map() };
  const shape = { radius: {}, borderWidths: new Map(), shadows: new Map() };
  const gradients = new Map();
  const transitions = { durations: new Map(), easings: new Map() };
  const buttons = new Map();
  const inputs = new Map();
  const cards = new Map();
  const images = new Map();
  const svgs = new Map();
  const logos = [];

  const FOREIGN = /logo|client|customer|partner|sponsor|badge|award|avatar|testimonial|review|trustpilot|clutch|g2/i;
  const FOREIGN_CONTAINERS = '[class*="client" i], [class*="customer" i], [class*="partner" i], [class*="trusted" i], [class*="marquee" i], [class*="testimonial" i], [class*="logos" i], [class*="brands" i]';
  const TEXT_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "label", "small", "blockquote", "figcaption", "dt", "dd", "td", "th"]);
  const SKIPPED = new Set(["script", "style", "noscript", "template", "iframe", "object", "embed", "head", "meta", "link", "title", "base", "br", "wbr", "canvas", "audio", "source", "track", "map", "area"]);

  const bodyBackground = composite(resolveColour(bodyStyle.backgroundColor), composite(resolveColour(rootStyle.backgroundColor), { r: 255, g: 255, b: 255, a: 1 }));
  countColour(bodyBackground, "page-bg", view.width * pageHeight, "area");

  /** Whether an element reads as a button, whatever it was built from. */
  function isButtonLike(element, tag, style, box, background, border) {
    if (tag === "button" || element.getAttribute("role") === "button") return true;
    if (tag === "input") return ["submit", "button", "reset"].includes(element.type);
    if (tag !== "a") return false;
    if (box.height < 24 || box.height > 84 || box.width < 48 || box.width > 480) return false;
    const padded = px(style.paddingLeft) >= 8 && px(style.paddingRight) >= 8;
    return padded && (Boolean(background) || border > 0);
  }

  let visited = 0;
  const stack = [{ element: doc.body, under: bodyBackground, region: null, inButton: false, inLink: false, heading: null, block: "text" }];
  while (stack.length && visited < maxElements) {
    const frame = stack.pop();
    const element = frame.element;
    if (!element || element.nodeType !== 1) continue;
    const tag = element.tagName.toLowerCase();
    if (SKIPPED.has(tag)) continue;
    if (excluded && element !== doc.body && element.matches(excluded)) continue;
    visited += 1;

    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number.parseFloat(style.opacity) === 0) continue;
    const box = boxOf(element);

    // Region: which part of the page this is. A header that is not at the top is a section's own
    // header, not the site's.
    let region = frame.region;
    if (!region) {
      if (tag === "footer" || element.getAttribute("role") === "contentinfo") region = "footer";
      else if (tag === "nav" || element.getAttribute("role") === "navigation") region = "nav";
      else if ((tag === "header" || element.getAttribute("role") === "banner") && box.y < 240) region = "nav";
    }

    // ---- inline SVG is one thing: an icon, an illustration or a logo. Its insides are not walked.
    if (tag === "svg") {
      if (box.width >= 12 && box.height >= 12) {
        const fill = resolveColour(style.fill === "none" ? style.color : style.fill) || resolveColour(style.color);
        countColour(composite(fill, frame.under), "icon", box.area, "area");
        if (!light && box.width >= 16 && box.height >= 16) {
          const source = serialiseSvg(element, 60000);
          if (source) {
            const signature = `${source.length}:${source.replace(/\s(width|height|style)="[^"]*"/g, "").slice(0, 4000)}`;
            const known = svgs.get(signature);
            if (known) known.count += 1;
            else if (svgs.size < 80) {
              svgs.set(signature, {
                source,
                width: box.width,
                height: box.height,
                y: box.y,
                count: 1,
                region,
                inLink: frame.inLink,
                inButton: frame.inButton,
                label: clean(element.getAttribute("aria-label") || (element.querySelector("title") || {}).textContent || "", 120),
                under: hexOf(frame.under),
                nodes: element.querySelectorAll("*").length,
                className: clean(typeof element.className === "object" ? element.className.baseVal : element.className, 160),
                homeLink: Boolean(element.closest('a[href="/"], a[href="./"]')) || Boolean(element.closest(`a[href="${location.origin}/"], a[href="${location.origin}"]`)),
              });
            }
          }
        }
      }
      continue;
    }

    const background = resolveColour(style.backgroundColor);
    const painted = background ? composite(background, frame.under) : null;
    const paintsNew = painted && hexOf(painted) !== hexOf(frame.under);
    const under = painted || frame.under;
    const borderTop = style.borderTopStyle !== "none" ? px(style.borderTopWidth) : 0;
    const borderWidth = Math.max(
      borderTop,
      style.borderBottomStyle !== "none" ? px(style.borderBottomWidth) : 0,
      style.borderLeftStyle !== "none" ? px(style.borderLeftWidth) : 0,
      style.borderRightStyle !== "none" ? px(style.borderRightWidth) : 0,
    );
    const fullWidth = box.width >= view.width * 0.9;
    const buttonLike = !frame.inButton && isButtonLike(element, tag, style, box, paintsNew ? background : null, borderWidth);
    const inButton = frame.inButton || buttonLike;
    const inLink = frame.inLink || tag === "a";

    if (box.area > 0) {
      // ---- surfaces
      if (paintsNew) {
        let role = "surface";
        if (buttonLike) role = "button-bg";
        else if (region === "footer" && box.width >= view.width * 0.5) role = "footer-bg";
        else if (region === "nav" && box.width >= view.width * 0.5) role = "nav-bg";
        else if (fullWidth && box.height >= 160) role = "section-bg";
        countColour(painted, role, box.area, "area");
      }

      // ---- borders, by the length of edge they draw
      if (borderWidth > 0) {
        for (const [side, length] of [["Top", box.width], ["Bottom", box.width], ["Left", box.height], ["Right", box.height]]) {
          const width = style[`border${side}Style`] === "none" ? 0 : px(style[`border${side}Width`]);
          if (width <= 0) continue;
          countColour(composite(resolveColour(style[`border${side}Color`]), under), "border", length * width, "area");
        }
        tally(shape.borderWidths, borderWidth);
      }

      // ---- gradients and background images
      const backgroundImage = style.backgroundImage;
      if (backgroundImage && backgroundImage !== "none") {
        if (backgroundImage.includes("gradient(") && box.area >= 1600) {
          const key = clean(backgroundImage, 300);
          const entry = gradients.get(key) || { css: key, area: 0, stops: [], role: buttonLike ? "button-bg" : fullWidth ? "section-bg" : "surface" };
          entry.area += box.area;
          if (!entry.stops.length) {
            const found = key.match(/(rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|lab\([^)]*\)|lch\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8})/gi) || [];
            entry.stops = found.slice(0, 6).map((stop) => resolveColour(stop)).filter(Boolean).map((stop) => hexOf(composite(stop, under)));
          }
          gradients.set(key, entry);
        }
        if (!light && box.width >= 24 && box.height >= 24) {
          for (const match of backgroundImage.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
            const source = absolute(match[1]);
            if (!source || source.startsWith("data:") && source.length < 400) continue;
            if (!images.has(source) && images.size < 120) {
              images.set(source, { src: source, type: "background", alt: "", width: box.width, height: box.height, naturalWidth: null, naturalHeight: null, y: box.y, region, inLink, inButton });
            }
          }
        }
      }

      // ---- shape
      const radius = style.borderTopLeftRadius;
      const kind = buttonLike ? "button" : tag === "input" || tag === "textarea" || tag === "select" ? "input" : tag === "img" || tag === "picture" || tag === "video" ? "image" : null;
      const boxShadow = shadowOf(style.boxShadow);

      // ---- spacing
      if (!light || fullWidth) {
        const maxWidth = style.maxWidth;
        if (maxWidth && maxWidth.endsWith("px") && box.width >= 480 && box.width < view.width) {
          const rect = element.getBoundingClientRect();
          if (Math.abs(rect.left - (view.width - rect.right)) <= 6) tally(spacing.containers, px(maxWidth));
        }
        if (fullWidth && box.height >= 160) {
          for (const value of [px(style.paddingTop), px(style.paddingBottom)]) if (value >= 8) tally(spacing.sectionPadding, value);
          for (const value of [px(style.paddingLeft), px(style.paddingRight)]) if (value >= 8) tally(spacing.gutters, value);
        }
        if (style.display.includes("flex") || style.display.includes("grid")) {
          for (const value of [px(style.rowGap), px(style.columnGap)]) if (value > 0) tally(spacing.gaps, value);
        }
      }

      // ---- components
      if (!light && buttonLike && box.width >= 40 && box.height >= 20) {
        const label = clean(element.innerText || element.value || element.getAttribute("aria-label") || "", 40);
        const colour = composite(resolveColour(style.color), under);
        const variant = paintsNew ? "filled" : borderWidth > 0 ? "outlined" : "text";
        const recipe = {
          variant,
          background: paintsNew ? hexOf(painted) : null,
          gradient: backgroundImage && backgroundImage.includes("gradient(") ? clean(backgroundImage, 200) : null,
          color: colour ? hexOf(colour) : null,
          borderColor: borderWidth > 0 ? hexOf(composite(resolveColour(style.borderTopColor), under)) : null,
          borderWidth,
          radius: px(radius),
          paddingY: px(style.paddingTop),
          paddingX: px(style.paddingLeft),
          fontFamily: familiesOf(style.fontFamily)[0] || null,
          fontSize: px(style.fontSize),
          fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
          textTransform: style.textTransform === "none" ? null : style.textTransform,
          letterSpacing: style.letterSpacing === "normal" ? 0 : px(style.letterSpacing),
          shadow: boxShadow,
          height: box.height,
        };
        const key = [recipe.variant, recipe.background, recipe.gradient, recipe.color, recipe.borderColor, recipe.radius, recipe.fontSize, recipe.fontWeight, recipe.paddingX].join("|");
        const entry = buttons.get(key) || { ...recipe, count: 0, labels: [], region, probe: null, element: null, box };
        entry.count += 1;
        if (label && entry.labels.length < 3 && !entry.labels.includes(label)) entry.labels.push(label);
        // The instance that is cut out of the screenshot: one with a label, and not one hidden
        // inside a collapsed menu.
        if (!entry.element && label && box.width > 0) {
          entry.element = element;
          entry.box = box;
        }
        buttons.set(key, entry);
        tally(shape.radius.button || (shape.radius.button = new Map()), px(radius));
      } else if (!light && (tag === "input" || tag === "textarea" || tag === "select") && !["hidden", "checkbox", "radio", "file", "range", "color", "submit", "button", "reset", "image"].includes(element.type)) {
        if (box.width >= 80 && box.height >= 24) {
          const recipe = {
            background: hexOf(under),
            color: (() => { const colour = composite(resolveColour(style.color), under); return colour ? hexOf(colour) : null; })(),
            borderColor: borderWidth > 0 ? hexOf(composite(resolveColour(style.borderTopColor), frame.under)) : null,
            borderWidth,
            radius: px(radius),
            paddingY: px(style.paddingTop),
            paddingX: px(style.paddingLeft),
            fontSize: px(style.fontSize),
            height: box.height,
            shadow: boxShadow,
          };
          const key = Object.values(recipe).join("|");
          const entry = inputs.get(key) || { ...recipe, count: 0, element, box };
          entry.count += 1;
          inputs.set(key, entry);
          tally(shape.radius.input || (shape.radius.input = new Map()), px(radius));
        }
      } else if (!buttonLike && !inButton) {
        if (kind === "image") tally(shape.radius.image || (shape.radius.image = new Map()), radius.endsWith("%") ? radius : px(radius));
        const padding = Math.min(px(style.paddingTop), px(style.paddingLeft));
        const boxed = borderWidth > 0 || boxShadow || paintsNew;
        if (!light && boxed && padding >= 12 && element.childElementCount >= 2 && !region && box.width >= 180 && box.width <= view.width * 0.7 && box.height >= 100 && box.height <= 900) {
          const recipe = {
            background: hexOf(under),
            borderColor: borderWidth > 0 ? hexOf(composite(resolveColour(style.borderTopColor), frame.under)) : null,
            borderWidth,
            radius: px(radius),
            shadow: boxShadow,
            padding,
          };
          const key = Object.values(recipe).join("|");
          const entry = cards.get(key) || { ...recipe, count: 0, element, box };
          entry.count += 1;
          cards.set(key, entry);
          tally(shape.radius.card || (shape.radius.card = new Map()), px(radius));
          tally(spacing.paddings, padding);
        }
      }
      if (boxShadow && !light) {
        const entry = shape.shadows.get(boxShadow) || { css: boxShadow, count: 0, on: buttonLike ? "button" : kind || "box" };
        entry.count += 1;
        shape.shadows.set(boxShadow, entry);
      }
      if (!light && (buttonLike || tag === "a") && style.transitionDuration && style.transitionDuration !== "0s") {
        tally(transitions.durations, style.transitionDuration.split(",")[0].trim());
        tally(transitions.easings, clean(style.transitionTimingFunction.split(/,(?![^(]*\))/)[0], 60));
      }

      // ---- images
      if (!light && tag === "img" && box.width >= 24 && box.height >= 24) {
        const source = absolute(element.currentSrc || element.src || "");
        if (source && !images.has(source) && images.size < 120) {
          images.set(source, {
            src: source,
            type: "img",
            alt: clean(element.alt, 200),
            width: box.width,
            height: box.height,
            naturalWidth: element.naturalWidth || null,
            naturalHeight: element.naturalHeight || null,
            y: box.y,
            region,
            inLink,
            inButton,
            className: clean(element.className, 160),
            radius: radius.endsWith("%") ? radius : px(radius),
            homeLink: Boolean(element.closest('a[href="/"], a[href="./"]')) || Boolean(element.closest(`a[href="${location.origin}/"], a[href="${location.origin}"]`)),
            under: hexOf(under),
            // Another company's mark, or a person's face: on the page, and not this brand's imagery.
            foreign: FOREIGN.test(`${element.alt} ${source} ${element.className}`) || Boolean(element.closest(FOREIGN_CONTAINERS)),
          });
        }
      } else if (!light && tag === "video" && element.poster && box.width >= 120) {
        const source = absolute(element.poster);
        if (source && !images.has(source)) images.set(source, { src: source, type: "poster", alt: "", width: box.width, height: box.height, naturalWidth: null, naturalHeight: null, y: box.y, region, inLink, inButton });
      }
    }

    // ---- text: this element's own words, weighted by how much of them there is
    let block = frame.block;
    let heading = frame.heading;
    if (/^h[1-6]$/.test(tag)) heading = tag;
    if (TEXT_TAGS.has(tag)) block = tag;
    let own = 0;
    let sample = "";
    for (const node of element.childNodes) {
      if (node.nodeType !== 3) continue;
      const text = node.nodeValue.replace(/\s+/g, " ").trim();
      if (!text) continue;
      own += text.length;
      if (!sample) sample = text;
    }
    if (tag === "input" || tag === "textarea") {
      const text = clean(element.value || element.placeholder, 60);
      own += text.length;
      sample = sample || text;
    }
    if (own > 0 && box.area > 0) {
      const size = px(style.fontSize);
      const colour = composite(resolveColour(style.color), under);
      const role = inButton ? "button-fg" : heading ? "heading" : inLink ? "link" : region === "footer" ? "footer-text" : region === "nav" ? "nav-text" : "text";
      countColour(colour, role, own * size, "text");

      const category = inButton ? "button" : heading || (region === "nav" && inLink ? "nav-link" : inLink ? "a" : tag === "input" || tag === "textarea" ? "input" : block);
      const lineHeight = style.lineHeight === "normal" ? null : Math.round((px(style.lineHeight) / (size || 1)) * 100) / 100;
      const signature = {
        family: familiesOf(style.fontFamily)[0] || null,
        stack: familiesOf(style.fontFamily).slice(0, 6),
        size,
        weight: Number.parseInt(style.fontWeight, 10) || 400,
        lineHeight,
        letterSpacing: style.letterSpacing === "normal" ? 0 : Math.round((px(style.letterSpacing) / (size || 1)) * 1000) / 1000,
        textTransform: style.textTransform === "none" ? null : style.textTransform,
        italic: style.fontStyle === "italic",
        color: colour ? hexOf(colour) : null,
      };
      const key = `${category}|${signature.family}|${signature.size}|${signature.weight}|${signature.lineHeight}|${signature.letterSpacing}|${signature.textTransform}|${signature.color}`;
      const entry = typography.get(key) || { category, ...signature, count: 0, characters: 0, sample: clean(sample, 60), marginTop: null, marginBottom: null, element: null };
      entry.count += 1;
      entry.characters += own;
      if (entry.marginTop === null && (heading || tag === "p")) {
        entry.marginTop = px(style.marginTop);
        entry.marginBottom = px(style.marginBottom);
      }
      if (!entry.element && box.y < pageHeight) entry.element = element;
      typography.set(key, entry);
      if (heading || tag === "p") {
        for (const value of [px(style.marginTop), px(style.marginBottom)]) if (value > 0) tally(spacing.margins, value);
      }
    }

    // Children in reverse, so the stack pops them in document order.
    const children = element.children;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ element: children[index], under, region, inButton, inLink, heading, block });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Typography, reduced: the few styles each kind of text is actually set in.
  const byCategory = new Map();
  for (const entry of typography.values()) {
    if (!byCategory.has(entry.category)) byCategory.set(entry.category, []);
    byCategory.get(entry.category).push(entry);
  }
  const type = [];
  for (const [category, entries] of byCategory) {
    entries.sort((left, right) => right.characters - left.characters);
    entries.slice(0, light ? 2 : 4).forEach((entry, index) => {
      // The commonest style of each kind is the one Chrome is asked about afterwards.
      const probe = !light && index === 0 && probes < 40 ? mark(entry.element, `type-${category}`) : null;
      const rest = { ...entry, probe };
      delete rest.element;
      type.push(rest);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Components, reduced, with the instances worth cutting out of a screenshot marked.
  const listed = (map, count, prefix) =>
    [...map.values()]
      .sort((left, right) => right.count - left.count)
      .slice(0, count)
      .map((entry, index) => {
        const { element, box, ...rest } = entry;
        const probe = element ? mark(element, `${prefix}-${index}`, box) : null;
        return { ...rest, probe };
      });

  const components = { buttons: [], inputs: [], cards: [], nav: null, footer: null, hero: null };
  if (!light) {
    components.buttons = listed(buttons, 6, "button");
    components.inputs = listed(inputs, 2, "input");
    components.cards = listed(cards, 3, "card");
  }

  const navigation = [...doc.querySelectorAll('header, nav, [role="banner"]')].find((element) => {
    const box = boxOf(element);
    return box.y < 240 && box.width >= view.width * 0.7 && box.height >= 32 && box.height <= 320 && getComputedStyle(element).display !== "none";
  });
  if (navigation) {
    const outer = getComputedStyle(navigation);
    const box = boxOf(navigation);
    // The bar a visitor sees is often not the `header` element but a box inside it: a floating,
    // rounded bar in a transparent wrapper. The widest painted box in there is the bar.
    let bar = navigation;
    if (!resolveColour(outer.backgroundColor)) {
      for (const element of navigation.querySelectorAll("div, nav, section")) {
        const inner = element.getBoundingClientRect();
        if (inner.width < box.width * 0.6 || inner.height < 32 || inner.height > 200) continue;
        if (resolveColour(getComputedStyle(element).backgroundColor)) {
          bar = element;
          break;
        }
      }
    }
    const style = getComputedStyle(bar);
    const barBox = boxOf(bar);
    const background = composite(resolveColour(style.backgroundColor), bodyBackground);
    const links = [...navigation.querySelectorAll("a")].filter((link) => link.getBoundingClientRect().width > 0);
    const mark0 = navigation.querySelector('a[href="/"], img, svg');
    const markBox = mark0 ? mark0.getBoundingClientRect() : null;
    components.nav = {
      height: barBox.height,
      background: hexOf(background),
      transparent: !resolveColour(style.backgroundColor),
      floating: bar !== navigation && barBox.width < view.width - 16,
      radius: px(style.borderTopLeftRadius),
      border: px(style.borderTopWidth) > 0 ? hexOf(composite(resolveColour(style.borderTopColor), background)) : null,
      position: outer.position,
      backdropBlur: style.backdropFilter && style.backdropFilter !== "none" ? clean(style.backdropFilter, 60) : null,
      borderBottom: px(style.borderBottomWidth) > 0 ? hexOf(composite(resolveColour(style.borderBottomColor), background)) : null,
      shadow: shadowOf(style.boxShadow),
      links: links.length,
      logoPosition: markBox ? (markBox.left + markBox.width / 2 < view.width * 0.35 ? "left" : markBox.left + markBox.width / 2 > view.width * 0.65 ? "right" : "center") : null,
      probe: light ? null : mark(navigation, "nav", box),
    };
  }

  if (!light) {
    const footers = [...doc.querySelectorAll('footer, [role="contentinfo"]')].filter((element) => boxOf(element).height >= 60);
    const footer = footers[footers.length - 1];
    if (footer) {
      const style = getComputedStyle(footer);
      const box = boxOf(footer);
      let widest = 0;
      for (const element of footer.querySelectorAll("*")) {
        const display = getComputedStyle(element).display;
        if (!display.includes("flex") && !display.includes("grid")) continue;
        const columns = [...element.children].filter((child) => child.getBoundingClientRect().width >= 80);
        const tops = new Set(columns.map((child) => Math.round(child.getBoundingClientRect().top / 8)));
        if (tops.size === 1 && columns.length > widest) widest = columns.length;
      }
      components.footer = {
        height: box.height,
        background: hexOf(composite(resolveColour(style.backgroundColor), bodyBackground)),
        color: (() => { const colour = resolveColour(style.color); return colour ? hexOf(colour) : null; })(),
        columns: widest || null,
        borderTop: px(style.borderTopWidth) > 0 ? hexOf(composite(resolveColour(style.borderTopColor), bodyBackground)) : null,
        probe: mark(footer, "footer", { ...box, height: Math.min(box.height, 720) }),
      };
    }

    const title = doc.querySelector("main h1, h1");
    if (title) {
      let band = title;
      for (let node = title.parentElement; node && node !== doc.body; node = node.parentElement) {
        const box = boxOf(node);
        if (box.height > view.height * 1.6) break;
        band = node;
        if (box.width >= view.width * 0.9 && box.height >= 280) break;
      }
      const box = boxOf(band);
      const style = getComputedStyle(band);
      const titleStyle = getComputedStyle(title);
      components.hero = {
        height: box.height,
        background: hexOf(composite(resolveColour(style.backgroundColor), bodyBackground)),
        gradient: style.backgroundImage.includes("gradient(") ? clean(style.backgroundImage, 240) : null,
        backgroundImage: /url\(/.test(style.backgroundImage),
        headingSize: px(titleStyle.fontSize),
        headingWeight: Number.parseInt(titleStyle.fontWeight, 10) || 400,
        align: titleStyle.textAlign,
        media: band.querySelector("video") ? "video" : band.querySelector("canvas") ? "canvas" : band.querySelector("img, picture") ? "image" : band.querySelector("svg") && [...band.querySelectorAll("svg")].some((svg) => svg.getBoundingClientRect().width >= 160) ? "illustration" : "none",
        buttons: band.querySelectorAll('button, a[class*="btn" i], a[class*="button" i], [role="button"]').length,
        probe: mark(band, "hero", { ...box, height: Math.min(box.height, 900) }),
      };
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Logos: what the site itself presents as its mark.
  if (!light) {
    const seen = new Set();
    const consider = (element, reason, score) => {
      if (!element || seen.has(element) || logos.length >= 10) return;
      const tag = element.tagName.toLowerCase();
      const box = boxOf(element);
      if (box.width < 16 || box.height < 12 || box.width > 640 || box.height > 320) return;
      seen.add(element);
      let under = bodyBackground;
      for (let node = element.parentElement; node; node = node.parentElement) {
        const colour = resolveColour(getComputedStyle(node).backgroundColor);
        if (colour && colour.a > 0.5) {
          under = composite(colour, bodyBackground);
          break;
        }
      }
      const entry = { reason, score, width: box.width, height: box.height, y: box.y, under: hexOf(under), alt: "", src: null, source: null, text: null, probe: null };
      if (tag === "img") {
        entry.src = absolute(element.currentSrc || element.src || "");
        entry.alt = clean(element.alt, 160);
        if (!entry.src) return;
      } else if (tag === "svg") {
        entry.source = serialiseSvg(element, 80000);
        entry.alt = clean(element.getAttribute("aria-label") || (element.querySelector("title") || {}).textContent || "", 160);
        if (!entry.source) return;
      } else {
        // A wordmark set in type rather than drawn: there is no file to fetch, so the caller cuts
        // it out of the page, and the recipe says how it is set.
        const style = getComputedStyle(element);
        const colour = resolveColour(style.color);
        entry.text = clean(element.innerText, 60);
        entry.type = {
          family: familiesOf(style.fontFamily)[0] || null,
          size: px(style.fontSize),
          weight: Number.parseInt(style.fontWeight, 10) || 400,
          letterSpacing: style.letterSpacing === "normal" ? 0 : px(style.letterSpacing),
          color: colour ? hexOf(composite(colour, under)) : null,
        };
        entry.probe = mark(element, `logo-${logos.length}`, { x: Math.max(0, box.x - 6), y: Math.max(0, box.y - 6), width: box.width + 12 + 24, height: box.height + 12 });
        if (!entry.text || !entry.probe) return;
      }
      logos.push(entry);
    };
    const home = `a[href="/"], a[href="./"], a[href="${location.origin}/"], a[href="${location.origin}"]`;
    for (const link of doc.querySelectorAll(home)) {
      const inHeader = Boolean(link.closest("header, nav, [role=banner]"));
      const drawn = link.querySelectorAll("img, svg");
      for (const element of drawn) consider(element, inHeader ? "header-home-link" : "home-link", inHeader ? 5 : 3);
      const words = clean(link.innerText, 80);
      if (!drawn.length && inHeader && words.length >= 2 && words.length <= 40 && link.getBoundingClientRect().width > 0) {
        consider(link, "header-home-text", 5);
      }
    }
    // An element that calls itself a logo counts only where a site puts its own: the header and
    // the footer. Anywhere else it is far more often a wall of customers' or partners' marks.
    for (const element of doc.querySelectorAll('[class*="logo" i] img, [class*="logo" i] svg, img[class*="logo" i], svg[class*="logo" i], [id*="logo" i] img, [id*="logo" i] svg, img[alt*="logo" i]')) {
      const where = element.closest("header, nav, [role=banner], footer, [role=contentinfo]");
      if (!where || element.closest(FOREIGN_CONTAINERS)) continue;
      consider(element, "named-logo", where.matches("footer, [role=contentinfo]") ? 3 : 4);
    }
    if (!logos.length) {
      const first = doc.querySelector("header img, header svg, [role=banner] img, [role=banner] svg");
      if (first && boxOf(first).y < 200) consider(first, "first-in-header", 2);
    }
  }

  // ---------------------------------------------------------------------------------------------
  const freeze = (map, count) => top(map, count);
  const colourList = [...colours.values()]
    .sort((left, right) => right.area + right.textArea * 40 - (left.area + left.textArea * 40))
    .slice(0, 80)
    .map((entry) => ({
      hex: entry.hex,
      area: Math.round(entry.area),
      textArea: Math.round(entry.textArea),
      roles: Object.fromEntries(Object.entries(entry.roles).map(([role, weight]) => [role, Math.round(weight)])),
    }));

  return {
    url: location.href,
    view,
    pageHeight,
    visited,
    truncated: stack.length > 0,
    document: documentInfo,
    customProperties: properties.slice(0, 160),
    fonts: {
      loaded: fontFaces.slice(0, 60),
      declared: [...declaredFamilies].slice(0, 40),
      sources: fontSources,
      links: [...doc.querySelectorAll('link[rel~="stylesheet"][href*="fonts.googleapis.com"], link[rel~="stylesheet"][href*="use.typekit.net"], link[rel~="stylesheet"][href*="fonts.bunny.net"]')].map((link) => link.href).slice(0, 8),
      body: familiesOf(bodyStyle.fontFamily).slice(0, 8),
    },
    colours: colourList,
    gradients: [...gradients.values()].sort((left, right) => right.area - left.area).slice(0, 8).map((entry) => ({ ...entry, area: Math.round(entry.area) })),
    typography: type,
    spacing: {
      containers: freeze(spacing.containers, 6),
      sectionPadding: freeze(spacing.sectionPadding, 10),
      gutters: freeze(spacing.gutters, 8),
      gaps: freeze(spacing.gaps, 14),
      margins: freeze(spacing.margins, 14),
      paddings: freeze(spacing.paddings, 10),
    },
    shape: {
      radius: Object.fromEntries(Object.entries(shape.radius).map(([kind, map]) => [kind, freeze(map, 6)])),
      borderWidths: freeze(shape.borderWidths, 5),
      shadows: [...shape.shadows.values()].sort((left, right) => right.count - left.count).slice(0, 8),
    },
    components,
    motion: { durations: freeze(transitions.durations, 5), easings: freeze(transitions.easings, 4), reducedMotion },
    logos,
    images: [...images.values()],
    svgs: [...svgs.values()],
    probes: marked,
  };
}

/**
 * Scrolls the page to its foot and back, so content that waits to be seen has been seen.
 *
 * Lazy images, and sections that animate in as they enter the viewport, are otherwise blank in a
 * full-page screenshot and missing from the sample. The walk is capped: a page that grows as it
 * is scrolled must not be followed for ever.
 *
 * @param {object} options
 * @param {number} options.maxHeight how far down to go, in pixels
 * @param {number} options.pauseMs how long to rest at each step
 */
export async function scrollThrough({ maxHeight, pauseMs }) {
  const step = Math.max(400, Math.round(window.innerHeight * 0.8));
  const rest = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let y = 0; y < Math.min(document.documentElement.scrollHeight, maxHeight); y += step) {
    window.scrollTo(0, y);
    await rest(pauseMs);
  }
  window.scrollTo(0, 0);
  await rest(pauseMs * 2);
}

/**
 * Reads the computed look of one marked element, for comparing it at rest and under hover.
 *
 * Colours come back as `#rrggbb`, resolved by painting them as the sampler does, so the two
 * readings can be compared without parsing whatever syntax the site wrote them in.
 *
 * @param {string} key the element's `data-orbik-probe` value
 * @returns {object|null}
 */
export function readProbeStyle(key) {
  const element = document.querySelector(`[data-orbik-probe="${key}"]`);
  if (!element) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const hex = (value) => {
    try {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "rgba(0, 0, 0, 0)";
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      if (a === 0) return null;
      // Laid over white: a translucent hover tint is reported as roughly the colour it makes.
      const over = (channel) => Math.round(channel * (a / 255) + 255 * (1 - a / 255));
      return `#${[over(r), over(g), over(b)].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
    } catch {
      return null;
    }
  };
  const style = getComputedStyle(element);
  return {
    background: hex(style.backgroundColor),
    gradient: style.backgroundImage === "none" ? null : style.backgroundImage.slice(0, 200),
    color: hex(style.color),
    borderColor: Number.parseFloat(style.borderTopWidth) > 0 ? hex(style.borderTopColor) : null,
    shadow: style.boxShadow === "none" ? null : style.boxShadow.slice(0, 200),
    transform: style.transform === "none" ? null : style.transform.slice(0, 80),
    opacity: Number.parseFloat(style.opacity),
    underline: style.textDecorationLine.includes("underline"),
  };
}

/**
 * Turns one image into a bounded WebP, and says what colours it is made of.
 *
 * Runs on a blank page of Orbik's own, on bytes the worker already holds, so the canvas is never
 * tainted by the site the image came from. Chrome does the decoding and resizing: every format a
 * browser can show, with no image library in the worker.
 *
 * The colour count is what tells a photograph from an illustration — a flat vector has a handful
 * of colours however large it is drawn, and a photograph has thousands.
 *
 * @param {object} options
 * @param {string} options.dataUrl the image as a `data:` URL
 * @param {number} options.maxEdge the longest edge to keep, in pixels
 * @param {number} options.quality WebP quality, 0–1
 * @param {"webp"|"png"} [options.format] PNG for a logo, where an edge has to stay an edge
 * @param {boolean} options.keep true to measure only and return no bytes
 * @returns {Promise<object>} `{ok, width, height, data, dominantColors, colorCount, transparent}`
 */
export async function rasterise({ dataUrl, maxEdge, quality, format, keep }) {
  const image = new Image();
  image.decoding = "sync";
  image.src = dataUrl;
  try {
    await image.decode();
  } catch {
    return { ok: false };
  }
  const naturalWidth = image.naturalWidth || 300;
  const naturalHeight = image.naturalHeight || 150;
  const scale = Math.min(1, maxEdge / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(image, 0, 0, width, height);

  // A small copy is enough to judge colour by, and is the same size whatever the image was.
  const probe = document.createElement("canvas");
  probe.width = 48;
  probe.height = 48;
  const probeContext = probe.getContext("2d", { willReadFrequently: true });
  probeContext.drawImage(image, 0, 0, 48, 48);
  const pixels = probeContext.getImageData(0, 0, 48, 48).data;
  const buckets = new Map();
  let clear = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] < 128) {
      clear += 1;
      continue;
    }
    // Sixteen levels a channel: fine enough to tell colours apart, coarse enough that the noise
    // of compression does not look like variety.
    const key = ((pixels[index] >> 4) << 8) | ((pixels[index + 1] >> 4) << 4) | (pixels[index + 2] >> 4);
    const bucket = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += pixels[index];
    bucket.g += pixels[index + 1];
    bucket.b += pixels[index + 2];
    buckets.set(key, bucket);
  }
  const ranked = [...buckets.values()].sort((left, right) => right.count - left.count);
  const opaque = 48 * 48 - clear;
  const hex = (bucket) =>
    `#${[bucket.r, bucket.g, bucket.b].map((sum) => Math.round(sum / bucket.count).toString(16).padStart(2, "0")).join("")}`;

  return {
    ok: true,
    naturalWidth,
    naturalHeight,
    width,
    height,
    data: keep ? null : canvas.toDataURL(format === "png" ? "image/png" : "image/webp", quality).split(",")[1],
    dominantColors: ranked.slice(0, 5).filter((bucket) => bucket.count >= Math.max(4, opaque * 0.03)).map(hex),
    // Buckets that hold more than a stray pixel, which is what "how many colours" means to an eye.
    colorCount: ranked.filter((bucket) => bucket.count >= 3).length,
    transparent: clear / (48 * 48),
  };
}

/**
 * Lays out one of Orbik's own sheets over the page and says where it is, so it can be
 * photographed: the type specimen, the swatches, or the contact sheet.
 *
 * The specimen and the swatches are drawn *on the site itself*, which is the whole trick: the
 * page has the site's fonts loaded, so type set here is set in the real typeface without Orbik
 * ever storing a font file it has no licence to keep. The picture carries the look; the family
 * names in the record say what it is.
 *
 * Every element is a custom tag with its styles reset, so nothing in the site's stylesheet —
 * a rule for every `div`, a global `line-height` — reaches into the sheet.
 *
 * @param {object} sheet
 * @param {string} sheet.title what the sheet is
 * @param {string} [sheet.subtitle] one line under the title
 * @param {number} [sheet.width] the sheet's width in pixels
 * @param {Array<object>} sheet.blocks `family`, `type`, `swatches` or `images` blocks
 * @returns {Promise<{x: number, y: number, width: number, height: number}>} where the sheet is
 */
export async function renderSheet({ title, subtitle, width = 1200, blocks }) {
  const LABEL = 'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
  const make = (css, text) => {
    const element = document.createElement("orbik-sheet-part");
    element.style.cssText = `all:initial;display:block;box-sizing:border-box;font-family:${LABEL};color:#111827;${css}`;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  document.querySelector("orbik-sheet")?.remove();
  const sheet = document.createElement("orbik-sheet");
  sheet.style.cssText = `all:initial;display:block;box-sizing:border-box;position:absolute;left:0;top:0;z-index:2147483647;width:${width}px;padding:40px;background:#ffffff;`;
  sheet.appendChild(make("font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;", title));
  if (subtitle) sheet.appendChild(make("font-size:13px;color:#9ca3af;margin-top:4px;", subtitle));

  const pending = [];
  for (const block of blocks) {
    if (block.type === "family") {
      const row = make("margin-top:32px;padding-top:24px;border-top:1px solid #e5e7eb;");
      row.appendChild(make("font-size:12px;color:#6b7280;", block.label));
      row.appendChild(make(`font-family:${block.css};font-size:64px;line-height:1.1;margin-top:8px;font-weight:${block.nameWeight ?? 400};`, block.name));
      row.appendChild(make(`font-family:${block.css};font-size:22px;line-height:1.5;margin-top:12px;color:#374151;`, "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 &?!@%"));
      const weights = make("display:flex;flex-wrap:wrap;gap:28px;margin-top:14px;");
      for (const weight of block.weights) weights.appendChild(make(`font-family:${block.css};font-weight:${weight};font-size:20px;`, `${weight} Aa Bb Cc`));
      row.appendChild(weights);
      sheet.appendChild(row);
    } else if (block.type === "type") {
      const row = make("display:flex;gap:32px;align-items:baseline;margin-top:22px;padding-top:18px;border-top:1px solid #f3f4f6;");
      row.appendChild(make("flex:0 0 240px;font-size:12px;line-height:1.5;color:#6b7280;", block.label));
      const text = make(
        `flex:1 1 auto;font-family:${block.css};font-size:${block.size}px;font-weight:${block.weight};line-height:${block.lineHeight ?? 1.3};` +
        `letter-spacing:${block.letterSpacing ?? 0}em;text-transform:${block.textTransform ?? "none"};color:${block.color ?? "#111827"};`,
        block.sample,
      );
      row.appendChild(text);
      sheet.appendChild(row);
    } else if (block.type === "swatches") {
      const grid = make("display:grid;grid-template-columns:repeat(6, 1fr);gap:16px;margin-top:28px;");
      for (const swatch of block.swatches) {
        const cell = make("");
        cell.appendChild(make(`height:88px;border-radius:10px;background:${swatch.hex};border:1px solid rgba(17,24,39,0.12);`));
        cell.appendChild(make("font-size:13px;font-weight:600;margin-top:8px;font-family:ui-monospace, SFMono-Regular, Menlo, monospace;", swatch.hex));
        cell.appendChild(make("font-size:11px;line-height:1.45;color:#6b7280;margin-top:2px;", swatch.note));
        grid.appendChild(cell);
      }
      sheet.appendChild(grid);
    } else if (block.type === "images") {
      const grid = make(`display:grid;grid-template-columns:repeat(${block.columns ?? 4}, 1fr);gap:16px;margin-top:28px;`);
      for (const cell of block.cells) {
        const holder = make("");
        const frame = make(`height:${block.cellHeight ?? 200}px;border-radius:8px;background:${cell.background ?? "#f3f4f6"};border:1px solid #e5e7eb;display:flex;align-items:center;justify-content:center;overflow:hidden;`);
        const image = document.createElement("img");
        image.style.cssText = "all:initial;display:block;max-width:92%;max-height:92%;object-fit:contain;";
        image.src = cell.src;
        pending.push(image.decode().catch(() => {}));
        frame.appendChild(image);
        holder.appendChild(frame);
        holder.appendChild(make("font-size:12px;line-height:1.4;color:#374151;margin-top:6px;", cell.caption));
        grid.appendChild(holder);
      }
      sheet.appendChild(grid);
    }
  }

  document.documentElement.appendChild(sheet);
  window.scrollTo(0, 0);
  await Promise.all(pending);
  await document.fonts?.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const rect = sheet.getBoundingClientRect();
  return { x: 0, y: 0, width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
}

/** How far the document has loaded: `loading`, `interactive` or `complete`. */
export function readyState() {
  return document.readyState;
}

/** Resolves when every web font the page asked for has loaded or failed. */
export async function fontsReady() {
  await document.fonts?.ready;
}

/** How many characters of text the page shows, which is what tells a page from a challenge screen. */
export function visibleTextLength() {
  return (document.body?.innerText ?? "").trim().length;
}

/** Takes down a sheet {@link renderSheet} put up. */
export function removeSheet() {
  document.querySelector("orbik-sheet")?.remove();
}
