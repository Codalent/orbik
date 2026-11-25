"use client";

import { useState } from "react";

import { workspaceIconUrl } from "@/lib/api/workspaces";
import { cn } from "@/lib/utils";

/**
 * A workspace's mark: its icon when it has one — the website's, as the crawler found it, or one a
 * person uploaded in Settings — and otherwise the first letter or digit of its name, as it always
 * was. A picture that fails to load falls back to the letter too.
 *
 * The picture sits on white, with a little room around it: a site's icon is drawn for a browser
 * tab, which is light, and many are a dark mark on nothing that would vanish on Orbik's dark
 * surfaces. Decoration only — the workspace's name is always written beside it.
 *
 * @param {object} props
 * @param {{id: string, name?: string, icon?: object}|null} props.workspace an item of
 *   `GET /v1/workspaces`, or anything with its `id`, `name` and `icon`
 * @param {"site"|"upload"|null} [props.origin] show this picture rather than the one the workspace
 *   is shown with: Settings shows both to choose between
 * @param {string} [props.className] the tile's size, shape and type size, for both forms
 * @param {string} [props.letterClassName] the letter's colours, when there is no picture
 */
export function WorkspaceIcon({ workspace, origin = null, className, letterClassName }) {
  const picture = origin ? workspace?.icon?.[origin] : workspace?.icon?.current;
  const src = picture?.version && workspace?.id ? workspaceIconUrl(workspace.id, picture.version, origin) : null;
  const [failed, setFailed] = useState(null);

  if (src && failed !== src) {
    return (
      <span aria-hidden="true" className={cn("flex shrink-0 items-center justify-center overflow-hidden bg-white ring-1 ring-black/10", className)}>
        {/* eslint-disable-next-line @next/next/no-img-element -- served by the API under the session; next/image cannot fetch it */}
        <img src={src} alt="" draggable={false} onError={() => setFailed(src)} className="size-full object-contain p-[12%]" />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={cn("flex shrink-0 items-center justify-center", className, letterClassName)}>
      {initialOf(workspace?.name)}
    </span>
  );
}

/** The first letter or digit of a name, for a workspace without a picture. */
function initialOf(name) {
  const match = String(name ?? "").match(/[\p{L}\p{N}]/u);
  return match ? match[0].toUpperCase() : "·";
}
