"use client";

import { useEffect, useRef, useState } from "react";

import { Pill } from "@/components/ui/pill";
import { brandAssetUrl } from "@/lib/api/brand";

/**
 * The page drawn inside the frame: the specimen, and a script that loads the font it is handed.
 *
 * It asks for nothing itself. The Brand page fetches the font's bytes with the person's session and
 * posts them in, and the frame loads them with the `FontFace` API under a name of its own — so the
 * company's font is used here and nowhere else, and nothing about the app's own type can change.
 */
const SPECIMEN = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#fff;color:#1f2937;font-family:system-ui,sans-serif}
  body{padding:18px 20px;opacity:0;transition:opacity .2s}
  body.ready{opacity:1}
  .aa{float:right;font-size:56px;line-height:1;color:var(--accent,#1f2937)}
  .h{font-size:30px;line-height:1.2;max-width:72%}
  .g{margin-top:12px;font-size:15px;letter-spacing:.02em;color:#4b5563;word-break:break-all}
  .s{margin-top:8px;font-size:15px;line-height:1.55;color:#374151;max-width:62ch}
  .x{font-family:system-ui,sans-serif;font-size:13px;color:#b42318}
</style></head><body>
  <div class="aa">Aa</div>
  <div class="h" id="h"></div>
  <div class="g">ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 &amp;@?!</div>
  <div class="s">The quick brown fox jumps over the lazy dog, and the specimen above is set in the file you uploaded.</div>
<script>
addEventListener("message", async (event) => {
  const { bytes, weight, style, sample, accent } = event.data || {};
  if (!bytes) return;
  document.getElementById("h").textContent = sample || "";
  if (accent) document.body.style.setProperty("--accent", accent);
  try {
    const face = new FontFace("BrandUpload", bytes, { weight: String(weight || 400), style: style || "normal" });
    await face.load();
    document.fonts.add(face);
    document.body.style.fontFamily = "BrandUpload, system-ui, sans-serif";
    document.body.style.fontWeight = String(weight || 400);
    document.body.style.fontStyle = style || "normal";
  } catch (error) {
    document.body.innerHTML = '<p class="x">This file could not be loaded as a font in the browser.</p>';
  }
  document.body.classList.add("ready");
});
</script></body></html>`;

/**
 * A type specimen drawn with a font file the person uploaded, in a sandboxed frame.
 *
 * The file is the company's and its licence is theirs, so it never leaves Orbik for anyone else:
 * it is read here with the session, by a signed-in member, and drawn in a frame that can run its
 * one script and nothing more — no access to the app, no navigation, no network of its own. Their
 * AI is told the family's name; it is never handed this file.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 * @param {object} props.font the uploaded font's asset summary: `id`, `fileName`, `font`
 * @param {string|null} [props.role] which typeface role it is set on, if any
 * @param {string|null} [props.accent] the brand's primary colour, for the large "Aa"
 */
export function FontSpecimen({ workspaceId, font, role = null, accent = null }) {
  const frame = useRef(null);
  const [failed, setFailed] = useState(null);
  const facts = font.font ?? {};

  useEffect(() => {
    let cancelled = false;
    const node = frame.current;
    if (!node) return undefined;
    async function load() {
      try {
        const response = await fetch(brandAssetUrl(workspaceId, font.id), { credentials: "include" });
        if (!response.ok) throw new Error("The font could not be read.");
        const bytes = await response.arrayBuffer();
        if (cancelled) return;
        const post = () => node.contentWindow?.postMessage({
          bytes,
          weight: facts.weight ?? 400,
          style: facts.style ?? "normal",
          sample: "We build what you need, properly.",
          accent,
        }, "*", [bytes]);
        // The frame may have loaded already, or not yet: post once it has.
        if (node.dataset.loaded === "1") post();
        else node.addEventListener("load", post, { once: true });
      } catch (error) {
        if (!cancelled) setFailed(error.message);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [workspaceId, font.id, facts.weight, facts.style, accent]);

  return (
    <figure className="overflow-hidden rounded-xl border border-orb-line">
      {failed ? (
        <p className="p-4 text-sm text-orb-coral">{failed}</p>
      ) : (
        <iframe
          ref={frame}
          title={`Specimen drawn with ${font.fileName ?? "your font file"}`}
          sandbox="allow-scripts"
          srcDoc={SPECIMEN}
          onLoad={(event) => { event.currentTarget.dataset.loaded = "1"; }}
          className="block h-48 w-full bg-white"
        />
      )}
      <figcaption className="flex flex-wrap items-center justify-between gap-2 border-t border-orb-line bg-orb-raised/40 px-3 py-2 text-xs text-orb-gray">
        <span className="min-w-[12rem]">
          <span className="text-orb-white">{[facts.family, facts.subfamily].filter(Boolean).join(" ") || font.fileName}</span>
          {" "}drawn with {font.fileName ?? "your file"}{role ? `, set as the ${role} typeface` : ", not set on a typeface role yet"}.
        </span>
        <Pill className="px-1.5" title="Shown to people in this workspace. Your AI is told the family's name, never given the file.">Private to this workspace</Pill>
      </figcaption>
    </figure>
  );
}
