import { looksLikeSvg, sanitiseSvg } from "@orbik/assets";
import { BRAND_ASSET_KINDS, BRAND_UPLOAD_LIMITS } from "@orbik/core";
import * as fontkit from "fontkit";
import { extractText, getDocumentProxy } from "unpdf";

import { AppError } from "../errors/appError.js";

/**
 * Working out what a file a person dropped on the Brand page is, from its bytes.
 *
 * The name and the type the browser declared are hints and nothing more: a file called logo.svg
 * may be anything, and what is stored is served back with the type recorded here. So every file is
 * recognised by its first bytes, and what can be read from it is read now — an image's size, a
 * font's family and weight, a guide's pages and text — once, at upload, rather than by every
 * reader later. A file that is none of the kinds the brand holds is refused with what it can take.
 */

/** Where on the Brand page a file was dropped, which decides what an image is taken to be. */
export const UPLOAD_HINTS = Object.freeze(["logos", "colours", "type", "images", "chat"]);

/** What an image is called on the page and in a refusal. */
const IMAGE_TYPES = Object.freeze({
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
  "image/gif": "GIF",
  "image/svg+xml": "SVG",
});

/** What a refusal says the brand can take. */
const ACCEPTED =
  "Logos and images (SVG, PNG, JPEG, WebP, GIF), brand guidelines (PDF), fonts (WOFF2, WOFF, OTF, TTF) and design tokens (JSON, CSS).";

function refuse(code, message) {
  return new AppError({ status: 400, code, message });
}

/** Whether the bytes start with the given ASCII signature at an offset. */
function startsWith(bytes, signature, offset = 0) {
  return bytes.length >= offset + signature.length && bytes.subarray(offset, offset + signature.length).toString("latin1") === signature;
}

/** What kind of file the bytes are, by their signature; null when nothing here recognises them. */
function sniff(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && startsWith(bytes, "PNG", 1)) return { family: "image", mimeType: "image/png" };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { family: "image", mimeType: "image/jpeg" };
  if (startsWith(bytes, "RIFF") && startsWith(bytes, "WEBP", 8)) return { family: "image", mimeType: "image/webp" };
  if (startsWith(bytes, "GIF87a") || startsWith(bytes, "GIF89a")) return { family: "image", mimeType: "image/gif" };
  if (startsWith(bytes, "%PDF-")) return { family: "guide", mimeType: "application/pdf" };
  if (startsWith(bytes, "wOF2")) return { family: "font", mimeType: "font/woff2", format: "woff2" };
  if (startsWith(bytes, "wOFF")) return { family: "font", mimeType: "font/woff", format: "woff" };
  if (startsWith(bytes, "OTTO")) return { family: "font", mimeType: "font/otf", format: "otf" };
  if ((bytes.length >= 4 && bytes.readUInt32BE(0) === 0x00010000) || startsWith(bytes, "true")) return { family: "font", mimeType: "font/ttf", format: "ttf" };
  if (startsWith(bytes, "ttcf")) return { family: "collection" };
  if (looksLikeSvg(bytes)) return { family: "image", mimeType: "image/svg+xml" };
  return null;
}

/** The pixel size of a raster image, read from its header; nulls when the header says nothing. */
function rasterSize(bytes, mimeType) {
  try {
    if (mimeType === "image/png") return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    if (mimeType === "image/gif") return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    if (mimeType === "image/webp") {
      const chunk = bytes.subarray(12, 16).toString("latin1");
      if (chunk === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
      if (chunk === "VP8L") {
        const bits = bytes.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === "VP8X") return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    }
    if (mimeType === "image/jpeg") {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) { offset += 1; continue; }
        const marker = bytes[offset + 1];
        const length = bytes.readUInt16BE(offset + 2);
        // Start-of-frame markers carry the size; the others are skipped by their length.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
        }
        offset += 2 + length;
      }
    }
  } catch {
    // A truncated header: the size is simply not known.
  }
  return { width: null, height: null };
}

/** The drawn size of an SVG, from its viewBox or its width and height; nulls when it gives neither. */
function svgSize(text) {
  const tag = text.match(/<svg\b[^>]*>/i)?.[0] ?? "";
  const viewBox = tag.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (viewBox) return { width: Math.round(Number(viewBox[1])), height: Math.round(Number(viewBox[2])) };
  const width = Number(tag.match(/\bwidth\s*=\s*["']?([\d.]+)/i)?.[1]);
  const height = Number(tag.match(/\bheight\s*=\s*["']?([\d.]+)/i)?.[1]);
  return { width: Number.isFinite(width) ? Math.round(width) : null, height: Number.isFinite(height) ? Math.round(height) : null };
}

/** What form a mark is, from its shape: about square is a symbol, long is a wordmark. */
function variantOf(width, height) {
  if (!width || !height) return null;
  const ratio = width / height;
  if (ratio <= 1.4) return "symbol";
  return ratio > 3.2 ? "wordmark" : "lockup";
}

/** A weight's name at the end of a font's legacy family: "IBM Plex Sans Medium". */
const WEIGHT_SUFFIX = /\s(Thin|Hairline|Extra\s?Light|Ultra\s?Light|Light|Book|Medium|Semi\s?Bold|Demi\s?Bold|Extra\s?Bold|Ultra\s?Bold|Black|Heavy)$/i;

/** Reads a font's names and weight; refuses a file that is not one font. */
function readFont(bytes, format) {
  let font;
  try {
    font = fontkit.create(bytes);
  } catch {
    throw refuse("UPLOAD_UNREADABLE", "That font file could not be read.");
  }
  if (!font || Array.isArray(font.fonts)) throw refuse("UPLOAD_UNSUPPORTED", "That is a font collection. Upload each font as its own file.");
  const os2 = font["OS/2"] ?? null;
  const italic = (font.italicAngle ?? 0) !== 0 || Boolean(os2?.fsSelection?.italic);
  // The typographic family ("IBM Plex Sans") when the font names one; the legacy family a static
  // weight carries ("IBM Plex Sans Medium") only when it does not.
  const named = (key) => {
    try {
      return font.getName(key) || null;
    } catch {
      return null;
    }
  };
  // A file without a typographic family — a web subset often has none — names a static weight in
  // its legacy family: the weight word at its end is the style, not the family.
  const legacy = font.familyName ?? null;
  const weightWord = legacy?.match(WEIGHT_SUFFIX)?.[1] ?? null;
  return {
    family: named("preferredFamily") ?? (weightWord ? legacy.slice(0, -weightWord.length).trim() : legacy),
    subfamily: named("preferredSubfamily") ?? (weightWord && /^regular$/i.test(font.subfamilyName ?? "") ? weightWord : font.subfamilyName ?? null),
    fullName: font.fullName ?? null,
    postscriptName: font.postscriptName ?? null,
    weight: Number.isFinite(os2?.usWeightClass) ? os2.usWeightClass : null,
    style: italic ? "italic" : "normal",
    format,
  };
}

/** Reads a brand guide's pages and text; refuses a PDF that cannot be read or is too long. */
async function readGuide(bytes) {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch (error) {
    if (/password/i.test(String(error?.message))) throw refuse("UPLOAD_UNREADABLE", "That PDF is protected by a password. Upload a copy without one.");
    throw refuse("UPLOAD_UNREADABLE", "That PDF could not be read.");
  }
  try {
    if (pdf.numPages > BRAND_UPLOAD_LIMITS.guidePages) {
      throw refuse("UPLOAD_TOO_LONG", `That PDF has ${pdf.numPages} pages. A brand guide of up to ${BRAND_UPLOAD_LIMITS.guidePages} pages can be read.`);
    }
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const meta = await pdf.getMetadata().catch(() => null);
    const pages = (Array.isArray(text) ? text : [text]).map((page) => String(page ?? "").replace(/[ \t]+/g, " ").trim());
    return { pages: totalPages, title: meta?.info?.Title ?? null, text: pages };
  } finally {
    await pdf.destroy?.().catch(() => {});
  }
}

/** Reads a token file, counting what it defines; null when it is not one. */
function readTokens(text, fileName) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    let count = 0;
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (Object.hasOwn(node, "$value") || Object.hasOwn(node, "value")) {
        count += 1;
        return;
      }
      for (const child of Object.values(node)) walk(child);
    };
    walk(parsed);
    return count ? { format: "json", count, mimeType: "application/json" } : null;
  }
  const properties = trimmed.match(/--[\w-]+\s*:/g) ?? [];
  if (properties.length && (/\.css$/i.test(fileName ?? "") || /[{}]/.test(trimmed))) return { format: "css", count: properties.length, mimeType: "text/css" };
  return null;
}

/**
 * Recognises one uploaded file and reads what the brand needs from it.
 *
 * @param {object} input
 * @param {Buffer} input.bytes the file
 * @param {string} [input.fileName] what it was called on the person's machine
 * @param {string} [input.hint] where it was dropped: one of {@link UPLOAD_HINTS}
 * @returns {Promise<{kind: string, mimeType: string, bytes: Buffer, meta: object, upload: object, label: string}>}
 * @throws {AppError} `UPLOAD_EMPTY`, `UPLOAD_TOO_LARGE`, `UPLOAD_UNSUPPORTED`, `UPLOAD_UNREADABLE`, `UPLOAD_TOO_LONG`
 */
export async function readUpload({ bytes, fileName = null, hint = null }) {
  if (!bytes?.length) throw refuse("UPLOAD_EMPTY", "That file is empty.");
  if (bytes.length > BRAND_UPLOAD_LIMITS.fileBytes) {
    throw new AppError({ status: 413, code: "UPLOAD_TOO_LARGE", message: `A file may be up to ${Math.round(BRAND_UPLOAD_LIMITS.fileBytes / 1048576)} MB.` });
  }
  const name = typeof fileName === "string" ? fileName.trim().slice(0, 200) : null;
  const found = sniff(bytes);

  if (found?.family === "collection") throw refuse("UPLOAD_UNSUPPORTED", "That is a font collection. Upload each font as its own file.");

  if (found?.family === "image") {
    let stored = bytes;
    let size;
    if (found.mimeType === "image/svg+xml") {
      const clean = sanitiseSvg(bytes.toString("utf8"));
      stored = Buffer.from(clean, "utf8");
      size = svgSize(clean);
    } else {
      size = rasterSize(bytes, found.mimeType);
    }
    // Where it was dropped says what it is for; dropped anywhere else, a vector is almost always a
    // mark, and a raster is taken for an image until the chat has looked at it.
    const kind = hint === "logos" || (hint !== "images" && found.mimeType === "image/svg+xml") ? BRAND_ASSET_KINDS.logo : BRAND_ASSET_KINDS.illustration;
    return {
      kind,
      mimeType: found.mimeType,
      bytes: stored,
      meta: {
        width: size.width,
        height: size.height,
        label: name ? name.replace(/\.[a-z0-9]+$/i, "") : null,
        ...(kind === BRAND_ASSET_KINDS.logo ? { variant: variantOf(size.width, size.height) } : {}),
      },
      upload: { fileName: name },
      label: IMAGE_TYPES[found.mimeType],
    };
  }

  if (found?.family === "guide") {
    const document = await readGuide(bytes);
    return { kind: BRAND_ASSET_KINDS.guide, mimeType: found.mimeType, bytes, meta: { label: document.title ?? name }, upload: { fileName: name, document }, label: "PDF" };
  }

  if (found?.family === "font") {
    const font = readFont(bytes, found.format);
    return {
      kind: BRAND_ASSET_KINDS.font,
      mimeType: found.mimeType,
      bytes,
      meta: { label: font.fullName ?? font.family ?? name },
      upload: { fileName: name, font },
      label: found.format.toUpperCase(),
    };
  }

  // Text: design tokens as JSON or CSS. Anything else that is text is not a brand file.
  const text = bytes.toString("utf8");
  if (!text.includes("\u0000")) {
    const tokens = readTokens(text, name);
    if (tokens) {
      return { kind: BRAND_ASSET_KINDS.tokens, mimeType: tokens.mimeType, bytes, meta: { label: name }, upload: { fileName: name, tokens: { format: tokens.format, count: tokens.count } }, label: tokens.format.toUpperCase() };
    }
  }

  if (/\.(ai|eps|psd|sketch|fig)$/i.test(name ?? "")) {
    throw refuse("UPLOAD_UNSUPPORTED", "That file can't be read here. Export it as SVG or PDF and drop that instead.");
  }
  throw refuse("UPLOAD_UNSUPPORTED", `That kind of file can't be added to the brand. It takes: ${ACCEPTED}`);
}
