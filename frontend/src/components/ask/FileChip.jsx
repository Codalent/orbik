"use client";

import { FileText, Loader2, Type, X } from "lucide-react";

import { brandAssetUrl } from "@/lib/api/brand";
import { cn } from "@/lib/utils";

/** What a file is, in a word, from what the API read from it. */
export function fileFacts(file) {
  if (file.kind === "guide") return file.pages ? `PDF · ${file.pages} ${file.pages === 1 ? "page" : "pages"}` : "PDF";
  if (file.kind === "font") return [file.font?.family, file.font?.weight].filter(Boolean).join(" · ") || "Font";
  if (file.kind === "tokens") return "Design tokens";
  if (file.mimeType === "image/svg+xml") return "SVG";
  if (file.width && file.height) return `${file.width}×${file.height}`;
  return file.kind === "logo" ? "Logo" : "Image";
}

/**
 * One file sent with a message to the brand chat: a thumbnail for an image, a mark for anything
 * else, its name and what it is. While it uploads it says so; a file the API refused says why.
 *
 * @param {object} props
 * @param {string} props.workspaceId
 * @param {object} props.file `{id?, fileName, kind?, mimeType?, uploading?, error?}`
 * @param {() => void} [props.onRemove] offered on the composer's chips, not on a sent message's
 */
export function FileChip({ workspaceId, file, onRemove }) {
  const image = file.id && file.mimeType?.startsWith("image/");
  return (
    <span
      className={cn(
        "inline-flex max-w-[15rem] items-center gap-2 rounded-lg border bg-orb-black/40 py-1 pl-1 pr-1.5 text-left",
        file.error ? "border-orb-coral/50" : "border-orb-line",
      )}
      title={file.error ?? file.fileName ?? undefined}
    >
      <span className={cn("grid size-8 shrink-0 place-items-center overflow-hidden rounded-md", image ? "bg-white" : "bg-orb-raised")}>
        {file.uploading ? (
          <Loader2 aria-hidden="true" className="size-3.5 animate-spin text-orb-muted" />
        ) : image ? (
          // eslint-disable-next-line @next/next/no-img-element -- an asset streamed by the API with the session cookie
          <img src={brandAssetUrl(workspaceId, file.id)} alt="" className="max-h-7 max-w-7 object-contain" />
        ) : file.kind === "font" ? (
          <Type aria-hidden="true" className="size-3.5 text-orb-gray" />
        ) : (
          <FileText aria-hidden="true" className="size-3.5 text-orb-gray" />
        )}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs text-orb-white">{file.fileName ?? "File"}</span>
        <span className={cn("block truncate text-2xs", file.error ? "text-orb-coral" : "text-orb-muted")}>
          {file.uploading ? "Uploading…" : file.error ?? fileFacts(file)}
        </span>
      </span>
      {onRemove && !file.uploading && (
        <button
          type="button"
          aria-label={`Remove ${file.fileName ?? "this file"}`}
          onClick={onRemove}
          className="grid size-5 shrink-0 place-items-center rounded text-orb-muted hover:bg-orb-raised hover:text-orb-white"
        >
          <X aria-hidden="true" className="size-3" />
        </button>
      )}
    </span>
  );
}
