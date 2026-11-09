"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Folder, FolderOpen, House, Lock, UserPen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  LIBRARY_LIMITS,
  joinPath,
  slugifySegment,
} from "@/lib/library/library";
import { cn } from "@/lib/utils";

/** A summary this long starts showing how much room is left. */
const SUMMARY_COUNTER_FROM = 320;

/**
 * Making a folder or a file: where it goes, what it is called, and what belongs in it.
 *
 * A dialog rather than a prompt, because the three answers depend on each other. Where it goes
 * decides the path and how deep it sits; what it is called decides the address; and the summary
 * is required, because it is what agents and search read before they open anything — a folder
 * nobody described is a folder an agent cannot file into on purpose. Every folder in the Library
 * is offered as the parent, nested ones included, so making something three levels down does not
 * mean first finding the folder in the tree.
 *
 * The path is shown as it will be, built by the same rules the server applies, and a path that is
 * already taken is refused here: saving a node creates *or replaces* it, so a clash caught only by
 * the server would be a file silently overwritten rather than an error.
 *
 * @param {object} props
 * @param {"folder"|"file"} props.kind
 * @param {string} props.parentPath the folder it starts in; "/" is the top level
 * @param {object|null} props.tree the Library's tree, as the page loaded it
 * @param {string} props.rootLabel what the top level is called: the workspace's name
 * @param {{overviewPath?: string|null, indexPath?: string|null}} [props.roles] where the overview and
 *   the index are, or will be: those paths are kept for them even before the agent writes them
 * @param {(path: string) => Promise<boolean>} props.exists asks the server whether a path is taken
 * @param {(request: {kind: string, path: string, title: string, summary: string, locked: boolean}) => Promise<void>} props.onCreate
 *   makes the node; throws with a message a person can read
 * @param {() => void} props.onClose
 */
export function LibraryCreateDialog({ kind, parentPath, tree, rootLabel, roles = {}, exists, onCreate, onClose }) {
  const isFolder = kind === "folder";
  const options = useMemo(() => parentOptions(tree, rootLabel), [tree, rootLabel]);
  const taken = useMemo(() => pathsIn(tree), [tree]);
  const [parent, setParent] = useState(() => (options.some((option) => option.path === parentPath) ? parentPath : "/"));
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [locked, setLocked] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState(null);
  const titleField = useRef(null);
  const selectedOption = useRef(null);

  // The chosen folder may be far down a long list; it is scrolled into view once, on opening, so
  // the dialog starts by showing where the new thing is going rather than the top of the list.
  useEffect(() => { selectedOption.current?.scrollIntoView({ block: "nearest" }); }, []);

  const chosen = options.find((option) => option.path === parent) ?? options[0];
  const segment = slugifySegment(title);
  const path = segment ? joinPath(parent, segment) : null;
  const level = chosen.depth + 1;
  const problem = pathProblem({ title, segment, path, level, taken, isFolder, roles });
  const missing = !title.trim()
    ? `Add a ${isFolder ? "name" : "title"} to continue.`
    : !summary.trim()
      ? "Add a summary to continue."
      : null;
  const ready = !problem && !missing && !pending;

  async function submit(event) {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setFailure(null);
    try {
      // The tree the page holds can be out of date, or elided in a large branch, so the server
      // has the last word on whether the path is free before anything is written to it.
      if (await exists(path)) {
        setFailure(`Something already exists at ${path}. Choose another ${isFolder ? "name" : "title"}.`);
        return;
      }
      await onCreate({ kind, path, title: title.trim(), summary: summary.trim(), locked: isFolder && locked });
    } catch (error) {
      setFailure(error?.message ?? "That could not be created.");
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
              {isFolder ? "New folder" : "New file"}
            </DialogTitle>
          </div>

          <div className="flex min-h-0 flex-col gap-4.5 overflow-y-auto px-6 pt-2.5 pb-5">
            <div role="group" aria-labelledby="library-create-where" className="flex flex-col gap-1.5">
              <span id="library-create-where" className={LABEL}>Put it in</span>
              <div
                role="radiogroup"
                aria-labelledby="library-create-where"
                className="flex max-h-52 flex-col gap-0.5 overflow-y-auto rounded-2xl bg-orb-line/50 p-1"
              >
                {options.map((option) => {
                  const selected = option.path === parent;
                  const Icon = option.path === "/" ? House : option.hasFolders ? FolderOpen : Folder;
                  return (
                    <label
                      key={option.path}
                      ref={selected ? selectedOption : undefined}
                      className={cn(
                        "flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-xl pr-2.5 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-[-2px] has-[:focus-visible]:outline-ring/60",
                        selected ? "bg-orb-line font-medium text-orb-white" : "text-orb-gray hover:bg-orb-line/60 hover:text-orb-white",
                      )}
                      style={{ paddingLeft: `${10 + 24 * Math.max(0, option.depth - 1)}px` }}
                    >
                      <input
                        type="radio"
                        name="library-create-parent"
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
                      {option.locked && <Lock aria-label="Locked: agents do not write here" className="size-3.5 shrink-0 text-orb-muted" />}
                      {selected && <Check aria-hidden="true" className="size-4 shrink-0 text-orb-white" />}
                    </label>
                  );
                })}
              </div>
              <span className="text-xs text-orb-muted">
                {parent === "/"
                  ? "At the top level"
                  : isFolder
                    ? `A subfolder of ${chosen.title}`
                    : chosen.trail.join(" › ")}
                {` · level ${level} of ${LIBRARY_LIMITS.depth}`}
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="library-create-title" className={LABEL}>{isFolder ? "Name" : "Title"}</label>
              <input
                ref={titleField}
                id="library-create-title"
                type="text"
                value={title}
                maxLength={LIBRARY_LIMITS.title}
                onChange={(event) => { setTitle(event.target.value); setFailure(null); }}
                aria-invalid={Boolean(problem) || undefined}
                aria-describedby="library-create-path"
                className={FIELD}
              />
              <span id="library-create-path" className="flex min-w-0 gap-1.5 text-xs">
                {problem ? (
                  <span role="alert" className="text-orb-coral">{problem}</span>
                ) : (
                  <>
                    <span className="shrink-0 text-orb-muted">Path</span>
                    <span className={cn("truncate font-mono", path ? "text-orb-gray" : "text-orb-muted")}>
                      {path ?? `${parent === "/" ? "" : parent}/…`}
                    </span>
                  </>
                )}
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="library-create-summary" className={LABEL}>
                {isFolder ? "What belongs here" : "What this file covers"}
              </label>
              <textarea
                id="library-create-summary"
                rows={2}
                value={summary}
                maxLength={LIBRARY_LIMITS.summary}
                required
                onChange={(event) => setSummary(event.target.value)}
                placeholder={isFolder ? undefined : "One or two sentences. Agents and search read it before the file itself."}
                aria-describedby="library-create-summary-hint"
                className={cn(FIELD, "h-auto resize-none rounded-2xl py-2.25 leading-5")}
              />
              <span id="library-create-summary-hint" className="flex justify-between gap-3 text-xs text-orb-muted">
                <span>
                  {isFolder
                    ? "Agents read this to decide what to file here."
                    : "Required. Agents and search read it before opening the file."}
                </span>
                {summary.length >= SUMMARY_COUNTER_FROM && (
                  <span className="shrink-0 tabular-nums">{summary.length} of {LIBRARY_LIMITS.summary}</span>
                )}
              </span>
            </div>

            {isFolder ? (
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={locked}
                  onChange={(event) => setLocked(event.target.checked)}
                  className="mt-0.5 size-4 shrink-0 accent-orb-lime"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-orb-white">Lock this folder</span>
                  <span className="text-xs text-orb-muted">Agents won’t write anything inside it. You can change this later.</span>
                </span>
              </label>
            ) : (
              <p className="flex gap-2.5 rounded-xl bg-orb-space px-3 py-2.5 text-compact leading-snug text-orb-gray">
                <UserPen aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                It opens in the editor. Everything you write in it is yours, and the agent writes around it.
              </p>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-orb-line py-3.5 pr-4 pl-6">
            <span
              role={failure ? "alert" : undefined}
              className={cn("min-w-0 flex-1 text-xs", failure ? "text-orb-coral" : "text-orb-muted")}
            >
              {failure ?? missing}
            </span>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={!ready}>
              {pending ? "Creating…" : isFolder ? "Create folder" : "Create and edit"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The small uppercase label every field in the dialog carries. */
export const LABEL = "text-2xs font-medium uppercase tracking-[0.12em] text-orb-muted";

/** A text field on the dialog's raised surface. */
export const FIELD = "h-9 rounded-3xl border border-transparent bg-orb-line/50 px-3 text-sm text-orb-white outline-none placeholder:text-orb-muted focus-visible:border-orb-lime focus-visible:ring-3 focus-visible:ring-orb-lime/30 aria-invalid:border-orb-coral/60";

/**
 * Why a path cannot be used, or null if it can.
 *
 * Checked as the person types, against the tree the page already holds, so a clash is said beside
 * the field rather than after pressing the button. The reserved paths count as taken even in a
 * Library that has not written them yet, since the agent will.
 */
function pathProblem({ title, segment, path, level, taken, isFolder, roles }) {
  if (!title.trim()) return null;
  if (!segment) return "Use at least one letter or digit, so the file has an address.";
  if (level > LIBRARY_LIMITS.depth) return `Paths go at most ${LIBRARY_LIMITS.depth} levels deep.`;
  const kept = path === roles.overviewPath ? "the Library's front page" : path === roles.indexPath ? "the Library's index" : null;
  if (kept && (isFolder || taken.has(path))) return `${path} is kept for ${kept}.`;
  if (taken.has(path)) return `Something already exists at ${path}. Choose another ${isFolder ? "name" : "title"}.`;
  return null;
}

/**
 * Every place something new can go: the top level, then each folder in tree order.
 *
 * A folder at the deepest level is left out, because nothing can be made inside it. Each carries
 * the titles above it, which is how a file's destination is said under the list.
 */
export function parentOptions(tree, rootLabel) {
  const options = [{ path: "/", title: rootLabel, depth: 0, locked: false, hasFolders: true, trail: [] }];
  const walk = (children, depth, trail) => {
    for (const node of children ?? []) {
      if (node.kind !== "folder" || depth >= LIBRARY_LIMITS.depth) continue;
      const title = node.title || node.name;
      const folders = (node.children ?? []).some((child) => child.kind === "folder");
      options.push({ path: node.path, title, depth, locked: node.locked, hasFolders: folders, trail: [...trail, title] });
      walk(node.children, depth + 1, [...trail, title]);
    }
  };
  walk(tree?.children, 1, []);
  return options;
}

/** Every path the tree holds, files and folders alike. */
export function pathsIn(tree) {
  const paths = new Set();
  const walk = (children) => {
    for (const node of children ?? []) {
      paths.add(node.path);
      walk(node.children);
    }
  };
  walk(tree?.children);
  return paths;
}
