"use client";

import { useMemo, useRef, useState } from "react";
import { Check, Folder, FolderOpen, House, Link2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { FIELD, LABEL, parentOptions, pathsIn } from "./LibraryCreateDialog";
import { LIBRARY_LIMITS, depthOf, joinPath, parentPathOf, slugifySegment } from "@/lib/library/library";
import { cn } from "@/lib/utils";

/**
 * Renaming or moving a folder or a file: what it is called, where it sits, and the address that
 * follows from both.
 *
 * A rename changes the path, because the path follows the name: `02 Offer` renamed `Offer` is
 * `/offer`. That is safe to offer because nothing breaks — every link in the Library that pointed
 * at the old path, or at anything inside it, is rewritten to the new one by the same request, and
 * the dialog says so. The address follows the name as it is typed while it was following it
 * already; a file whose address is a standard subject name under a title of its own (`buyers`,
 * titled "Buyers & ICP") keeps its address unless it is edited here on purpose.
 *
 * @param {object} props
 * @param {object} props.node the folder or file being renamed or moved
 * @param {object|null} props.tree the Library's tree, as the page loaded it
 * @param {string} props.rootLabel what the top level is called: the workspace's name
 * @param {(request: {to: string, title: string}) => Promise<void>} props.onMove renames or moves
 *   it; throws with a message a person can read
 * @param {() => void} props.onClose
 */
export function LibraryMoveDialog({ node, tree, rootLabel, onMove, onClose }) {
  const isFolder = node.kind === "folder";
  const originalTitle = node.title || node.name || "";
  const originalSegment = node.path.split("/").filter(Boolean).at(-1) ?? "";
  const options = useMemo(
    // Nowhere inside itself, and nowhere read-only.
    () => parentOptions(tree, rootLabel).filter((option) => option.path !== node.path && !option.path.startsWith(`${node.path}/`)),
    [tree, rootLabel, node.path],
  );
  const taken = useMemo(() => pathsIn(tree), [tree]);
  const [parent, setParent] = useState(() => parentPathOf(node.path));
  const [title, setTitle] = useState(originalTitle);
  // Whether the address is following the name: it is when it is what the name gives now.
  const [following, setFollowing] = useState(() => slugifySegment(originalTitle) === originalSegment);
  const [segment, setSegment] = useState(originalSegment);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState(null);
  const titleField = useRef(null);

  const address = following ? slugifySegment(title) : slugifySegment(segment);
  const path = address ? joinPath(parent, address) : null;
  const chosen = options.find((option) => option.path === parent) ?? options[0];
  const unchanged = path === node.path && title.trim() === originalTitle;
  const problem = !title.trim()
    ? `Give it a ${isFolder ? "name" : "title"}.`
    : !address
      ? "The address needs at least one letter or digit."
      : (chosen?.depth ?? 0) + 1 > LIBRARY_LIMITS.depth
        ? `Paths go at most ${LIBRARY_LIMITS.depth} levels deep.`
        : path !== node.path && taken.has(path)
          ? `Something already exists at ${path}.`
          : null;
  const ready = !problem && !unchanged && !pending;

  async function submit(event) {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setFailure(null);
    try {
      await onMove({ to: path, title: title.trim() });
    } catch (error) {
      setFailure(error?.message ?? "That could not be renamed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent initialFocus={titleField} className="max-w-130">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <div className="px-6 pt-4.5 pb-1.5 pr-14">
            <DialogTitle className="font-sans text-base leading-6 text-orb-white">
              Rename or move {isFolder ? "folder" : "file"}
            </DialogTitle>
          </div>

          <div className="flex min-h-0 flex-col gap-4.5 overflow-y-auto px-6 pt-2.5 pb-5">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="library-move-title" className={LABEL}>{isFolder ? "Name" : "Title"}</label>
              <input
                ref={titleField}
                id="library-move-title"
                type="text"
                value={title}
                maxLength={LIBRARY_LIMITS.title}
                onChange={(event) => { setTitle(event.target.value); setFailure(null); }}
                className={FIELD}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="library-move-address" className={LABEL}>Address</label>
              <input
                id="library-move-address"
                type="text"
                value={following ? slugifySegment(title) : segment}
                maxLength={LIBRARY_LIMITS.segment}
                onChange={(event) => { setFollowing(false); setSegment(event.target.value); setFailure(null); }}
                aria-invalid={Boolean(problem && !unchanged) || undefined}
                aria-describedby="library-move-path"
                className={cn(FIELD, "font-mono")}
              />
              <span id="library-move-path" className="flex min-w-0 gap-1.5 text-xs">
                {problem && !unchanged ? (
                  <span role="alert" className="text-orb-coral">{problem}</span>
                ) : (
                  <>
                    <span className="shrink-0 text-orb-muted">Path</span>
                    <span className="truncate font-mono text-orb-gray">{path ?? "…"}</span>
                  </>
                )}
              </span>
            </div>

            <div role="group" aria-labelledby="library-move-where" className="flex flex-col gap-1.5">
              <span id="library-move-where" className={LABEL}>Put it in</span>
              <div
                role="radiogroup"
                aria-labelledby="library-move-where"
                className="flex max-h-44 flex-col gap-0.5 overflow-y-auto rounded-2xl bg-orb-line/50 p-1"
              >
                {options.map((option) => {
                  const selected = option.path === parent;
                  const Icon = option.path === "/" ? House : option.hasFolders ? FolderOpen : Folder;
                  return (
                    <label
                      key={option.path}
                      className={cn(
                        "flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-xl pr-2.5 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-[-2px] has-[:focus-visible]:outline-ring/60",
                        selected ? "bg-orb-line font-medium text-orb-white" : "text-orb-gray hover:bg-orb-line/60 hover:text-orb-white",
                      )}
                      style={{ paddingLeft: `${10 + 24 * Math.max(0, option.depth - 1)}px` }}
                    >
                      <input
                        type="radio"
                        name="library-move-parent"
                        value={option.path}
                        checked={selected}
                        onChange={() => setParent(option.path)}
                        className="sr-only"
                      />
                      <Icon aria-hidden="true" className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        {option.title}
                        {option.path === "/" && <span className="font-normal text-orb-muted"> · top level</span>}
                      </span>
                      {selected && <Check aria-hidden="true" className="size-4 shrink-0 text-orb-white" />}
                    </label>
                  );
                })}
              </div>
              <span className="text-xs text-orb-muted">Level {depthOf(path ?? node.path)} of {LIBRARY_LIMITS.depth}</span>
            </div>

            <p className="flex gap-2.5 rounded-xl bg-orb-space px-3 py-2.5 text-compact leading-snug text-orb-gray">
              <Link2 aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {isFolder
                ? "Everything inside moves with it, with its history. Every link in the Library to this folder or anything in it is updated to the new path."
                : "Its history moves with it. Every link in the Library to this file is updated to the new path."}
            </p>
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-orb-line py-3.5 pr-4 pl-6">
            <span role={failure ? "alert" : undefined} className={cn("min-w-0 flex-1 text-xs", failure ? "text-orb-coral" : "text-orb-muted")}>
              {failure}
            </span>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={!ready}>{pending ? "Saving…" : "Save"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
