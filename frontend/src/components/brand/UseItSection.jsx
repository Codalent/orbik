"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { renderBrand } from "@/lib/api/brand";
import { saveTextFile } from "@/lib/download";
import { cn } from "@/lib/utils";
import { useBrand } from "./BrandContext";
import { CopyButton } from "./CopyButton";
import { SectionHeading } from "./PinField";

/** What each form is saved as, and what it is for, in a line. */
const FORMAT_NOTES = Object.freeze({
  dtcg: { file: "tokens.json", type: "application/json", note: "Design tokens in the Design Tokens Community Group format, for a token pipeline or a design tool's importer." },
  css: { file: "brand.css", type: "text/css", note: "CSS custom properties, with the components as classes over them. Paste it into a page to see the system applied." },
  tailwind: { file: "brand.tailwind.css", type: "text/css", note: "A Tailwind 4 @theme block, with the same theme as a Tailwind 3 config underneath." },
  "design-md": { file: "DESIGN.md", type: "text/markdown", note: "The whole system as one Markdown file: what to put in a coding agent's context, or in a repository's root." },
  "image-prompt": { file: "image-prompt.txt", type: "text/plain", note: "The style paragraph, what to avoid, the palette and the reference images: what to hand an image model." },
});

/**
 * The system, copied out: every form it is handed to another tool in.
 *
 * Each tab is read from the API when it is opened, never built in the browser, so what is copied
 * here is byte for byte what the same request over MCP returns — a person checking what their
 * agent will be told is looking at exactly that. The pins are already in it.
 *
 * @param {object} props
 * @param {Array<{id: string, label: string}>} props.formats the forms the API offers
 * @param {boolean} props.signedLinks whether an export can carry working links to its images
 * @param {string} props.revisionKey changes when the system does, so an open tab is read again
 */
export function UseItSection({ formats, signedLinks, revisionKey }) {
  const { workspaceId } = useBrand();
  const [format, setFormat] = useState(formats[0]?.id ?? "dtcg");
  const [state, setState] = useState({ key: null, text: null, error: null });
  const key = `${format}:${revisionKey}`;

  useEffect(() => {
    let cancelled = false;
    renderBrand(workspaceId, format)
      .then((text) => { if (!cancelled) setState({ key, text, error: null }); })
      .catch((failure) => { if (!cancelled) setState({ key, text: null, error: failure?.message ?? "That could not be read." }); });
    return () => { cancelled = true; };
  }, [format, key, workspaceId]);

  const current = state.key === key ? state : { text: null, error: null };
  const notes = FORMAT_NOTES[format];

  return (
    <section aria-labelledby="brand-use" className="space-y-4">
      <SectionHeading id="brand-use" title="Use it" description="Copy the system into whatever is going to make something with it. Your pinned values are already in every form." />

      <Panel className="overflow-hidden p-0 sm:p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-orb-line px-3 py-2.5 sm:px-4">
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Format">
            {formats.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={format === entry.id}
                onClick={() => setFormat(entry.id)}
                className={cn("rounded-full border px-2.5 py-0.5 text-xs transition-colors", format === entry.id ? "border-orb-lime text-orb-white" : "border-orb-line text-orb-gray hover:text-orb-white")}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <div className="flex gap-1.5">
            <CopyButton text={current.text} />
            <Button type="button" size="xs" variant="outline" disabled={!current.text} onClick={() => saveTextFile({ filename: notes?.file ?? `brand.${format}.txt`, text: current.text, type: `${notes?.type ?? "text/plain"};charset=utf-8` })}>
              <Download /> Download
            </Button>
          </div>
        </div>
        {notes && <p className="border-b border-orb-line/60 px-3 py-2 text-xs text-orb-gray sm:px-4">{notes.note}</p>}
        <div role="tabpanel" className="max-h-[28rem] overflow-auto bg-orb-space/60">
          {current.error && <p className="p-3 text-sm text-orb-coral sm:px-4">{current.error}</p>}
          {!current.text && !current.error && <p className="p-3 text-sm text-orb-muted sm:px-4">Loading…</p>}
          {current.text && <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-orb-gray sm:px-4">{current.text}</pre>}
        </div>
      </Panel>

      <p className="text-sm text-orb-gray">
        Your own Claude or ChatGPT can read all of this without copying anything: connect it under{" "}
        <Link href={`/workspaces/${workspaceId}/settings/ai`} className="text-orb-cyan underline decoration-orb-cyan/40 underline-offset-4 hover:decoration-orb-cyan">Orbik MCP</Link>{" "}
        in settings, and it has a <code className="rounded border border-orb-line bg-orb-space/70 px-1 font-mono text-xs text-orb-white">brand_get</code> tool that returns this system with its logo and reference images.
        {!signedLinks && " Image links are not configured on this deployment, so exports name the images without linking them."}
      </p>
    </section>
  );
}
