"use client";

import { useRef, useState } from "react";
import { Globe, ImageUp, Upload } from "lucide-react";
import { useSWRConfig } from "swr";

import { Button } from "@/components/ui/button";
import { WorkspaceIcon } from "@/components/workspaces/WorkspaceIcon";
import { WORKSPACES_PATH, chooseWorkspaceIcon, uploadWorkspaceIcon } from "@/lib/api/workspaces";
import { formatDate, hostOf } from "@/lib/format";
import { cn } from "@/lib/utils";

/** What the file picker offers: the pictures the API takes as an icon. */
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,.ico,.svg";

/** The largest icon the API keeps (`WORKSPACE_ICON_LIMITS` in `@orbik/assets`). */
const MAX_BYTES = 512 * 1024;

/**
 * What the workspace is shown with, and for admins and the owner the way to change it: the
 * website's icon, which the crawler reads at every crawl so it follows the site; a picture somebody
 * uploaded; or the first letter of the name. Each is a radio with its own picture beside it, and
 * picking one saves it. Uploading a picture also picks it.
 *
 * Everything shown is the workspace list's `icon`, and every change re-reads that list, so Home's
 * header and the switcher follow at once. The API decides what a file is and whether it fits; its
 * refusal is shown as it words it.
 *
 * @param {object} props
 * @param {object} props.workspace an item of `GET /v1/workspaces`
 * @param {boolean} props.canEdit whether the reader may change it (admin and up)
 */
export function WorkspaceIconSetting({ workspace, canEdit }) {
  const { mutate } = useSWRConfig();
  const picker = useRef(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState(null);
  const icon = workspace.icon ?? { choice: "site", current: null, site: null, upload: null };
  const siteHost = icon.site?.sourceUrl ? hostOf(icon.site.sourceUrl).replace(/^www\./, "") : null;

  async function apply(action, done) {
    setPending(true);
    setNotice(null);
    try {
      await action();
      await mutate(WORKSPACES_PATH);
      setNotice({ tone: "ok", text: done });
    } catch (problem) {
      setNotice({ tone: "error", text: problem?.message ?? "That did not save. Try again." });
    } finally {
      setPending(false);
    }
  }

  function upload(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    // Said here rather than after sending it: the API would refuse it with the same words.
    if (file.size > MAX_BYTES) {
      setNotice({ tone: "error", text: `${file.name} is ${Math.ceil(file.size / 1024)} KB; an icon can be up to ${MAX_BYTES / 1024} KB. A square picture of 256 pixels or so is plenty.` });
      return;
    }
    apply(() => uploadWorkspaceIcon(workspace.id, file), "Uploaded. The workspace is shown with it now.");
  }

  const options = [
    {
      value: "site",
      label: "Website's icon",
      detail: icon.site ? `From ${siteHost ?? "the website"}` : "Read at the next crawl",
      title: icon.site
        ? `${icon.site.sourceUrl ?? "From the website"}${icon.site.fetchedAt ? `, found ${formatDate(icon.site.fetchedAt, { time: false })}` : ""}. Read again at every crawl.`
        : "Each crawl reads the icon the website's home page names.",
      preview: icon.site ? <WorkspaceIcon workspace={workspace} origin="site" className="size-8 rounded-md" /> : <Placeholder icon={Globe} />,
    },
    {
      value: "upload",
      label: "Uploaded",
      detail: icon.upload ? icon.upload.fileName ?? "Your picture" : "Nothing uploaded yet",
      preview: icon.upload ? <WorkspaceIcon workspace={workspace} origin="upload" className="size-8 rounded-md" /> : <Placeholder icon={ImageUp} />,
      unavailable: !icon.upload,
    },
    {
      value: "none",
      label: "Letter",
      detail: "Its first letter",
      preview: (
        <WorkspaceIcon
          workspace={{ ...workspace, icon: null }}
          className="size-8 rounded-md font-display text-sm font-bold"
          letterClassName="bg-monogram text-monogram-foreground"
        />
      ),
    },
  ];

  return (
    <div data-testid="workspace-icon-setting">
      <fieldset disabled={!canEdit || pending} className="min-w-0">
        <legend className="sr-only">What the workspace is shown with</legend>
        <div className="flex flex-wrap gap-2">
          {options.map((option) => (
            <label
              key={option.value}
              title={option.title ?? option.detail}
              className={cn(
                "flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-orb-line bg-orb-space/40 px-2.5 py-2 transition-colors sm:w-44",
                "has-[:checked]:border-orb-lime/60 has-[:checked]:bg-orb-lime/5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/70",
                canEdit && !option.unavailable ? "cursor-pointer hover:border-orb-muted/60" : "cursor-default",
                option.unavailable && "opacity-60",
              )}
            >
              <input
                type="radio"
                name={`workspace-icon-${workspace.id}`}
                value={option.value}
                checked={icon.choice === option.value}
                disabled={option.unavailable}
                onChange={() => apply(() => chooseWorkspaceIcon(workspace.id, option.value), "Saved.")}
                className="sr-only"
                data-testid={`workspace-icon-choice-${option.value}`}
              />
              {option.preview}
              <span className="min-w-0">
                <span className="block truncate text-compact text-orb-white">{option.label}</span>
                <span className="block truncate text-2xs text-orb-muted">{option.detail}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {canEdit && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button type="button" variant="outline" size="sm" onClick={() => picker.current?.click()} disabled={pending} data-testid="workspace-icon-upload">
            <Upload aria-hidden="true" />
            {pending ? "Saving…" : icon.upload ? "Upload another…" : "Upload an icon…"}
          </Button>
          <p role={notice ? "status" : undefined} className={cn("min-w-[11rem] flex-1 text-xs", notice?.tone === "error" ? "text-orb-coral" : notice ? "text-orb-lime" : "text-orb-muted")}>
            {notice?.text ?? "PNG, SVG, WebP, JPEG, GIF or ICO, up to 512 KB. Square works best."}
          </p>
          <input ref={picker} type="file" accept={ACCEPT} onChange={upload} className="sr-only" tabIndex={-1} aria-hidden="true" />
        </div>
      )}
    </div>
  );
}

/** The empty frame where a picture would be. */
function Placeholder({ icon: Icon }) {
  return (
    <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-md border border-dashed border-orb-line text-orb-muted">
      <Icon className="size-4" />
    </span>
  );
}
