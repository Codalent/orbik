"use client";

import { useRef } from "react";
import { Download, FileText, Globe, Image as ImageIcon, Plus, Type } from "lucide-react";

import { useAskPanel } from "@/lib/ask/askPanel";
import { brandAssetUrl } from "@/lib/api/brand";
import { carriesFiles, useFileDrag } from "@/lib/brand/useFileDrag";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { fileFacts } from "@/components/ask/FileChip";
import { useBrand } from "./BrandContext";
import { SectionHeading } from "./PinField";

/** What a file input on this page accepts: the kinds the API stores. */
export const BRAND_FILE_TYPES =
  "image/png,image/jpeg,image/webp,image/gif,image/svg+xml,.svg,application/pdf,.pdf,.woff2,.woff,.otf,.ttf,application/json,.json,text/css,.css";

/** What each kind of upload is called. */
const KIND_NAMES = Object.freeze({ guide: "Brand guide", font: "Font", tokens: "Design tokens", logo: "Logo", illustration: "Illustration", photo: "Photograph", icon: "Icon" });

/**
 * Where the brand comes from: the website, and every file the person added, each with how many
 * values it set.
 *
 * It answers "why is this value what it is" for the whole page at once. The order of precedence
 * is said here too, because it is what a person needs to trust the page: what they say beats
 * their files, and their files beat the website.
 *
 * @param {object} props
 * @param {string|null} props.host the site's host
 * @param {object|null} props.observation the last reading of the site
 */
export function BrandSources({ host, observation }) {
  const { workspaceId, assets, pins, canEdit } = useBrand();
  const ask = useAskPanel();
  const picker = useRef(null);
  const uploads = assets.filter((asset) => asset.origin === "upload").sort((left, right) => String(right.uploadedAt).localeCompare(String(left.uploadedAt)));
  const setBy = (id) => pins.filter((pin) => pin.via?.kind === "upload" && pin.via.assetId === id).length;
  const fromChat = pins.filter((pin) => pin.via?.kind === "chat").length;
  const rendered = observation?.pages?.filter((page) => page.status !== "blocked").length ?? 0;

  return (
    <section aria-labelledby="brand-sources" className="space-y-4">
      <SectionHeading
        id="brand-sources"
        title="Where this comes from"
        description="What you say in the chat wins over your files, and your files win over the website. Re-reading the site never changes either."
      />
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <li className="flex items-center gap-3 rounded-xl border border-orb-line bg-orb-raised/40 px-3 py-2.5">
          <SourceIcon><Globe aria-hidden="true" className="size-4 text-orb-gray" /></SourceIcon>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-orb-white">{host ?? "Your website"}</p>
            <p className="text-xs text-orb-muted">
              {observation ? `Website · read ${formatDate(observation.createdAt)} from ${rendered} ${rendered === 1 ? "page" : "pages"}` : "Website · not read yet"}
            </p>
          </div>
        </li>
        {fromChat > 0 && (
          <li className="flex items-center gap-3 rounded-xl border border-orb-line bg-orb-raised/40 px-3 py-2.5">
            <SourceIcon><span className="text-xs font-semibold text-orb-lime">You</span></SourceIcon>
            <div className="min-w-0">
              <p className="text-sm font-medium text-orb-white">What you said</p>
              <p className="text-xs text-orb-muted">In the chat · {fromChat} {fromChat === 1 ? "value" : "values"}</p>
            </div>
          </li>
        )}
        {uploads.map((file) => {
          const count = setBy(file.id);
          return (
            <li key={file.id} className="flex items-center gap-3 rounded-xl border border-orb-line bg-orb-raised/40 px-3 py-2.5">
              <SourceIcon file={file} workspaceId={workspaceId} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-orb-white" title={file.fileName ?? undefined}>{file.fileName ?? KIND_NAMES[file.kind] ?? "File"}</p>
                <p className="truncate text-xs text-orb-muted">
                  {[KIND_NAMES[file.kind] ?? "File", fileFacts(file), count ? `${count} ${count === 1 ? "value" : "values"}` : null].filter(Boolean).join(" · ")}
                </p>
              </div>
              <a
                href={brandAssetUrl(workspaceId, file.id)}
                target="_blank"
                rel="noreferrer"
                aria-label={`Download ${file.fileName ?? "this file"}`}
                className="grid size-7 shrink-0 place-items-center rounded-md text-orb-muted hover:bg-orb-raised hover:text-orb-white"
              >
                <Download aria-hidden="true" className="size-3.5" />
              </a>
            </li>
          );
        })}
        {canEdit && ask && (
          <li>
            <button
              type="button"
              onClick={() => picker.current?.click()}
              className="flex h-full min-h-14 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-orb-line px-3 py-2.5 text-sm text-orb-muted outline-none transition-colors hover:border-orb-muted hover:text-orb-white focus-visible:ring-2 focus-visible:ring-ring/70"
            >
              <Plus aria-hidden="true" className="size-4" /> Add files — logos, a brand guide, fonts
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              accept={BRAND_FILE_TYPES}
              onChange={(event) => {
                ask.sendFiles(event.target.files, null);
                event.target.value = "";
              }}
            />
          </li>
        )}
      </ul>
    </section>
  );
}

/** The tile at the start of a source: a thumbnail for an image, a mark for anything else. */
function SourceIcon({ file = null, workspaceId = null, children = null }) {
  const image = file?.mimeType?.startsWith("image/");
  return (
    <span className={cn("grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg border border-orb-line", image ? "bg-white" : "bg-orb-space")}>
      {children ?? (image ? (
        // eslint-disable-next-line @next/next/no-img-element -- an asset streamed by the API with the session cookie
        <img src={brandAssetUrl(workspaceId, file.id)} alt="" className="max-h-7 max-w-7 object-contain" />
      ) : file?.kind === "font" ? (
        <Type aria-hidden="true" className="size-4 text-orb-gray" />
      ) : file?.kind === "guide" || file?.kind === "tokens" ? (
        <FileText aria-hidden="true" className="size-4 text-orb-gray" />
      ) : (
        <ImageIcon aria-hidden="true" className="size-4 text-orb-gray" />
      ))}
    </span>
  );
}

/**
 * A section of the Brand page that takes files while some are being dragged: a dashed outline
 * over it saying what dropping there means, and the drop handed to the chat with the section, so
 * "dropped on Logos" tells it the file is a logo.
 *
 * @param {object} props
 * @param {"logos"|"colours"|"type"|"images"} props.section
 * @param {string} props.label what dropping here does
 * @param {boolean} props.enabled whether the person may add files
 */
export function DropTarget({ section, label, enabled, children }) {
  const ask = useAskPanel();
  const dragging = useFileDrag(enabled && Boolean(ask));
  return (
    <div
      className={cn("relative", dragging && "min-h-28")}
      onDragOver={(event) => { if (dragging && carriesFiles(event)) event.preventDefault(); }}
      onDrop={(event) => {
        if (!dragging || !carriesFiles(event)) return;
        event.preventDefault();
        ask.sendFiles(event.dataTransfer.files, section);
      }}
    >
      {children}
      {dragging && (
        <div className="group pointer-events-none absolute -inset-2 z-10 grid place-items-center rounded-xl border-2 border-dashed border-orb-lime/50 bg-orb-black/70 text-sm font-medium text-orb-lime/80">
          {label}
        </div>
      )}
    </div>
  );
}
